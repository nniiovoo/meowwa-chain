import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_USDC_CONTRACT } from '@meowwa/chain-domain';
import { createStore, syncPocUsdcHolding } from '../store/memory-store.js';
import { PetWalletReceiveError, PetWalletReceiveReconciler, type PetWalletReceiveResult } from './receive.js';
import { BaseSepoliaReceiveIndexer, BaseSepoliaReceiveReorgError, type BaseSepoliaReceiveTransfer, type ReceiveScanCursorRepository } from './receive-indexer.js';

const transactionHash = `0x${'a'.repeat(64)}` as `0x${string}`;
const transferBlockHash = `0x${'b'.repeat(64)}` as `0x${string}`;
const checkpointHash = `0x${'c'.repeat(64)}` as `0x${string}`;
const sender = '0x2222222222222222222222222222222222222222' as `0x${string}`;

function transfer(overrides: Partial<BaseSepoliaReceiveTransfer> = {}): BaseSepoliaReceiveTransfer {
  return {
    chainId: 84532, transactionHash, logIndex: 4, blockNumber: 100, blockHash: transferBlockHash,
    from: sender, to: '0x3333333333333333333333333333333333333333' as `0x${string}`, amountAtomic: '12500000', removed: false,
    ...overrides,
  };
}

function cursorRepository(start = 100n) {
  let cursor = { nextBlock: start, checkpoint: null as { blockNumber: bigint; blockHash: `0x${string}` } | null };
  const repository: ReceiveScanCursorRepository = {
    getReceiveScanCursor: vi.fn(() => cursor),
    advanceReceiveScanCursor: vi.fn((input) => {
      if (cursor.nextBlock !== input.expectedNextBlock) return false;
      cursor = { nextBlock: input.nextBlock, checkpoint: { blockNumber: input.checkpointBlock, blockHash: input.checkpointHash } };
      return true;
    }),
    rewindReceiveScanCursor: vi.fn((input) => {
      if (cursor.nextBlock !== input.expectedNextBlock) return false;
      cursor = { nextBlock: input.nextBlock, checkpoint: null };
      return true;
    }),
  };
  return { repository, read: () => cursor };
}

function result(store: ReturnType<typeof createStore>, duplicate = false): PetWalletReceiveResult {
  const wallet = store.wallets.get('pet_mochi')!;
  return {
    duplicate,
    wallet,
    transfer: {
      transferId: 'receive_1', petId: 'pet_mochi', walletId: wallet.walletId, chainId: 84532,
      contractAddress: BASE_SEPOLIA_USDC_CONTRACT, transactionHash, blockHash: transferBlockHash,
      blockNumber: 100, logIndex: 4, confirmedAtBlock: 112, from: sender, to: wallet.address,
      amountAtomic: '12500000', amountMinor: 1250, confirmedAt: '2026-07-16T00:00:00.000Z',
    },
  };
}

describe('Base Sepolia receive indexer', () => {
  it('scans confirmed inbound logs, reconciles them, and advances a durable cursor', async () => {
    const store = createStore();
    const cursors = cursorRepository();
    const reconcile = vi.fn(async () => result(store));
    const chain = {
      latestBlockNumber: vi.fn(async () => 112n),
      blockHash: vi.fn(async (block: bigint) => block === 100n ? transferBlockHash : checkpointHash),
      getUsdcTransfers: vi.fn(async () => [transfer()]),
    };
    const indexer = new BaseSepoliaReceiveIndexer({
      store, chain, reconciler: { reconcile }, cursor: cursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });

    await expect(indexer.scanOnce()).resolves.toMatchObject({ fromBlock: 100n, toBlock: 100n, processed: 1, nextBlock: 101n });
    expect(chain.getUsdcTransfers).toHaveBeenCalledWith({ fromBlock: 100n, toBlock: 100n, walletAddresses: [store.wallets.get('pet_mochi')!.address, store.wallets.get('pet_pepper')!.address] });
    expect(reconcile).toHaveBeenCalledWith({ petId: 'pet_mochi', transactionHash, sender, amountAtomic: '12500000', logIndex: 4 });
    expect(cursors.repository.advanceReceiveScanCursor).toHaveBeenCalledWith(expect.objectContaining({ expectedNextBlock: 100n, nextBlock: 101n, checkpointBlock: 100n, checkpointHash: transferBlockHash }));
    expect(cursors.read().nextBlock).toBe(101n);
  });

  it('advances duplicate transfers without crediting twice and does not scan before confirmations', async () => {
    const store = createStore();
    const cursors = cursorRepository(100n);
    const reconcile = vi.fn(async () => result(store, true));
    const chain = {
      latestBlockNumber: vi.fn(async () => 100n),
      blockHash: vi.fn(async () => checkpointHash),
      getUsdcTransfers: vi.fn(async () => []),
    };
    const indexer = new BaseSepoliaReceiveIndexer({ store, chain, reconciler: { reconcile }, cursor: cursors.repository, usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n });
    await expect(indexer.scanOnce()).resolves.toEqual({ processed: 0, nextBlock: 100n });
    expect(chain.getUsdcTransfers).not.toHaveBeenCalled();
  });

  it('reconciles two identical transfers in one transaction by their exact log indexes', async () => {
    const store = createStore();
    const wallet = store.wallets.get('pet_mochi')!;
    const initialBalance = wallet.balanceMinor;
    const to = wallet.address as `0x${string}`;
    const cursors = cursorRepository();
    const verifyTransfer = vi.fn(async (input: { logIndex?: number }) => {
      if (input.logIndex === undefined) throw new Error('duplicate matching logs are ambiguous');
      return {
        transactionHash, blockHash: transferBlockHash, blockNumber: 100,
        logIndex: input.logIndex, confirmedAtBlock: 112,
      };
    });
    const reconciler = new PetWalletReceiveReconciler(store, { verifyTransfer });
    const chain = {
      latestBlockNumber: vi.fn(async () => 112n),
      blockHash: vi.fn(async () => transferBlockHash),
      getUsdcTransfers: vi.fn(async () => [
        transfer({ to, logIndex: 4 }),
        transfer({ to, logIndex: 5 }),
      ]),
    };
    const indexer = new BaseSepoliaReceiveIndexer({
      store, chain, reconciler, cursor: cursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });

    await expect(indexer.scanOnce()).resolves.toMatchObject({ processed: 2, nextBlock: 101n });
    expect(verifyTransfer).toHaveBeenNthCalledWith(1, expect.objectContaining({ logIndex: 4 }));
    expect(verifyTransfer).toHaveBeenNthCalledWith(2, expect.objectContaining({ logIndex: 5 }));
    expect(wallet.receiveTransfers?.map(({ logIndex }) => logIndex)).toEqual([4, 5]);
    expect(wallet.balanceMinor).toBe(initialBalance + 2500);
  });

  it('skips an uncreditable sub-cent transfer, credits the rest of the window, and still advances', async () => {
    // A pet wallet address is published for funding, so anyone can send it 1 atomic unit of USDC.
    // That amount can never resolve to whole cents, so rethrowing it held the cursor on its block
    // and stopped inbound crediting for every pet permanently.
    const store = createStore();
    const mochi = store.wallets.get('pet_mochi')!;
    const pepper = store.wallets.get('pet_pepper')!;
    const pepperBalance = pepper.balanceMinor;
    const dustHash = `0x${'e'.repeat(64)}` as `0x${string}`;
    const cursors = cursorRepository();
    const reconciler = new PetWalletReceiveReconciler(store, {
      verifyTransfer: vi.fn(async (input: { transactionHash: `0x${string}`; logIndex?: number }) => ({
        transactionHash: input.transactionHash, blockHash: transferBlockHash,
        blockNumber: 100, logIndex: input.logIndex ?? 0, confirmedAtBlock: 112,
      })),
    });
    const chain = {
      latestBlockNumber: vi.fn(async () => 112n),
      blockHash: vi.fn(async () => transferBlockHash),
      getUsdcTransfers: vi.fn(async () => [
        transfer({ transactionHash: dustHash, to: mochi.address as `0x${string}`, amountAtomic: '1', logIndex: 1 }),
        transfer({ to: pepper.address as `0x${string}`, amountAtomic: '2500000', logIndex: 2 }),
      ]),
    };
    const indexer = new BaseSepoliaReceiveIndexer({
      store, chain, reconciler, cursor: cursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });

    await expect(indexer.scanOnce()).resolves.toMatchObject({ processed: 1, nextBlock: 101n });
    expect(cursors.read().nextBlock).toBe(101n);
    expect(pepper.balanceMinor).toBe(pepperBalance + 250);
    expect(mochi.receiveTransfers ?? []).toHaveLength(0);
    expect(store.audit).toContainEqual(expect.objectContaining({
      eventType: 'INBOUND_TRANSFER_SKIPPED',
      metadata: expect.objectContaining({ code: 'INVALID_RECEIVE_AMOUNT', amountAtomic: '1', petId: 'pet_mochi' }),
    }));

    // The skip is permanent because the cursor moved past it: the next poll makes progress instead
    // of re-fetching the same poisoned block.
    await expect(indexer.scanOnce()).resolves.toMatchObject({ processed: 0, nextBlock: 101n });
  });

  it('halts without advancing while chain evidence is still settling', async () => {
    const store = createStore();
    const cursors = cursorRepository();
    const reconcile = vi.fn(async () => { throw new PetWalletReceiveError('CHAIN_EVIDENCE_MISMATCH', 'evidence mismatch'); });
    const chain = { latestBlockNumber: vi.fn(async () => 112n), blockHash: vi.fn(async () => transferBlockHash), getUsdcTransfers: vi.fn(async () => [transfer()]) };
    const indexer = new BaseSepoliaReceiveIndexer({ store, chain, reconciler: { reconcile }, cursor: cursors.repository, usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n });
    await expect(indexer.scanOnce()).rejects.toThrow('evidence mismatch');
    expect(cursors.read().nextBlock).toBe(100n);
    expect(cursors.repository.advanceReceiveScanCursor).not.toHaveBeenCalled();
  });

  it('persists the reconciled application snapshot before advancing the receive cursor', async () => {
    const store = createStore();
    const cursors = cursorRepository();
    const reconcile = vi.fn(async () => result(store));
    const chain = {
      latestBlockNumber: vi.fn(async () => 112n),
      blockHash: vi.fn(async () => transferBlockHash),
      getUsdcTransfers: vi.fn(async () => [transfer()]),
    };
    const indexer = new BaseSepoliaReceiveIndexer({
      store, chain, reconciler: { reconcile }, cursor: cursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });
    const persist = vi.fn(async () => { throw new Error('snapshot save failed'); });

    await expect(indexer.scanOnce(persist)).rejects.toThrow('snapshot save failed');
    expect(cursors.read().nextBlock).toBe(100n);
    expect(cursors.repository.advanceReceiveScanCursor).not.toHaveBeenCalled();
  });

  function reorgFixture() {
    const store = createStore();
    const cursors = cursorRepository();
    cursors.read().checkpoint = { blockNumber: 99n, blockHash: `0x${'d'.repeat(64)}` };
    const chain = { latestBlockNumber: vi.fn(async () => 112n), blockHash: vi.fn(async () => checkpointHash), getUsdcTransfers: vi.fn(async () => []) };
    const indexer = new BaseSepoliaReceiveIndexer({ store, chain, reconciler: { reconcile: vi.fn() }, cursor: cursors.repository, usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n });
    return { store, cursors, chain, indexer };
  }

  it('halts without touching the cursor when a confirmed checkpoint leaves the canonical chain', async () => {
    const { store, cursors, chain, indexer } = reorgFixture();

    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(BaseSepoliaReceiveReorgError);
    expect(chain.getUsdcTransfers).not.toHaveBeenCalled();
    // A single checkpoint cannot locate the divergence, so the cursor must not move at all.
    expect(cursors.read()).toEqual({ nextBlock: 100n, checkpoint: { blockNumber: 99n, blockHash: `0x${'d'.repeat(64)}` } });
    expect(cursors.repository.rewindReceiveScanCursor).not.toHaveBeenCalled();
    expect(store.supportCases).toContainEqual(expect.objectContaining({ status: 'open', kind: 'receive_reorg_review' }));
    expect(store.notifications.map((item) => item.type)).toContain('RECEIVE_REORG_REVIEW');
  });

  it('preserves already-credited receives when a confirmed checkpoint leaves the canonical chain', async () => {
    const store = createStore();
    const wallet = store.wallets.get('pet_mochi')!;
    const initialBalance = wallet.balanceMinor;
    const cursors = cursorRepository();
    let canonicalHash: `0x${string}` = transferBlockHash;
    const reconciler = new PetWalletReceiveReconciler(store, {
      verifyTransfer: vi.fn(async () => ({
        transactionHash, blockHash: canonicalHash, blockNumber: 100, logIndex: 4, confirmedAtBlock: 112,
      })),
    });
    const chain = {
      latestBlockNumber: vi.fn(async () => 112n),
      blockHash: vi.fn(async () => canonicalHash),
      getUsdcTransfers: vi.fn(async () => [transfer({
        to: wallet.address as `0x${string}`, blockHash: canonicalHash,
      })]),
    };
    const indexer = new BaseSepoliaReceiveIndexer({
      store, chain, reconciler, cursor: cursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });

    await expect(indexer.scanOnce()).resolves.toMatchObject({ processed: 1, nextBlock: 101n });
    expect(wallet.balanceMinor).toBe(initialBalance + 1250);
    canonicalHash = `0x${'f'.repeat(64)}`;

    // Rewinding to scanStartBlock would reverse every receive ever indexed, and could not
    // reverse at all once these funds were spent. Halt with the ledger exactly as it was.
    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(BaseSepoliaReceiveReorgError);
    expect(wallet.balanceMinor).toBe(initialBalance + 1250);
    expect(wallet.receiveTransfers).toHaveLength(1);
    expect(cursors.read().nextBlock).toBe(101n);
    expect(store.supportCases).toContainEqual(expect.objectContaining({ status: 'open', kind: 'receive_reorg_review' }));

    // Repeated polls stay idempotent: one case, one notification, still no ledger change.
    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(BaseSepoliaReceiveReorgError);
    expect(store.supportCases.filter((item) => item.kind === 'receive_reorg_review')).toHaveLength(1);
    expect(store.notifications.filter((item) => item.type === 'RECEIVE_REORG_REVIEW')).toHaveLength(1);
    expect(wallet.balanceMinor).toBe(initialBalance + 1250);

    // Resolving the case must not restart the alerting. It used to: the dedupe skipped resolved
    // cases, so the next poll opened a second case and re-suspended every pet's autonomy, which
    // left the halt with no exit an operator could reach.
    for (const item of store.supportCases) if (item.kind === 'receive_reorg_review') item.status = 'resolved';

    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(BaseSepoliaReceiveReorgError);
    expect(store.supportCases.filter((item) => item.kind === 'receive_reorg_review')).toHaveLength(1);
    expect(store.notifications.filter((item) => item.type === 'RECEIVE_REORG_REVIEW')).toHaveLength(1);
  });

  it('re-suspends autonomy an owner restored while the halt is still in force', async () => {
    // The announcements are deduped, but suspension is not an announcement. The ledger still holds
    // credits the chain no longer backs, so an owner who calls autonomy/recover must not be able to
    // spend against them just because the case was already opened.
    const { indexer, store } = reorgFixture();

    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(BaseSepoliaReceiveReorgError);
    for (const autonomy of store.autonomy.values()) autonomy.mode = 'LIMITED_AUTONOMY';

    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(BaseSepoliaReceiveReorgError);
    expect([...store.autonomy.values()].map((item) => item.mode)).not.toContain('LIMITED_AUTONOMY');
    expect(store.supportCases.filter((item) => item.kind === 'receive_reorg_review')).toHaveLength(1);
  });

  it('leaves a settled refund untouched when its receive block leaves the canonical chain', async () => {
    const store = createStore();
    const wallet = store.wallets.get('pet_mochi')!;
    wallet.balanceMinor = 2950;
    syncPocUsdcHolding(wallet);
    const cursors = cursorRepository();
    let canonicalHash: `0x${string}` = transferBlockHash;
    const reconciler = new PetWalletReceiveReconciler(store, {
      verifyTransfer: vi.fn(async () => ({
        transactionHash, blockHash: canonicalHash, blockNumber: 100, logIndex: 4, confirmedAtBlock: 112,
      })),
    });
    const chain = {
      latestBlockNumber: vi.fn(async () => 112n),
      blockHash: vi.fn(async () => canonicalHash),
      getUsdcTransfers: vi.fn(async () => [transfer({ to: wallet.address as `0x${string}`, blockHash: canonicalHash })]),
    };
    const indexer = new BaseSepoliaReceiveIndexer({
      store, chain, reconciler, cursor: cursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });
    await indexer.scanOnce();
    const creditedBalance = wallet.balanceMinor;

    canonicalHash = `0x${'f'.repeat(64)}`;
    await expect(indexer.scanOnce()).rejects.toBeInstanceOf(BaseSepoliaReceiveReorgError);

    // No receipt, request, or mandate rewrite happens on the halt path at all.
    expect(wallet.balanceMinor).toBe(creditedBalance);
    expect(wallet.receiveTransfers).toHaveLength(1);
    expect(store.receipts.size).toBe(0);
  });

  it('fails closed when wallet attribution or transfer identity is ambiguous', async () => {
    const store = createStore();
    store.wallets.get('pet_pepper')!.address = store.wallets.get('pet_mochi')!.address;
    const cursors = cursorRepository();
    const indexer = new BaseSepoliaReceiveIndexer({
      store,
      chain: { latestBlockNumber: vi.fn(async () => 112n), blockHash: vi.fn(async () => checkpointHash), getUsdcTransfers: vi.fn(async () => []) },
      reconciler: { reconcile: vi.fn() }, cursor: cursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });
    await expect(indexer.scanOnce()).rejects.toThrow(/share a receive address/i);

    const isolatedStore = createStore();
    const receiveAddress = isolatedStore.wallets.get('pet_mochi')!.address as `0x${string}`;
    const conflicting = transfer({ to: receiveAddress });
    const conflictingCopy = transfer({ amountAtomic: '22500000', to: receiveAddress });
    const isolatedCursors = cursorRepository();
    const isolatedIndexer = new BaseSepoliaReceiveIndexer({
      store: isolatedStore,
      chain: { latestBlockNumber: vi.fn(async () => 112n), blockHash: vi.fn(async () => transferBlockHash), getUsdcTransfers: vi.fn(async () => [conflicting, conflictingCopy]) },
      reconciler: { reconcile: vi.fn() }, cursor: isolatedCursors.repository,
      usdcContract: BASE_SEPOLIA_USDC_CONTRACT, confirmations: 12, scanStartBlock: 100n,
    });
    await expect(isolatedIndexer.scanOnce()).rejects.toThrow(/identity conflicts/i);
    expect(isolatedCursors.read().nextBlock).toBe(100n);
  });
});
