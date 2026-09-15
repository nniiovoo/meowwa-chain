import { describe, expect, it, vi } from 'vitest';
import { CHAINS, encodeBase58 } from '@meowwa/chain-domain';
import type { FundingChainKey } from '../funding/types.js';
import {
  TenantLedgerReconciliationSweep,
  TenantLedgerReconciliationWorker,
  type LedgerSweepRepository,
} from './ledger-reconciliation.js';

const walletA = `0x${'a'.repeat(40)}`;
const walletB = `0x${'b'.repeat(40)}`;
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const solanaWalletA = encodeBase58(new Uint8Array(32).fill(0x11));
const solanaWalletB = encodeBase58(new Uint8Array(32).fill(0x22));

function consistentReconciliation(tenantId: string, walletId: string, chainKey: FundingChainKey = 'base') {
  return {
    tenantId, walletId, chainKey,
    ledgerAtomic: '10000000', canonicalChainAtomic: '10000000',
    reorgedCreditAtomic: '0', reorgedDebitAtomic: '0',
    inFlightWithdrawalAtomic: '0', consistent: true,
  };
}

function repository(overrides: Partial<LedgerSweepRepository> = {}, wallets: [string, string] = [walletA, walletB]): LedgerSweepRepository {
  return {
    listActiveWalletAddressesPage: vi.fn(async (_chainKey: FundingChainKey, after: string | null) =>
      after === null ? [...wallets] : []),
    resolveWalletTenant: vi.fn(async (_chainKey: FundingChainKey, address: string) =>
      address === wallets[0] ? tenantA : tenantB),
    getWalletForWorker: vi.fn(async (tenantId: string) =>
      ({ walletId: tenantId === tenantA ? 'wallet_a' : 'wallet_b' })),
    reconcileWalletLedger: vi.fn(async (tenantId: string, walletId: string, chainKey: FundingChainKey) =>
      consistentReconciliation(tenantId, walletId, chainKey)),
    canonicalChainNetAtBlock: vi.fn(async () => '10000000'),
    getChainScanCursor: vi.fn(async () => ({ nextBlock: 2_001, walletSetRevision: 1, checkpoint: null })),
    recordLedgerDiscrepancy: vi.fn(async () => ({ recorded: true })),
    unresolvedChainHalt: vi.fn(async () => undefined),
    ...overrides,
  };
}

function chain(overrides: { latest?: bigint; balances?: Record<string, bigint> } = {}) {
  return {
    latestBlockNumber: vi.fn(async () => overrides.latest ?? 2_012n),
    balanceAtomicAt: vi.fn(async (address: string) =>
      overrides.balances?.[address.toLowerCase()] ?? 10_000_000n),
  };
}

function sweep(repo: LedgerSweepRepository, reader = chain()) {
  return new TenantLedgerReconciliationSweep({
    repository: repo, chain: CHAINS.base, reader, confirmations: 12, scanStartBlock: 0, pageSize: 500,
  });
}

describe('tenant ledger reconciliation sweep', () => {
  it('sweeps every wallet and records nothing when all sources agree', async () => {
    const repo = repository();
    const summary = await sweep(repo).sweepOnce();
    expect(summary).toMatchObject({ chainKey: 'base', walletsChecked: 2, internalMismatches: 0, onchainMismatches: 0 });
    // Confirmed head = 2012 − 12 = 2000; the cursor at 2001 has indexed past it, so the
    // independent comparison ran at that exact height for both wallets.
    expect(summary.comparisonBlockNumber).toBe(2_000);
    expect(repo.recordLedgerDiscrepancy).not.toHaveBeenCalled();
  });

  // Every repository read is keyed on the sweep's own rail: the cursor, the wallet set, tenant
  // resolution, the binding, both sums and the halt gate. A sweep that reads another rail's
  // cursor would compare Solana balances against Base coverage.
  it('keys every repository read and record on the rail it sweeps', async () => {
    const repo = repository({
      reconcileWalletLedger: vi.fn(async (tenantId: string, walletId: string) => ({
        ...consistentReconciliation(tenantId, walletId), ledgerAtomic: '9000000', consistent: false,
      })),
    });
    await sweep(repo).sweepOnce();
    expect(repo.getChainScanCursor).toHaveBeenCalledWith({
      chainKey: 'base', contractAddress: CHAINS.base.usdc.asset, scanStartBlock: 0,
    });
    expect(repo.unresolvedChainHalt).toHaveBeenCalledWith('base');
    expect(repo.listActiveWalletAddressesPage).toHaveBeenCalledWith('base', null, 500);
    expect(repo.resolveWalletTenant).toHaveBeenCalledWith('base', walletA);
    expect(repo.getWalletForWorker).toHaveBeenCalledWith(tenantA, 'base', walletA);
    expect(repo.reconcileWalletLedger).toHaveBeenCalledWith(tenantA, 'wallet_a', 'base');
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledWith(tenantA, 'wallet_a', 2_000, 'base');
    expect(repo.recordLedgerDiscrepancy).toHaveBeenCalledWith(expect.objectContaining({ chainKey: 'base', kind: 'internal_mismatch' }));
  });

  it('records a durable internal discrepancy with every compared sum', async () => {
    const repo = repository({
      reconcileWalletLedger: vi.fn(async (tenantId: string, walletId: string) => ({
        ...consistentReconciliation(tenantId, walletId),
        ledgerAtomic: '9000000', consistent: false,
      })),
    });
    const summary = await sweep(repo).sweepOnce();
    expect(summary.internalMismatches).toBe(2);
    expect(repo.recordLedgerDiscrepancy).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenantA, walletId: 'wallet_a', chainKey: 'base', kind: 'internal_mismatch',
      ledgerAtomic: '9000000', canonicalChainAtomic: '10000000',
      reorgedCreditAtomic: '0', reorgedDebitAtomic: '0',
    }));
  });

  it('records an on-chain discrepancy carrying the balance and block it was compared at', async () => {
    const repo = repository();
    const reader = chain({ balances: { [walletA.toLowerCase()]: 7_500_000n } });
    const summary = await sweep(repo, reader).sweepOnce();
    expect(summary.onchainMismatches).toBe(1);
    expect(repo.recordLedgerDiscrepancy).toHaveBeenCalledTimes(1);
    expect(repo.recordLedgerDiscrepancy).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenantA, walletId: 'wallet_a', chainKey: 'base', kind: 'onchain_mismatch',
      chainBalanceAtomic: '7500000', comparisonBlockNumber: 2_000,
    }));
    expect(reader.balanceAtomicAt).toHaveBeenCalledWith(walletA, 2_000n);
  });

  // Demanding the cursor be PAST the confirmed head skipped the comparison on a HEALTHY fleet:
  // the indexer only ever advances to the confirmed head as of its own last scan, and Base mints
  // a block every ~2s, so the gate was false on essentially every pass and the only truth source
  // outside this database never ran at all -- while readiness published "0 open discrepancies".
  it('compares at the height the indexer has finished rather than skipping on ordinary lag', async () => {
    const repo = repository({
      getChainScanCursor: vi.fn(async () => ({ nextBlock: 1_990, walletSetRevision: 1, checkpoint: null })),
    });
    const reader = chain();
    const summary = await sweep(repo, reader).sweepOnce();
    // Confirmed head is 2000; the cursor has finished 1989. Both sums are bounded to 1989, which
    // is exactly as exact as bounding both to 2000 would have been -- and it actually happens.
    expect(summary).toMatchObject({ walletsChecked: 2, onchainComparison: 'ran', comparisonBlockNumber: 1_989 });
    expect(reader.balanceAtomicAt).toHaveBeenCalledWith(walletA, 1_989n);
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledWith(tenantA, 'wallet_a', 1_989, 'base');
    expect(repo.recordLedgerDiscrepancy).not.toHaveBeenCalled();
  });

  // A comparison at a block the chain left behind hours ago is exact and still worth recording,
  // but it says nothing about the books as they stand now: a stalled cursor must not read as a
  // fleet verification just because it compared something.
  it('marks a comparison far behind the head as stale, and skips only when nothing is indexed', async () => {
    const stalled = repository({
      getChainScanCursor: vi.fn(async () => ({ nextBlock: 1_000, walletSetRevision: 1, checkpoint: null })),
    });
    const stalledReader = chain({ latest: 39_000_012n });
    const stale = await sweep(stalled, stalledReader).sweepOnce();
    expect(stale).toMatchObject({ walletsChecked: 2, onchainComparison: 'ran_stale', comparisonBlockNumber: 999 });
    expect(stalledReader.balanceAtomicAt).toHaveBeenCalledWith(walletA, 999n);

    // A cursor that has indexed nothing at all has no height to compare at.
    const empty = repository({
      getChainScanCursor: vi.fn(async () => ({ nextBlock: 0, walletSetRevision: 1, checkpoint: null })),
    });
    const emptyReader = chain();
    expect((await sweep(empty, emptyReader).sweepOnce()).onchainComparison).toBe('skipped_indexer_lag');
    expect(emptyReader.balanceAtomicAt).not.toHaveBeenCalled();
  });

  // A resolution that returns undefined rather than raising is neither an error nor a check. It
  // was the quietest way for the fleet check to die: 999 of 1000 wallets skipped by `continue`,
  // zero errors counted, and the pass still reported itself a clean verification.
  it('counts wallets it could not resolve instead of dropping them silently', async () => {
    const repo = repository({
      resolveWalletTenant: vi.fn(async (_chainKey: FundingChainKey, address: string) =>
        (address === walletA ? tenantA : undefined)),
    });
    expect(await sweep(repo).sweepOnce()).toMatchObject({
      walletsChecked: 1, walletsUnresolved: 1, walletErrors: 0,
    });

    // Same for a wallet that resolves to a tenant but has no binding this worker can read.
    const unbound = repository({ getWalletForWorker: vi.fn(async () => undefined) });
    expect(await sweep(unbound).sweepOnce()).toMatchObject({
      walletsChecked: 0, walletsUnresolved: 2, walletErrors: 0,
    });
  });

  it('paginates the fleet in strict address order', async () => {
    const pages: Array<string | null> = [];
    const repo = repository({
      listActiveWalletAddressesPage: vi.fn(async (chainKey: FundingChainKey, after: string | null, limit: number) => {
        pages.push(after);
        expect(chainKey).toBe('base');
        expect(limit).toBe(2);
        if (after === null) return [walletA, walletB];
        if (after === walletB) return [];
        throw new Error('unexpected page cursor');
      }),
    });
    const summary = await new TenantLedgerReconciliationSweep({
      repository: repo, chain: CHAINS.base, reader: chain(), confirmations: 12, scanStartBlock: 0, pageSize: 2,
    }).sweepOnce();
    expect(summary.walletsChecked).toBe(2);
    expect(pages).toEqual([null, walletB]);
  });

  it('skips the on-chain comparison during a reorg halt so halt artifacts are never recorded', async () => {
    // The flip invalidated indexed coverage below the cursor: comparing on-chain balances
    // against it would durably record discrepancies that are artifacts of the halt machinery.
    // The internal identity keeps running — its netted terms hold through a handled reorg.
    const repo = repository({
      unresolvedChainHalt: vi.fn(async () => ({ chainKey: 'base', checkpointBlockNumber: 1_950 })),
    });
    const reader = chain({ balances: { [walletA.toLowerCase()]: 0n, [walletB.toLowerCase()]: 0n } });
    const summary = await sweep(repo, reader).sweepOnce();
    expect(summary).toMatchObject({ walletsChecked: 2, onchainMismatches: 0, onchainComparison: 'skipped_reorg_halt' });
    expect(reader.balanceAtomicAt).not.toHaveBeenCalled();
    expect(repo.recordLedgerDiscrepancy).not.toHaveBeenCalled();

    // Unknown halt state is halt state here too -- whether the read rejects or throws outright.
    const unreadable = repository({
      unresolvedChainHalt: vi.fn(async () => { throw new Error('halt table unreadable'); }),
    });
    expect((await sweep(unreadable, chain()).sweepOnce()).onchainComparison).toBe('skipped_reorg_halt');
    const broken = repository({
      unresolvedChainHalt: vi.fn(() => { throw new Error('halt lookup refused'); }),
    });
    expect((await sweep(broken, chain()).sweepOnce()).onchainComparison).toBe('skipped_reorg_halt');
  });

  it('isolates one wallet failure instead of aborting the fleet', async () => {
    const repo = repository({
      reconcileWalletLedger: vi.fn(async (tenantId: string, walletId: string) => {
        if (walletId === 'wallet_a') throw new Error('transient RPC blip');
        return consistentReconciliation(tenantId, walletId);
      }),
    });
    const summary = await sweep(repo).sweepOnce();
    // Wallet B was still verified; the failure is counted, not fatal.
    expect(summary).toMatchObject({ walletsChecked: 2, walletErrors: 1, internalMismatches: 0 });
  });

  it('refuses a rail it cannot sweep or a reader of the wrong family at wiring time', () => {
    const repo = repository();
    // Control-plane networks have no funding cursor, wallet set or discrepancy rows to sweep.
    expect(() => new TenantLedgerReconciliationSweep({
      repository: repo, chain: CHAINS.base_sepolia, reader: chain(), confirmations: 12, scanStartBlock: 0,
    })).toThrow(/configuration/);
    // A Solana rail with a block-pinned reader (or the reverse) would fail every wallet on every pass.
    expect(() => new TenantLedgerReconciliationSweep({
      repository: repo, chain: CHAINS.solana, reader: chain(), confirmations: 1, scanStartBlock: 0,
    })).toThrow(/configuration/);
    expect(() => new TenantLedgerReconciliationSweep({
      repository: repo, chain: CHAINS.base, reader: solanaReader(), confirmations: 12, scanStartBlock: 0,
    })).toThrow(/configuration/);
    expect(new TenantLedgerReconciliationSweep({
      repository: repo, chain: CHAINS.solana, reader: solanaReader(), confirmations: 1, scanStartBlock: 0,
    }).chain).toBe(CHAINS.solana);
  });

  it('runs single-flight with bounded intervals and funnels sweep failures to onError', async () => {
    const repo = repository({
      listActiveWalletAddressesPage: vi.fn(async () => { throw new Error('database unreachable'); }),
    });
    const worker = new TenantLedgerReconciliationWorker(sweep(repo));
    expect(() => worker.start(999, () => undefined)).toThrow('interval');
    const failures: unknown[] = [];
    worker.start(60_000, (error) => { failures.push(error); });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    await worker.stop();
    expect((failures[0] as Error).message).toContain('database unreachable');
  });

  // The scheduled callback used to fire with no arguments, so a sweep in which every wallet check
  // threw was indistinguishable from one that verified the fleet -- and the readiness gate that
  // consumes it published "0 open discrepancies" for a check that had run on nothing.
  it('hands the completed summary, failures included, to the scheduled callback', async () => {
    const repo = repository({
      reconcileWalletLedger: vi.fn(async () => { throw new Error('permission denied for relation meowwa_wallet_ledger'); }),
    });
    const worker = new TenantLedgerReconciliationWorker(sweep(repo));
    const summaries: Array<{ walletsChecked: number; walletErrors: number }> = [];
    worker.start(60_000, () => undefined, (summary) => { summaries.push(summary); });
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    await worker.stop();
    expect(summaries[0]).toMatchObject({ walletsChecked: 2, walletErrors: 2 });
  });
});

function solanaReader(overrides: { latest?: bigint; balances?: Record<string, { amountAtomic: bigint; slot: number }> } = {}) {
  return {
    latestBlockNumber: vi.fn(async () => overrides.latest ?? 2_012n),
    balanceAtomicFinalized: vi.fn(async (owner: string) =>
      overrides.balances?.[owner] ?? { amountAtomic: 10_000_000n, slot: 2_012 }),
  };
}

function solanaRepository(overrides: Partial<LedgerSweepRepository> = {}): LedgerSweepRepository {
  return repository({
    reconcileWalletLedger: vi.fn(async (tenantId: string, walletId: string) =>
      consistentReconciliation(tenantId, walletId, 'solana')),
    ...overrides,
  }, [solanaWalletA, solanaWalletB]);
}

function solanaSweep(repo: LedgerSweepRepository, reader = solanaReader()) {
  return new TenantLedgerReconciliationSweep({
    repository: repo, chain: CHAINS.solana, reader, confirmations: 1, scanStartBlock: 0, pageSize: 500,
  });
}

describe('tenant ledger reconciliation sweep on Solana', () => {
  // Solana has no balance-at-slot read, and the cursor can never be ahead of finalized: a fresh
  // read is always a slot the indexer has not finished. So the sweep keeps the read as a sample
  // and compares it on the pass where the cursor has passed its slot -- exactly as exact, one
  // interval later. The pass that only sampled verified nothing and must say so.
  it('samples the finalized balance on one pass and compares it once the cursor has finished its slot', async () => {
    // Pass 1: the cursor has finished 2000; the finalized reads land at 2012. Nothing to compare yet.
    const repo = solanaRepository();
    const reader = solanaReader({ balances: { [solanaWalletA]: { amountAtomic: 7_500_000n, slot: 2_012 } } });
    const instance = solanaSweep(repo, reader);
    const first = await instance.sweepOnce();
    expect(first).toMatchObject({ chainKey: 'solana', walletsChecked: 2, onchainMismatches: 0, onchainComparison: 'skipped_indexer_lag' });
    expect(first.comparisonBlockNumber).toBeUndefined();
    expect(reader.balanceAtomicFinalized).toHaveBeenCalledTimes(2);
    expect(repo.canonicalChainNetAtBlock).not.toHaveBeenCalled();
    expect(repo.recordLedgerDiscrepancy).not.toHaveBeenCalled();
    expect(repo.getChainScanCursor).toHaveBeenCalledWith({ chainKey: 'solana', contractAddress: CHAINS.solana.usdc.asset, scanStartBlock: 0 });
    expect(repo.unresolvedChainHalt).toHaveBeenCalledWith('solana');
    expect(repo.listActiveWalletAddressesPage).toHaveBeenCalledWith('solana', null, 500);

    // Pass 2: the cursor has finished 2050, past both samples' slot 2012. Each wallet is compared
    // at its own sampled slot; wallet A disagrees; fresh samples are taken for the next pass.
    (repo.getChainScanCursor as ReturnType<typeof vi.fn>).mockResolvedValue({ nextBlock: 2_051, walletSetRevision: 1, checkpoint: null });
    reader.latestBlockNumber.mockResolvedValue(2_060n);
    const second = await instance.sweepOnce();
    expect(second).toMatchObject({ chainKey: 'solana', walletsChecked: 2, onchainMismatches: 1, onchainComparison: 'ran', comparisonBlockNumber: 2_012 });
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledWith(tenantA, 'wallet_a', 2_012, 'solana');
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledWith(tenantB, 'wallet_b', 2_012, 'solana');
    expect(repo.recordLedgerDiscrepancy).toHaveBeenCalledTimes(1);
    expect(repo.recordLedgerDiscrepancy).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenantA, walletId: 'wallet_a', chainKey: 'solana', kind: 'onchain_mismatch',
      canonicalChainAtomic: '10000000', chainBalanceAtomic: '7500000', comparisonBlockNumber: 2_012,
    }));
    expect(reader.balanceAtomicFinalized).toHaveBeenCalledTimes(4);
  });

  it('holds a sample the cursor has not reached instead of replacing it with an even later one', async () => {
    const repo = solanaRepository();
    const reader = solanaReader({ balances: {
      [solanaWalletA]: { amountAtomic: 10_000_000n, slot: 2_012 },
      [solanaWalletB]: { amountAtomic: 10_000_000n, slot: 2_030 },
    } });
    const instance = solanaSweep(repo, reader);
    await instance.sweepOnce();
    // The cursor has finished 2020: wallet A's sample (2012) is covered, wallet B's (2030) is not.
    (repo.getChainScanCursor as ReturnType<typeof vi.fn>).mockResolvedValue({ nextBlock: 2_021, walletSetRevision: 1, checkpoint: null });
    reader.latestBlockNumber.mockResolvedValue(2_040n);
    const second = await instance.sweepOnce();
    // One wallet was verified, one could not be: the pass did not verify the fleet.
    expect(second).toMatchObject({ walletsChecked: 2, onchainMismatches: 0, onchainComparison: 'skipped_indexer_lag', comparisonBlockNumber: 2_012 });
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledTimes(1);
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledWith(tenantA, 'wallet_a', 2_012, 'solana');
    // Wallet B was not re-read: its held sample is what the cursor will catch up to.
    expect(reader.balanceAtomicFinalized).toHaveBeenCalledTimes(3);
    expect(reader.balanceAtomicFinalized).toHaveBeenNthCalledWith(3, solanaWalletA);

    // Pass 3: the cursor has finished 2030, so wallet B's held sample is finally compared.
    (repo.getChainScanCursor as ReturnType<typeof vi.fn>).mockResolvedValue({ nextBlock: 2_031, walletSetRevision: 1, checkpoint: null });
    const third = await instance.sweepOnce();
    expect(third).toMatchObject({ walletsChecked: 2, onchainComparison: 'ran', comparisonBlockNumber: 2_012 });
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledWith(tenantB, 'wallet_b', 2_030, 'solana');
  });

  // A sample the cursor took ages to reach is still an exact comparison and still worth
  // recording, but it is about the books as they stood then, not now.
  it('marks a comparison whose slot is far behind the finalized head as stale', async () => {
    const repo = solanaRepository();
    const reader = solanaReader({ balances: {
      [solanaWalletA]: { amountAtomic: 10_000_000n, slot: 2_012 },
      [solanaWalletB]: { amountAtomic: 10_000_000n, slot: 2_012 },
    } });
    const instance = solanaSweep(repo, reader);
    await instance.sweepOnce();
    // 6000 slots is the allowance; the head has moved 6001 past the sample when the cursor arrives.
    (repo.getChainScanCursor as ReturnType<typeof vi.fn>).mockResolvedValue({ nextBlock: 2_013, walletSetRevision: 1, checkpoint: null });
    reader.latestBlockNumber.mockResolvedValue(8_013n);
    expect(await instance.sweepOnce()).toMatchObject({ onchainComparison: 'ran_stale', comparisonBlockNumber: 2_012 });
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledTimes(2);
  });

  it('reads nothing and forgets its samples while the rail is halted or has indexed nothing', async () => {
    const reader = solanaReader();
    const repo = solanaRepository({
      unresolvedChainHalt: vi.fn(async () => ({ chainKey: 'solana', checkpointBlockNumber: 1_950 })),
    });
    const instance = solanaSweep(repo, reader);
    expect(await instance.sweepOnce()).toMatchObject({ walletsChecked: 2, onchainComparison: 'skipped_reorg_halt' });
    expect(reader.balanceAtomicFinalized).not.toHaveBeenCalled();

    const nothingIndexed = solanaSweep(solanaRepository({
      getChainScanCursor: vi.fn(async () => ({ nextBlock: 0, walletSetRevision: 1, checkpoint: null })),
    }), reader);
    expect((await nothingIndexed.sweepOnce()).onchainComparison).toBe('skipped_indexer_lag');
    expect(reader.balanceAtomicFinalized).not.toHaveBeenCalled();

    // Samples taken before a halt are dropped with it: the pass after the halt starts over.
    const halting = solanaRepository();
    const sampled = solanaSweep(halting, reader);
    await sampled.sweepOnce();
    (halting.unresolvedChainHalt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ chainKey: 'solana', checkpointBlockNumber: 1 });
    await sampled.sweepOnce();
    (halting.getChainScanCursor as ReturnType<typeof vi.fn>).mockResolvedValue({ nextBlock: 3_000, walletSetRevision: 1, checkpoint: null });
    expect((await sampled.sweepOnce()).onchainComparison).toBe('skipped_indexer_lag');
    expect(halting.canonicalChainNetAtBlock).not.toHaveBeenCalled();
  });

  it('counts a wallet whose balance read fails as an error and re-samples it next pass', async () => {
    const repo = solanaRepository();
    const reader = solanaReader();
    reader.balanceAtomicFinalized.mockRejectedValueOnce(new Error('RPC unavailable'));
    const instance = solanaSweep(repo, reader);
    expect(await instance.sweepOnce()).toMatchObject({ walletsChecked: 2, walletErrors: 1, onchainComparison: 'skipped_indexer_lag' });
    (repo.getChainScanCursor as ReturnType<typeof vi.fn>).mockResolvedValue({ nextBlock: 2_051, walletSetRevision: 1, checkpoint: null });
    // Wallet B's sample is compared; wallet A has no sample yet and is sampled now.
    expect(await instance.sweepOnce()).toMatchObject({ walletsChecked: 2, walletErrors: 0, onchainComparison: 'skipped_indexer_lag' });
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledTimes(1);
    expect(repo.canonicalChainNetAtBlock).toHaveBeenCalledWith(tenantB, 'wallet_b', 2_012, 'solana');
  });
});
