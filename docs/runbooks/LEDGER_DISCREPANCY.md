# Ledger discrepancy — operator runbook

The financial worker runs one reconciliation sweep per enabled funding rail (`MEOWWA_FUNDING_CHAINS`:
Base always, Solana when configured). Each sweep walks every production wallet on its rail on an
interval (`MEOWWA_FINANCIAL_RECONCILE_MS`, default 5 minutes) and runs two independent checks:

- **internal_mismatch** — the ledger net no longer equals
  `canonical chain net + reorged credits − reorged debits`. Something was recorded that
  should not have been, or not recorded that should have been.
- **onchain_mismatch** — the wallet's actual USDC balance on its chain disagrees with the
  indexed canonical net, both bounded to the same height. The truth source here is outside
  the database entirely, and the comparison only ever happens at a height the scan cursor has
  already finished, so indexer lag can never produce it. How the height is chosen differs by
  family:
  - **Base** — the balance is read pinned to one block: the confirmed head or the last block
    the indexer finished, whichever is lower. Each pass compares at that block.
  - **Solana** — there is no balance-at-slot read; the RPC answers only the finalized state,
    stamped with the slot it is the state of, and the cursor can never be ahead of finalized.
    So a pass reads each wallet's finalized balance and keeps it as a sample, and the *next*
    pass compares that sample against the indexed net at its slot once the cursor has passed
    it. The comparison is exactly as exact (finalized state never changes); it lands one
    interval later. The very first pass after a worker start therefore reports
    `skipped_indexer_lag` on Solana — expected, not a fault. If Solana stays on
    `skipped_indexer_lag` for several passes, the Solana indexer is not keeping up with the
    finalized head (see FUNDING_OPERATIONS.md for `MEOWWA_FINANCIAL_SOLANA_MAX_SCAN_SLOTS`).

A mismatch writes one open row per wallet and kind to `meowwa_ledger_discrepancies` (the
row's `chain_key` names the rail; deduplicated until resolved), emits a
`financial.ledger-discrepancy` stderr event carrying `chain` and `kind`, and raises the
`reconciliation.openDiscrepancies` count in the worker's `/health/ready` body — monitoring
should alert on a non-zero count. Readiness itself stays 200: the worker keeps serving
webhooks and indexing while an operator investigates.

## Inspect

With the operator diagnostics credential (`MEOWWA_FINANCIAL_DIAGNOSTICS_TOKEN`):

```
GET /v1/reconciliation/discrepancies          — open records with every compared sum and chainKey
GET /v1/reconciliation/ledger?tenantId=&walletId=   — re-run one wallet's comparison now
```

Or directly, with migration credentials:

```sql
SELECT discrepancy_id, chain_key, tenant_id, wallet_id, kind, detected_at,
       ledger_atomic, canonical_chain_atomic, reorged_credit_atomic, reorged_debit_atomic,
       in_flight_withdrawal_atomic, chain_balance_atomic, comparison_block_number
FROM meowwa_ledger_discrepancies
WHERE resolved_at IS NULL
ORDER BY detected_at;
```

Each row carries every term of the comparison, so the disagreeing term is visible without
re-running anything. For an onchain_mismatch, verify the recorded `chain_balance_atomic`
against a second independent source before trusting it:

- **Base** (`chain_key = 'base'`) — an ERC-20 `balanceOf` of the wallet on the USDC contract
  at block `comparison_block_number`, from a second RPC provider (`eth_call` with an explicit
  block tag), or the wallet's token page on Basescan.
- **Solana** (`chain_key = 'solana'`) — `comparison_block_number` is the finalized *slot* the
  balance was read at. Solana RPC cannot re-read state at a past slot, so check the wallet's
  USDC token accounts on Solscan (the account page lists every token account the owner holds
  for the USDC mint; sum them — an owner can hold more than one) and walk the transfers between
  that slot and now, or replay the same finalized read against a second RPC provider and net
  out the transfers the explorer shows since the slot.

## Resolve

Resolution asserts the books are right again, so it is deliberately impossible for every
workload role — the worker holds only SELECT and INSERT. After correcting the underlying
cause (or verifying the record was itself wrong), connect with the migration credentials:

```sql
UPDATE meowwa_ledger_discrepancies
SET resolved_at = transaction_timestamp(),
    resolution_reference = '<incident/PR/evidence link>'
WHERE discrepancy_id = <id> AND resolved_at IS NULL;
```

Resolving re-arms detection for that wallet and kind: if the sweep still disagrees on its
next pass, a fresh open row appears — which is itself a signal the cause was not fixed.

## Relationship to reorg halts

A reorganization on an EVM rail flips that chain's events to `reorged` and halts indexing on
that rail (docs/runbooks/BASE_REORG.md). The reconciliation identity nets reorged credits and
debits explicitly, so a correctly handled reorg does **not** produce an internal_mismatch. If
one appears together with a reorg halt, resolve the halt first — the discrepancy sweep's
on-chain comparison stays paused on the halted rail anyway (`skipped_reorg_halt`), and only
on that rail: a Base halt never pauses the Solana comparison, or vice versa. Solana's reader
works at finalized commitment, which cannot be rolled back, so a Solana halt row would itself
be the anomaly to investigate.
