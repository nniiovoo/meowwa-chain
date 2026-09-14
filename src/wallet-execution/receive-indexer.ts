import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_CONTRACT } from '@meowwa/chain-domain';
import { isEvmAddress, isEvmTransactionHash, type EvmAddress } from '../funding/types.js';
import {
  appendAudit, appendNotification, nextId, suspendAutonomy, type AppStore,
} from '../store/memory-store.js';
import { PetWalletReceiveError, type PetWalletReceiveInput, type PetWalletReceiveReconciler } from './receive.js';
import type { BaseSepoliaReceiveChainReader, BaseSepoliaReceiveTransfer } from './receive-chain.js';

export type { BaseSepoliaReceiveTransfer } from './receive-chain.js';

export interface ReceiveScanCursor {
  nextBlock: bigint;
  checkpoint: { blockNumber: bigint; blockHash: `0x${string}` } | null;
}

export interface ReceiveScanCursorRepository {
  getReceiveScanCursor(chainId: typeof BASE_SEPOLIA_CHAIN_ID, contractAddress: string, defaultNextBlock: bigint): ReceiveScanCursor;
  advanceReceiveScanCursor(input: {
    chainId: typeof BASE_SEPOLIA_CHAIN_ID;
    contractAddress: string;
    expectedNextBlock: bigint;
    nextBlock: bigint;
    checkpointBlock: bigint;
    checkpointHash: string;
  }): boolean;
  rewindReceiveScanCursor(input: {
    chainId: typeof BASE_SEPOLIA_CHAIN_ID;
    contractAddress: string;
    expectedNextBlock: bigint;
    nextBlock: bigint;
  }): boolean;
}

export interface ReceiveIndexerResult {
  fromBlock?: bigint;
  toBlock?: bigint;
  processed: number;
  nextBlock: bigint;
}

export class BaseSepoliaReceiveReorgError extends Error {
  constructor(message = 'Base Sepolia receive scan checkpoint changed; manual reorg review is required') {
    super(message);
    this.name = 'BaseSepoliaReceiveReorgError';
  }
}

const MAX_SCAN_BLOCK_SPAN = 1_998n;

function safeBlock(value: bigint, name: string): void {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid ${name}`);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateTransfer(transfer: BaseSepoliaReceiveTransfer): void {
  if (transfer.chainId !== BASE_SEPOLIA_CHAIN_ID || transfer.removed ||
      !isEvmTransactionHash(transfer.transactionHash) || !isEvmTransactionHash(transfer.blockHash) ||
      !Number.isSafeInteger(transfer.blockNumber) || transfer.blockNumber < 0 ||
      !Number.isSafeInteger(transfer.logIndex) || transfer.logIndex < 0 ||
      !isEvmAddress(transfer.from) || !isEvmAddress(transfer.to) || !/^[1-9][0-9]*$/.test(transfer.amountAtomic)) {
    throw new Error('Base Sepolia receive transfer evidence is invalid');
  }
}

export class BaseSepoliaReceiveIndexer {
  readonly #store: AppStore;
  readonly #chain: BaseSepoliaReceiveChainReader;
  readonly #reconciler: Pick<PetWalletReceiveReconciler, 'reconcile'>;
  readonly #cursor: ReceiveScanCursorRepository;
  readonly #usdcContract: string;
  readonly #confirmations: number;
  readonly #scanStartBlock: bigint;

  constructor(input: {
    store: AppStore;
    chain: BaseSepoliaReceiveChainReader;
    reconciler: Pick<PetWalletReceiveReconciler, 'reconcile'>;
    cursor: ReceiveScanCursorRepository;
    usdcContract?: string;
    confirmations: number;
    scanStartBlock: bigint;
  }) {
    if ((input.usdcContract ?? BASE_SEPOLIA_USDC_CONTRACT).toLowerCase() !== BASE_SEPOLIA_USDC_CONTRACT.toLowerCase()) {
      throw new Error('Base Sepolia receive scanner requires canonical USDC');
    }
    if (!Number.isSafeInteger(input.confirmations) || input.confirmations < 1 || input.confirmations > 100) {
      throw new Error('Invalid Base Sepolia receive confirmation depth');
    }
    safeBlock(input.scanStartBlock, 'Base Sepolia receive scan start block');
    this.#store = input.store;
    this.#chain = input.chain;
    this.#reconciler = input.reconciler;
    this.#cursor = input.cursor;
    this.#usdcContract = input.usdcContract ?? BASE_SEPOLIA_USDC_CONTRACT;
    this.#confirmations = input.confirmations;
    this.#scanStartBlock = input.scanStartBlock;
  }

  async scanOnce(beforeAdvance?: () => void | Promise<void>): Promise<ReceiveIndexerResult> {
    const cursor = this.#cursor.getReceiveScanCursor(BASE_SEPOLIA_CHAIN_ID, this.#usdcContract, this.#scanStartBlock);
    safeBlock(cursor.nextBlock, 'stored receive cursor');
    if (cursor.nextBlock < this.#scanStartBlock) throw new Error('Stored receive cursor precedes configured scan start');
    if (cursor.checkpoint) {
      safeBlock(cursor.checkpoint.blockNumber, 'stored receive checkpoint');
      if (cursor.checkpoint.blockNumber >= cursor.nextBlock) throw new Error('Stored receive checkpoint is ahead of cursor');
      const currentHash = await this.#chain.blockHash(cursor.checkpoint.blockNumber);
      if (currentHash.toLowerCase() !== cursor.checkpoint.blockHash.toLowerCase()) {
        return this.#haltOnReorg(cursor);
      }
    }

    const wallets = [...this.#store.wallets.values()].filter((wallet) =>
      wallet.receiveEnabled !== false && (wallet.chainId ?? BASE_SEPOLIA_CHAIN_ID) === BASE_SEPOLIA_CHAIN_ID);
    const seenWalletAddresses = new Set<string>();
    const walletAddresses = wallets.map((wallet) => {
      if (!isEvmAddress(wallet.address)) throw new Error('Pet wallet has an invalid receive address');
      const normalized = wallet.address.toLowerCase();
      if (seenWalletAddresses.has(normalized)) throw new Error('Pet wallets cannot share a receive address');
      seenWalletAddresses.add(normalized);
      return wallet.address as EvmAddress;
    });
    if (walletAddresses.length === 0) return { processed: 0, nextBlock: cursor.nextBlock };

    const latestBlock = await this.#chain.latestBlockNumber();
    safeBlock(latestBlock, 'latest receive block');
    const depth = BigInt(this.#confirmations);
    if (latestBlock < depth) return { processed: 0, nextBlock: cursor.nextBlock };
    const confirmedHead = latestBlock - depth;
    if (cursor.nextBlock > confirmedHead) return { processed: 0, nextBlock: cursor.nextBlock };

    const toBlock = cursor.nextBlock + MAX_SCAN_BLOCK_SPAN < confirmedHead ? cursor.nextBlock + MAX_SCAN_BLOCK_SPAN : confirmedHead;
    const transfers = await this.#chain.getUsdcTransfers({ fromBlock: cursor.nextBlock, toBlock, walletAddresses });
    const walletsByAddress = new Map(wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
    const blockHashes = new Map<number, `0x${string}`>();
    const hashFor = async (blockNumber: number, expected: `0x${string}`): Promise<void> => {
      const cached = blockHashes.get(blockNumber);
      const current = cached ?? await this.#chain.blockHash(BigInt(blockNumber));
      blockHashes.set(blockNumber, current);
      if (current.toLowerCase() !== expected.toLowerCase()) throw new BaseSepoliaReceiveReorgError();
    };
    const seenTransfers = new Map<string, BaseSepoliaReceiveTransfer>();
    for (const transfer of transfers) {
      validateTransfer(transfer);
      const identity = `${transfer.transactionHash.toLowerCase()}:${transfer.logIndex}`;
      const priorTransfer = seenTransfers.get(identity);
      if (priorTransfer && JSON.stringify(priorTransfer) !== JSON.stringify(transfer)) {
        throw new Error('Base Sepolia receive transfer identity conflicts within one scan');
      }
      if (priorTransfer) continue;
      seenTransfers.set(identity, transfer);
      if (transfer.blockNumber < Number(cursor.nextBlock) || transfer.blockNumber > Number(toBlock)) {
        throw new Error('Base Sepolia receive transfer is outside the scanned range');
      }
      const wallet = walletsByAddress.get(transfer.to.toLowerCase());
      if (!wallet || !sameAddress(wallet.address, transfer.to)) throw new Error('Base Sepolia receive transfer recipient is not a configured wallet');
      await hashFor(transfer.blockNumber, transfer.blockHash);
    }
    const checkpointHash = await this.#chain.blockHash(toBlock);
    let processed = 0;
    for (const transfer of seenTransfers.values()) {
      const wallet = walletsByAddress.get(transfer.to.toLowerCase())!;
      const input: PetWalletReceiveInput = {
        petId: wallet.petId,
        transactionHash: transfer.transactionHash,
        sender: transfer.from,
        amountAtomic: transfer.amountAtomic,
        logIndex: transfer.logIndex,
      };
      try {
        const result = await this.#reconciler.reconcile(input);
        if (!result.duplicate) processed += 1;
      } catch (error) {
        // Split by permanence, because the cursor only advances once this loop completes. A pending
        // confirmation or mismatched evidence clears as the chain settles, so halting and retrying
        // the same window is right for those. An amount that is not a whole number of cents, or a
        // malformed log, is a fixed property of a transfer that has already been mined: retrying it
        // rejects identically forever, and the wallet address is published for funding, so one
        // 0.000001 USDC send by any third party stopped inbound crediting for every pet. Such a
        // transfer stays uncredited -- it genuinely cannot be, at cent granularity -- but it is
        // recorded for an operator and the scan moves past it.
        if (!(error instanceof PetWalletReceiveError) ||
          (error.code !== 'INVALID_RECEIVE_AMOUNT' && error.code !== 'INVALID_RECEIVE_INPUT')) throw error;
        appendAudit(this.#store, {
          eventType: 'INBOUND_TRANSFER_SKIPPED', aggregateId: wallet.walletId, actorType: 'provider',
          actorId: 'base_sepolia_receive_worker',
          summary: `Inbound Base Sepolia USDC transfer cannot be credited and was skipped: ${error.message}`,
          metadata: {
            petId: wallet.petId, code: error.code, amountAtomic: transfer.amountAtomic,
            transactionHash: transfer.transactionHash, blockNumber: transfer.blockNumber, logIndex: transfer.logIndex,
          },
        });
      }
    }
    await beforeAdvance?.();
    const advanced = this.#cursor.advanceReceiveScanCursor({
      chainId: BASE_SEPOLIA_CHAIN_ID, contractAddress: this.#usdcContract,
      expectedNextBlock: cursor.nextBlock, nextBlock: toBlock + 1n,
      checkpointBlock: toBlock, checkpointHash,
    });
    if (!advanced) throw new Error('Base Sepolia receive scan cursor was advanced concurrently');
    return { fromBlock: cursor.nextBlock, toBlock, processed, nextBlock: toBlock + 1n };
  }

  /**
   * A single stored checkpoint cannot locate where the chain actually diverged, so there is no
   * safe way to reverse only the orphaned receives: rewinding to the configured scan start
   * would reverse every receive ever indexed, and it cannot reverse at all once those funds
   * have been spent. Halt instead. The cursor and the ledger are left untouched, so nothing is
   * applied twice and an operator reconciles the window explicitly.
   */
  #haltOnReorg(cursor: ReceiveScanCursor): never {
    const checkpoint = cursor.checkpoint;
    const identity = checkpoint ? `${checkpoint.blockNumber}:${checkpoint.blockHash.toLowerCase()}` : 'unknown';
    // Deliberately not filtered by status. Skipping resolved cases meant an operator who closed
    // one got a fresh case, a fresh notification and every pet's autonomy suspended again on the
    // very next poll, so the halt had no exit at all. One divergence is one case.
    const existing = this.#store.supportCases.find((item) =>
      item.kind === 'receive_reorg_review' && item.summary.includes(identity));
    if (!existing) {
      const supportCase = {
        caseId: nextId(this.#store, 'case'),
        status: 'open',
        summary: `Base Sepolia receive indexing halted: confirmed checkpoint ${identity} is no longer canonical`,
        kind: 'receive_reorg_review' as const,
        origin: 'system' as const,
      };
      this.#store.supportCases.push(supportCase);
      appendAudit(this.#store, {
        eventType: 'RECEIVE_REORG_HALTED', aggregateId: supportCase.caseId, actorType: 'system',
        actorId: 'base_sepolia_receive_indexer',
        summary: 'Receive indexing halted because a confirmed checkpoint left the canonical chain',
        metadata: { checkpoint: identity },
      });
      appendNotification(this.#store, {
        type: 'RECEIVE_REORG_REVIEW',
        message: 'Incoming test-USDC crediting is paused while a chain reorganization is reviewed. No balances were changed.',
        dedupeKey: `receive-reorg:${identity}`,
      });
    }
    // Outside the dedupe on purpose. The case and the notification are announcements and belong
    // once per divergence, but suspension is a live safety property: the ledger still holds credits
    // the chain no longer backs. Suspending only on first detection let an owner call
    // autonomy/recover and spend against phantom funds while the halt was still in force.
    for (const wallet of this.#store.wallets.values()) {
      suspendAutonomy(this.#store, wallet.petId, 'receive chain reorganization requires review');
    }
    throw new BaseSepoliaReceiveReorgError();
  }
}
