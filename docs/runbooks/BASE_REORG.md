# Funding chain reorganization — operator runbook

A detected reorganization halts funding indexing and fail-closes the affected
window. This runbook is the only supported path back to normal operation.
Re-canonicalization is deliberately impossible for every workload role; it runs
through the migration authority because it raises balances.

The halt is per rail: `meowwa_chain_reorg_halts` records the `chain_key` it
happened on, and one rail's halt does not resolve another's. Every statement
below is written for `:chain` — bind `'base'` or `'solana'` from the halt row,
and never widen a statement to all rails to make it easier to run. Readiness
names the rail for you: `/health/ready` returns
`503 { status: 'reorg_halted', reorg: { chainKey, checkpointBlockNumber, checkpointBlockHash, ... } }`.

**Solana is finalized-only.** The indexer reads at `finalized` commitment, which
does not roll back, so a changed checkpoint on `solana` is almost never a
reorganization — it is an RPC provider serving a different or incomplete
history. Treat it as an identity problem with the provider first: the recovery
below is the same, but re-canonicalizing against a provider that was wrong is
how a false credit becomes permanent.

## What the system did on detection

1. The indexer's confirmed checkpoint no longer matched the chain, so `scanOnce`
   threw `TenantChainReorgDetectedError` carrying the divergent checkpoint and
   its `chainKey`.
2. The worker recorded one durable halt row in `meowwa_chain_reorg_halts`
   (deduplicated on the chain and checkpoint identity) and marked every canonical
   `meowwa_wallet_chain_events` row on that chain at or beyond the divergent block
   `canonical_status = 'reorged'` with `reorged_at` set.
3. Balances fail-closed immediately: the ledger balance and the withdrawal
   reservation both subtract reorged credits, so funds the chain no longer backs
   cannot be displayed as spendable, withdrawn against, or double-reserved.
   Reorged debits are deliberately not added back.
4. The worker latched the halt in-process the instant it was detected — before any
   database write — and `/health/ready` returns `503 { status: 'reorg_halted', ... }`
   until the process is restarted AND the durable halt is resolved. Readiness fails
   closed across every rail: an unresolved halt on one chain stops the worker, because
   the process is shared. If the durable halt record cannot be read, readiness reports
   `503 { status: 'reorg_status_unavailable' }` instead of assuming there is no
   halt. Monitoring should page on both signals.
5. Indexing does not advance. Each poll re-detects the same divergence and the
   deduplicated record does not multiply.

## Verify the divergence

```sql
SELECT chain_key, chain_id, checkpoint_block_number, checkpoint_block_hash, detected_at
FROM meowwa_chain_reorg_halts WHERE resolved_at IS NULL;
```

`chain_key` is the rail; `chain_id` is `8453` on Base and `NULL` on Solana, so
never filter a halt, event, cursor or checkpoint by `chain_id` — a `chain_id`
predicate silently matches no Solana row at all.

Confirm the recorded checkpoint against at least two independent RPC providers.
On Base, fetch the canonical hash for the recorded block with
`eth_getBlockByNumber`. On Solana the column names keep their EVM spelling but
mean the Solana thing: `checkpoint_block_number` is a slot and
`checkpoint_block_hash` is that slot's blockhash, so fetch it with
`getBlock(<slot>, { commitment: 'finalized' })` and compare `blockhash`. If the
providers disagree with each other, wait: the chain has not settled — or, on
Solana, one provider is serving history it should not — and no reconciliation is
safe.

## Assess the window

```sql
SELECT tenant_id, wallet_id, direction, amount_atomic::text, transaction_hash,
       block_number, reorged_at
FROM meowwa_wallet_chain_events
WHERE chain_key = :chain AND canonical_status = 'reorged'
ORDER BY block_number, log_index;
```

On Solana, `transaction_hash` is the base58 signature, `log_index` the
instruction ordinal and `block_number` the slot. **Never lowercase a base58
signature or address**: case is significant, and a case-folded value names a
different transaction.

For every reorged event, check the transaction on the settled canonical chain
against two providers — `eth_getTransactionReceipt` on Base,
`getTransaction(<signature>, { commitment: 'finalized' })` on Solana:

- **Receipt present, same block hash as the settled chain**: the event survived
  the reorganization and may be re-canonicalized.
- **Receipt present, different block**: the transaction was re-included. Update
  `block_number`/`block_hash` to the settled values in the same statement that
  re-canonicalizes it.
- **No receipt**: the transaction is gone. Leave the event reorged; its credit
  stays subtracted, which is the correct final state. The associated ledger
  entry remains as the audit trail of the correction.

## Re-canonicalize verified events (migration authority only)

Connect with the migration credentials (`MEOWWA_DATABASE_MIGRATION_URL`), never
a workload role. For each verified-surviving event:

```sql
UPDATE meowwa_wallet_chain_events
SET canonical_status = 'canonical', reorged_at = NULL,
    block_number = <settled_block_number>, block_hash = '<settled_block_hash>'
WHERE tenant_id = '<tenant>' AND chain_key = :chain
  AND transaction_hash = '<hash>' AND log_index = <index>
  AND canonical_status = 'reorged';
```

## Resolve the halt and resume

Only after every reorged event in the window is either re-canonicalized or
confirmed gone:

```sql
UPDATE meowwa_chain_reorg_halts
SET resolved_at = transaction_timestamp(),
    resolution_reference = '<incident/PR/evidence link>'
WHERE chain_key = :chain AND resolved_at IS NULL;

DELETE FROM meowwa_chain_scan_checkpoints WHERE chain_key = :chain;
```

Both statements are scoped to the halted rail on purpose. Dropping the other
rail's checkpoints discards evidence it is still relying on and forces it to
rebuild a window it never lost.

Deleting the checkpoint lets the indexer rebuild it from the settled chain on
its next scan. Restart the financial worker — the restart is what clears the
in-process latch, so it is required, not optional — and confirm `/health/ready`
returns 200 and the scan cursor for that rail advances:

```sql
SELECT chain_key, contract_address, next_block, updated_at
FROM meowwa_chain_scan_cursors WHERE chain_key = :chain;
```

## Aftercare

- Reconcile ledger balances for the affected wallets against on-chain balances
  (see the ledger reconciliation job).
- Record the incident, window size, and resolution evidence in the release
  record. If any owner-visible balance changed, notify those owners before
  unpausing any related capability.
