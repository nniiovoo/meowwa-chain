import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_CONTRACT, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN } from '@meowwa/chain-domain';
import { appendAudit, appendNotification, nextId, syncPocUsdcHolding, type AppStore, type PetWalletReceiveTransfer, type Wallet } from '../store/memory-store.js';
import { archivedDepositNotice } from '../modules/pet-archive.js';
import { ChainConfirmationPendingError, type BaseSepoliaExecutionReader } from './chain.js';

const HASH_PATTERN = EVM_HASH_PATTERN;
const ADDRESS_PATTERN = EVM_ADDRESS_PATTERN;
const AMOUNT_PATTERN = /^[1-9][0-9]*$/;
const USDC_ATOMIC_PER_MINOR = 10_000n;

export type PetWalletReceiveErrorCode =
  | 'INVALID_RECEIVE_INPUT'
  | 'PET_WALLET_NOT_FOUND'
  | 'RECEIVE_DISABLED'
  | 'INVALID_RECEIVE_AMOUNT'
  | 'RECEIVE_CHAIN_MISMATCH'
  | 'CHAIN_CONFIRMATION_PENDING'
  | 'CHAIN_EVIDENCE_MISMATCH'
  | 'RECEIVE_EVIDENCE_INVALID';

export class PetWalletReceiveError extends Error {
  readonly code: PetWalletReceiveErrorCode;
  readonly statusCode: number;

  constructor(code: PetWalletReceiveErrorCode, message: string, statusCode = 422) {
    super(message);
    this.name = 'PetWalletReceiveError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface PetWalletReceiveResult {
  duplicate: boolean;
  transfer: PetWalletReceiveTransfer;
  wallet: Wallet;
}

export interface PetWalletReceiveInput {
  petId: string;
  transactionHash: string;
  sender: string;
  amountAtomic: string;
  logIndex?: number;
}

function normalizedHash(value: string, name: string): `0x${string}` {
  if (!HASH_PATTERN.test(value)) throw new PetWalletReceiveError('INVALID_RECEIVE_INPUT', `${name} is invalid`, 400);
  return value.toLowerCase() as `0x${string}`;
}

function normalizedAddress(value: string, name: string): string {
  if (!ADDRESS_PATTERN.test(value)) throw new PetWalletReceiveError('INVALID_RECEIVE_INPUT', `${name} is invalid`, 400);
  return value.toLowerCase();
}

function amountMinorOf(value: string): number {
  if (!AMOUNT_PATTERN.test(value)) throw new PetWalletReceiveError('INVALID_RECEIVE_AMOUNT', 'USDC amount must be a positive integer atomic amount', 422);
  let atomic: bigint;
  try {
    atomic = BigInt(value);
  } catch {
    throw new PetWalletReceiveError('INVALID_RECEIVE_AMOUNT', 'USDC amount is invalid', 422);
  }
  if (atomic % USDC_ATOMIC_PER_MINOR !== 0n) {
    throw new PetWalletReceiveError('INVALID_RECEIVE_AMOUNT', 'USDC amount must resolve to whole cents for wallet accounting', 422);
  }
  const minor = atomic / USDC_ATOMIC_PER_MINOR;
  if (minor < 1n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PetWalletReceiveError('INVALID_RECEIVE_AMOUNT', 'USDC amount is outside the supported accounting range', 422);
  }
  return Number(minor);
}

function verifiedEvidence(input: PetWalletReceiveInput, evidence: Awaited<ReturnType<BaseSepoliaExecutionReader['verifyTransfer']>>): void {
  const transactionHash = normalizedHash(input.transactionHash, 'transaction hash');
  if (typeof evidence?.transactionHash !== 'string' || typeof evidence?.blockHash !== 'string' ||
      evidence.transactionHash.toLowerCase() !== transactionHash) {
    throw new PetWalletReceiveError('RECEIVE_EVIDENCE_INVALID', 'Verified transfer hash does not match the requested transaction', 422);
  }
  if (!HASH_PATTERN.test(evidence.blockHash) || !Number.isSafeInteger(evidence.blockNumber) || evidence.blockNumber < 0 ||
      !Number.isSafeInteger(evidence.logIndex) || evidence.logIndex < 0 || !Number.isSafeInteger(evidence.confirmedAtBlock) ||
      evidence.confirmedAtBlock < evidence.blockNumber) {
    throw new PetWalletReceiveError('RECEIVE_EVIDENCE_INVALID', 'Verified transfer evidence is malformed', 422);
  }
  if (input.logIndex !== undefined && evidence.logIndex !== input.logIndex) {
    throw new PetWalletReceiveError('RECEIVE_EVIDENCE_INVALID', 'Verified transfer log does not match the requested log index', 422);
  }
}

export class PetWalletReceiveReconciler {
  readonly #store: AppStore;
  readonly #chain: BaseSepoliaExecutionReader;
  readonly #confirmations: number;
  readonly #now: () => Date;
  readonly #inFlight = new Map<string, Promise<PetWalletReceiveResult>>();

  constructor(store: AppStore, chain: BaseSepoliaExecutionReader, options: { confirmations?: number; now?: () => Date } = {}) {
    this.#store = store;
    this.#chain = chain;
    this.#confirmations = options.confirmations ?? 12;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#confirmations) || this.#confirmations < 1 || this.#confirmations > 100) {
      throw new Error('Invalid Base Sepolia receive confirmation depth');
    }
  }

  async reconcile(input: PetWalletReceiveInput): Promise<PetWalletReceiveResult> {
    const key = typeof input.transactionHash === 'string'
      ? `${input.transactionHash.toLowerCase()}:${input.logIndex ?? 'unspecified'}`
      : '';
    const prior = this.#inFlight.get(key);
    if (prior) await prior.catch(() => undefined);
    const operation = this.#reconcile(input);
    this.#inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key);
    }
  }

  async #reconcile(input: PetWalletReceiveInput): Promise<PetWalletReceiveResult> {
    if (!input || typeof input.petId !== 'string' || input.petId.trim() === '' ||
        typeof input.transactionHash !== 'string' || typeof input.sender !== 'string' || typeof input.amountAtomic !== 'string' ||
        (input.logIndex !== undefined && (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0))) {
      throw new PetWalletReceiveError('INVALID_RECEIVE_INPUT', 'Pet receive input is invalid', 400);
    }
    const transactionHash = normalizedHash(input.transactionHash, 'transaction hash');
    const sender = normalizedAddress(input.sender, 'sender');
    const amountMinor = amountMinorOf(input.amountAtomic);
    const wallet = this.#store.wallets.get(input.petId);
    const pet = this.#store.pets.find((candidate) => candidate.petId === input.petId);
    if (!wallet || !pet || wallet.petId !== pet.petId) {
      throw new PetWalletReceiveError('PET_WALLET_NOT_FOUND', 'Pet wallet was not found', 404);
    }
    if (wallet.receiveEnabled === false) {
      throw new PetWalletReceiveError('RECEIVE_DISABLED', 'Pet wallet receiving is disabled', 409);
    }
    if ((wallet.chainId ?? BASE_SEPOLIA_CHAIN_ID) !== BASE_SEPOLIA_CHAIN_ID) {
      throw new PetWalletReceiveError('RECEIVE_CHAIN_MISMATCH', 'Pet wallet is not configured for Base Sepolia', 409);
    }
    if (wallet.balanceMinor > Number.MAX_SAFE_INTEGER - amountMinor) {
      throw new PetWalletReceiveError('INVALID_RECEIVE_AMOUNT', 'Pet wallet balance would exceed the supported accounting range', 422);
    }
    const recipient = normalizedAddress(wallet.address, 'wallet address');
    const existing = wallet.receiveTransfers?.find((transfer) =>
      transfer.transactionHash.toLowerCase() === transactionHash && transfer.from.toLowerCase() === sender &&
      transfer.to.toLowerCase() === recipient && transfer.amountAtomic === input.amountAtomic &&
      (input.logIndex === undefined || transfer.logIndex === input.logIndex));
    if (existing) return { duplicate: true, transfer: existing, wallet };

    let evidence: Awaited<ReturnType<BaseSepoliaExecutionReader['verifyTransfer']>>;
    try {
      evidence = await this.#chain.verifyTransfer({
        transactionHash, sender, recipient, amountAtomic: input.amountAtomic, confirmations: this.#confirmations,
        ...(input.logIndex === undefined ? {} : { logIndex: input.logIndex }),
      });
    } catch (error) {
      if (error instanceof ChainConfirmationPendingError) {
        throw new PetWalletReceiveError('CHAIN_CONFIRMATION_PENDING', error.message, 409);
      }
      throw new PetWalletReceiveError('CHAIN_EVIDENCE_MISMATCH', 'Base Sepolia transfer evidence could not be verified', 422);
    }
    verifiedEvidence(input, evidence);
    const blockHash = evidence.blockHash.toLowerCase() as `0x${string}`;
    const sameLog = wallet.receiveTransfers?.find((transfer) =>
      transfer.transactionHash === transactionHash && transfer.logIndex === evidence.logIndex);
    if (sameLog) {
      if (sameLog.from !== sender || sameLog.to !== recipient || sameLog.amountAtomic !== input.amountAtomic || sameLog.blockHash !== blockHash) {
        throw new PetWalletReceiveError('RECEIVE_EVIDENCE_INVALID', 'Transfer identity conflicts with recorded receive history', 409);
      }
      return { duplicate: true, transfer: sameLog, wallet };
    }
    const transfer: PetWalletReceiveTransfer = {
      transferId: nextId(this.#store, 'receive'), petId: pet.petId, walletId: wallet.walletId,
      chainId: BASE_SEPOLIA_CHAIN_ID, contractAddress: BASE_SEPOLIA_USDC_CONTRACT,
      transactionHash, blockHash, blockNumber: evidence.blockNumber, logIndex: evidence.logIndex,
      confirmedAtBlock: evidence.confirmedAtBlock, from: sender, to: recipient,
      amountAtomic: input.amountAtomic, amountMinor, confirmedAt: this.#now().toISOString(),
    };
    const refundReceipt = [...this.#store.receipts.values()].find((receipt) =>
      receipt.petId === pet.petId && receipt.status === 'refunded' &&
      receipt.refundTransactionHash?.toLowerCase() === transactionHash && receipt.refundLogIndex === evidence.logIndex);
    if (refundReceipt && (refundReceipt.amountMinor !== amountMinor ||
        refundReceipt.refundBlockHash?.toLowerCase() !== blockHash || refundReceipt.refundBlockNumber !== evidence.blockNumber)) {
      throw new PetWalletReceiveError('RECEIVE_EVIDENCE_INVALID', 'Refund transfer conflicts with the settled receipt', 409);
    }
    transfer.accounting = refundReceipt ? 'refund' : 'contribution';
    wallet.receiveTransfers = [...(wallet.receiveTransfers ?? []), transfer];
    if (!refundReceipt) wallet.balanceMinor += amountMinor;
    syncPocUsdcHolding(wallet);
    appendAudit(this.#store, {
      eventType: 'INBOUND_TRANSFER_RECONCILED', aggregateId: transfer.transferId, actorType: 'provider', actorId: 'base_sepolia_receive_worker',
      summary: refundReceipt
        ? 'Base Sepolia USDC refund independently verified without a duplicate wallet credit'
        : 'Base Sepolia USDC transfer independently verified and credited to the pet wallet',
      metadata: { petId: pet.petId, amountMinor, amountAtomic: input.amountAtomic, transactionHash, blockNumber: evidence.blockNumber, logIndex: evidence.logIndex, chainId: BASE_SEPOLIA_CHAIN_ID, accounting: transfer.accounting },
    });
    appendNotification(this.#store, {
      type: 'WALLET_RECEIVE_CONFIRMED',
      message: archivedDepositNotice(this.#store, pet.petId, refundReceipt
        ? `${pet.name}'s ${amountMinor / 100} USDC refund was reconciled on Base Sepolia.`
        : `${pet.name}'s pet wallet received ${amountMinor / 100} USDC on Base Sepolia.`),
      dedupeKey: `wallet-receive:${transfer.transferId}`,
    });
    return { duplicate: false, transfer, wallet };
  }
}
