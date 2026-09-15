import { describe, expect, it, vi } from 'vitest';
import type { BaseUsdcTransfer, CheckpointedBaseChainReader } from '../funding/base-chain.js';
import type { TenantFundingTransaction, TenantWalletBinding } from './financial-repository.js';
import {
  TenantBaseReorgDetectedError,
  TenantBaseUsdcIndexingWorker,
  TenantBaseUsdcIndexer,
  type TenantBaseUsdcIndexerRepository,
} from './base-usdc-indexer.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const walletAddress = `0x${'1'.repeat(40)}` as const;
const sender = `0x${'2'.repeat(40)}` as const;
const transactionHash = `0x${'3'.repeat(64)}` as const;
const blockHash = `0x${'4'.repeat(64)}` as const;

function wallet(overrides: Partial<TenantWalletBinding> = {}): TenantWalletBinding {
  return {
    tenantId, walletId: 'wallet_a', petId: 'pet_a', provider: 'privy',
    privyEmbeddedWalletId: 'privy_wallet_a', smartWalletAddress: walletAddress,
    ownerQuorumId: null,
    ownerPrivyUserId: 'did:privy:owner-fixture',
    revocationReason: null,
    agentSignerId: null, agentPolicyId: null, policyDigest: null, policyValidUntil: null, controlVerifiedAt: null,
    chainKey: 'base_sepolia', chainId: 84532, fundingChainKey: 'base', fundingChainId: 8453,
    status: 'active', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function awaitingFunding(overrides: Partial<TenantFundingTransaction> = {}): TenantFundingTransaction {
  return {
    tenantId, fundingId: 'funding_a', petId: 'pet_a', walletId: 'wallet_a', walletAddress,
    rail: 'stripe_onramp', status: 'pending', reconciliationStatus: 'awaiting_chain',
    sourceCurrency: 'usd', sourceAmountMinor: 2_500, destinationCurrency: 'usdc',
    destinationAmountAtomic: '25000000', chainKey: 'base', chainId: 8453, providerSessionId: 'cos_a',
    transactionHash, failureCode: null, createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:01:00.000Z', ...overrides,
  };
}

function transfer(overrides: Partial<BaseUsdcTransfer> = {}): BaseUsdcTransfer {
  return {
    chainId: 8453, transactionHash, logIndex: 7, blockNumber: 1_000, blockHash,
    from: sender, to: walletAddress, amountAtomic: '25000000', removed: false, ...overrides,
  };
}

function fixture(options: {
  checkpoint?: { blockNumber: number; blockHash: `0x${string}` } | null;
  transfers?: BaseUsdcTransfer[];
  awaiting?: TenantFundingTransaction;
  binding?: TenantWalletBinding;
} = {}) {
  const repository: TenantBaseUsdcIndexerRepository = {
    listActiveWalletAddressesPage: vi.fn(async (_chainKey, after) => after === null ? [walletAddress] : []),
    getChainScanCursor: vi.fn(async () => ({
      nextBlock: 900,
      walletSetRevision: 1,
      checkpoint: options.checkpoint === undefined ? null : options.checkpoint,
    })),
    advanceChainScanCursor: vi.fn(async () => true),
    resolveWalletTenant: vi.fn(async () => tenantId),
    getWalletForWorker: vi.fn(async () => options.binding ?? wallet()),
    findAwaitingFundingByTransactionHash: vi.fn(async () => options.awaiting),
    settleFunding: vi.fn(async () => ({ transaction: awaitingFunding({ status: 'settled', reconciliationStatus: 'confirmed' }), applied: true })),
    settleDirectDeposit: vi.fn(async () => ({ transaction: awaitingFunding({ rail: 'direct_usdc', status: 'settled', reconciliationStatus: 'confirmed' }), applied: true })),
    reconcileRecordedChainCredit: vi.fn(async () => ({
      transaction: awaitingFunding({ status: 'settled', reconciliationStatus: 'confirmed' }),
      matched: true,
      applied: true,
    })),
    recordWalletOutflow: vi.fn(async () => true),
  };
  const chain: CheckpointedBaseChainReader = {
    latestBlockNumber: vi.fn(async () => 1_012n),
    blockHash: vi.fn(async (blockNumber: bigint): Promise<`0x${string}`> =>
      blockNumber === 1_000n ? blockHash : `0x${'5'.repeat(64)}`),
    getUsdcTransfers: vi.fn(async () => options.transfers ?? [transfer()]),
  };
  return {
    repository,
    chain,
    indexer: new TenantBaseUsdcIndexer({
      repository, chain, usdcContract: usdc, confirmations: 12, scanStartBlock: 900,
      now: () => new Date('2026-07-15T00:02:00.000Z'),
    }),
  };
}

describe('TenantBaseUsdcIndexer', () => {
  it('settles a matching Stripe funding record only after confirmations and an independent block-hash check', async () => {
    const { indexer, repository, chain } = fixture({ awaiting: awaitingFunding() });
    await expect(indexer.scanOnce()).resolves.toEqual({
      fromBlock: 900, toBlock: 1_000, processed: 1, nextBlock: 1_001,
    });
    expect(chain.blockHash).toHaveBeenCalledWith(1_000n);
    expect(repository.settleFunding).toHaveBeenCalledWith({
      tenantId, fundingId: 'funding_a', walletId: 'wallet_a', chainKey: 'base', transactionHash,
      logIndex: 7, blockNumber: 1_000, blockHash, amountAtomic: '25000000',
      observedAt: '2026-07-15T00:02:00.000Z',
    });
    expect(repository.settleDirectDeposit).not.toHaveBeenCalled();
    expect(repository.advanceChainScanCursor).toHaveBeenCalledWith({
      chainKey: 'base', contractAddress: usdc, expectedNextBlock: 900,
      nextBlock: 1_001, checkpointBlock: 1_000, checkpointHash: blockHash,
      expectedWalletSetRevision: 1,
    });
  });

  it('settles a chain credit whose Stripe charge is already under chargeback review', async () => {
    // findAwaitingFundingByTransactionHash deliberately returns chargeback_review rows and
    // settleFunding preserves that flag. The indexer must not reject them: throwing here
    // aborts the scan and halts all Base indexing for the tenant.
    const { indexer, repository } = fixture({ awaiting: awaitingFunding({ reconciliationStatus: 'chargeback_review' }) });
    await expect(indexer.scanOnce()).resolves.toEqual({
      fromBlock: 900, toBlock: 1_000, processed: 1, nextBlock: 1_001,
    });
    expect(repository.settleFunding).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, fundingId: 'funding_a', walletId: 'wallet_a', transactionHash,
    }));
    expect(repository.settleDirectDeposit).not.toHaveBeenCalled();
  });

  it('records a confirmed transfer from another wallet as a direct USDC deposit', async () => {
    const { indexer, repository } = fixture();
    await indexer.scanOnce();
    expect(repository.settleDirectDeposit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, walletId: 'wallet_a', petId: 'pet_a', walletAddress,
      transactionHash, amountAtomic: '25000000',
    }));
    expect(repository.settleFunding).not.toHaveBeenCalled();
  });

  it('does not let a nonmatching sibling credit in the same transaction halt the scan', async () => {
    const sibling = transfer({ logIndex: 6, amountAtomic: '1000000' });
    const expected = transfer({ logIndex: 7, amountAtomic: '25000000' });
    const { indexer, repository } = fixture({
      transfers: [sibling, expected],
      awaiting: awaitingFunding(),
    });

    await expect(indexer.scanOnce()).resolves.toEqual({
      fromBlock: 900, toBlock: 1_000, processed: 2, nextBlock: 1_001,
    });
    expect(repository.settleDirectDeposit).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash, logIndex: 6, amountAtomic: '1000000',
    }));
    expect(repository.settleFunding).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash, logIndex: 7, amountAtomic: '25000000', fundingId: 'funding_a',
    }));
  });

  it('rechecks for delayed Stripe evidence after recording a direct credit', async () => {
    const { indexer, repository } = fixture();
    vi.mocked(repository.findAwaitingFundingByTransactionHash)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(awaitingFunding());
    await expect(indexer.scanOnce()).resolves.toMatchObject({ processed: 1 });
    expect(repository.reconcileRecordedChainCredit).toHaveBeenCalledWith({
      tenantId,
      fundingId: 'funding_a',
      walletId: 'wallet_a',
      chainKey: 'base',
      transactionHash,
      destinationAmountAtomic: '25000000',
    });
  });

  it('settles an inbound deposit and advances the cursor while its wallet policy is provisioning', async () => {
    const { indexer, repository } = fixture({ binding: wallet({ status: 'provisioning' }) });
    await expect(indexer.scanOnce()).resolves.toEqual({
      fromBlock: 900, toBlock: 1_000, processed: 1, nextBlock: 1_001,
    });
    expect(repository.settleDirectDeposit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, walletId: 'wallet_a', petId: 'pet_a', walletAddress, transactionHash,
    }));
    expect(repository.advanceChainScanCursor).toHaveBeenCalledWith(expect.objectContaining({
      expectedNextBlock: 900, nextBlock: 1_001,
    }));
    expect(repository.recordWalletOutflow).not.toHaveBeenCalled();
  });

  it('records a confirmed outgoing transfer as a ledger outflow and handles internal transfers on both wallets', async () => {
    const outgoing = transfer({ from: walletAddress, to: sender });
    const { indexer, repository } = fixture({ transfers: [outgoing] });
    await indexer.scanOnce();
    expect(repository.recordWalletOutflow).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, walletId: 'wallet_a', transactionHash, amountAtomic: '25000000',
    }));
    expect(repository.settleDirectDeposit).not.toHaveBeenCalled();
  });

  it('records a canonical outflow and advances the cursor while its wallet policy is provisioning', async () => {
    const outgoing = transfer({ from: walletAddress, to: sender });
    const { indexer, repository } = fixture({
      transfers: [outgoing], binding: wallet({ status: 'provisioning' }),
    });
    await expect(indexer.scanOnce()).resolves.toEqual({
      fromBlock: 900, toBlock: 1_000, processed: 1, nextBlock: 1_001,
    });
    expect(repository.recordWalletOutflow).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, walletId: 'wallet_a', transactionHash, amountAtomic: '25000000',
    }));
    expect(repository.advanceChainScanCursor).toHaveBeenCalledWith(expect.objectContaining({ nextBlock: 1_001 }));
  });

  it('halts before reading or writing transfers when the durable checkpoint no longer matches Base', async () => {
    const oldHash = `0x${'9'.repeat(64)}` as const;
    const { indexer, repository, chain } = fixture({ checkpoint: { blockNumber: 899, blockHash: oldHash } });
    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(TenantBaseReorgDetectedError);
    expect(chain.getUsdcTransfers).not.toHaveBeenCalled();
    expect(repository.settleFunding).not.toHaveBeenCalled();
    expect(repository.settleDirectDeposit).not.toHaveBeenCalled();
    expect(repository.advanceChainScanCursor).not.toHaveBeenCalled();
  });

  it('rejects a log whose block hash changed during the scan before any settlement is attempted', async () => {
    const changed = `0x${'8'.repeat(64)}` as const;
    const { indexer, repository, chain } = fixture();
    vi.mocked(chain.blockHash).mockResolvedValue(changed);
    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(TenantBaseReorgDetectedError);
    expect(repository.settleFunding).not.toHaveBeenCalled();
    expect(repository.settleDirectDeposit).not.toHaveBeenCalled();
    expect(repository.advanceChainScanCursor).not.toHaveBeenCalled();
  });

  it('leaves the cursor unchanged when any idempotent settlement operation fails', async () => {
    const { indexer, repository } = fixture();
    vi.mocked(repository.settleDirectDeposit).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(indexer.scanOnce()).rejects.toThrow('database unavailable');
    expect(repository.advanceChainScanCursor).not.toHaveBeenCalled();
  });

  // A wallet becoming funding-eligible mid-scan bumps meowwa_bump_wallet_set_revision, so the
  // compare-and-set refuses. Holding the cursor is CORRECT — the new wallet was not in the log
  // query for this window — but reporting it as a scan failure made /health/ready answer 503
  // with 'deposits are not being credited' for credits that had already committed.
  it('re-scans the window instead of failing when a wallet is provisioned mid-scan', async () => {
    const { indexer, repository } = fixture();
    vi.mocked(repository.advanceChainScanCursor).mockResolvedValueOnce(false);
    await expect(indexer.scanOnce()).resolves.toEqual({ processed: 1, nextBlock: 900 });
    expect(repository.settleDirectDeposit).toHaveBeenCalledOnce();
  });

  // Before the first wallet is funding-eligible the cursor used to stay pinned at
  // BASE_SCAN_START_BLOCK while readiness reported success, so the first funded wallet inherited
  // every block since deploy — hours of catch-up before its first deposit was credited.
  it('advances the cursor and checkpoints an empty window when no wallet is eligible yet', async () => {
    const { indexer, repository, chain } = fixture();
    vi.mocked(repository.listActiveWalletAddressesPage).mockResolvedValue([]);
    await expect(indexer.scanOnce()).resolves.toEqual({
      fromBlock: 900, toBlock: 1_000, processed: 0, nextBlock: 1_001,
    });
    expect(chain.getUsdcTransfers).not.toHaveBeenCalled();
    expect(repository.advanceChainScanCursor).toHaveBeenCalledWith({
      chainKey: 'base', contractAddress: usdc, expectedNextBlock: 900,
      nextBlock: 1_001, checkpointBlock: 1_000, checkpointHash: blockHash,
      expectedWalletSetRevision: 1,
    });
  });
});

describe('TenantBaseUsdcIndexingWorker', () => {
  it('never overlaps scans and waits for the active scan during shutdown', async () => {
    let complete!: () => void;
    const scanOnce = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const worker = new TenantBaseUsdcIndexingWorker({ scanOnce });
    const first = worker.runOnce();
    await expect(worker.runOnce()).resolves.toBeUndefined();
    const stopping = worker.stop();
    expect(scanOnce).toHaveBeenCalledOnce();
    complete();
    await first;
    await stopping;
  });

  // The mid-scan detection path leaves no durable footprint — the stored checkpoint predates
  // the divergent transfer — so the worker itself must be the memory. Without this latch the
  // next poll saw the new canonical logs, scanned clean, resumed crediting, and never
  // re-announced the divergence whose durable record may have just failed to persist.
  it('halts one-way after a detected reorg and re-announces the same divergence every poll', async () => {
    const halt = new TenantBaseReorgDetectedError({ blockNumber: 950, blockHash: `0x${'7'.repeat(64)}` });
    const scanOnce = vi.fn()
      .mockRejectedValueOnce(halt)
      .mockResolvedValue({ processed: 1 });
    const worker = new TenantBaseUsdcIndexingWorker({ scanOnce });

    await expect(worker.runOnce()).rejects.toBe(halt);
    // The next poll must NOT scan (crediting stays stopped) and must re-throw the identical
    // checkpoint so the caller's onError retries the durable record until it lands.
    await expect(worker.runOnce()).rejects.toBe(halt);
    await expect(worker.runOnce()).rejects.toBe(halt);
    expect(scanOnce).toHaveBeenCalledOnce();
    await worker.stop();
  });

  // The success signal readiness clears itself on. A skipped poll — runOnce resolving undefined
  // because the previous scan is still running, which is exactly the shape a hung scan takes —
  // is not a completed scan and must not report one.
  it('reports only completed scans, not polls skipped over an in-flight scan', async () => {
    vi.useFakeTimers();
    let complete!: (result: unknown) => void;
    const scanOnce = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const worker = new TenantBaseUsdcIndexingWorker({ scanOnce });
    const scans: number[] = [];
    worker.start(1_000, () => undefined, () => scans.push(1));
    // This poll lands while the first scan is still running, so runOnce resolves undefined without
    // scanning anything — the shape a hung scan takes every interval.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scanOnce).toHaveBeenCalledOnce();
    expect(scans).toEqual([]);
    complete({ processed: 0, nextBlock: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(scans).toEqual([1]);
    await worker.stop();
    vi.useRealTimers();
  });
});
