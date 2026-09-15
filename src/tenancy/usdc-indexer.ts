import {
  CHAINS,
  isCanonicalUsdcAsset,
  isChainAddress,
  isChainTransactionId,
  isSolanaAddress,
  isSolanaSignature,
  normalizeChainAddress,
  type ChainDescriptor,
  type EvmChainDescriptor,
  type SolanaChainDescriptor,
} from '@meowwa/chain-domain';
import type { EvmUsdcTransfer } from '../chain/evm-usdc-transfer-reader.js';
import type { SolanaUsdcTransfer } from '../chain/solana-usdc-transfer-reader.js';
import { MAX_SCAN_RANGE, confirmedHead, type CheckpointingUsdcTransferReader } from '../chain/usdc-transfer-reader.js';
import {
  canonicalChainBlockHash,
  canonicalChainTransactionId,
  controlChainFor,
  isAtomicAmount,
  isChainBlockHash,
  isEvmAddress,
  isEvmTransactionHash,
  isFundingChainKey,
  parseAtomicAmount,
  sameAddressOn,
  type FundingChainKey,
} from '../funding/types.js';
import type { TenantFundingTransaction, TenantWalletBinding } from './financial-repository.js';

/** A production rail the indexer credits: the registry descriptor of a funding chain. */
export type FundingChainDescriptor = ChainDescriptor & { key: FundingChainKey };

/**
 * What the indexer persists through, keyed on the rail. Field names are the ledger's and keep
 * their names on every family: `transactionHash` is the Solana signature, `logIndex` the
 * instruction ordinal, `blockNumber` the slot and `blockHash` the blockhash.
 */
export interface TenantUsdcIndexerRepository {
  listActiveWalletAddressesPage(chainKey: FundingChainKey, afterAddress: string | null, limit: number): Promise<string[]>;
  getChainScanCursor(input: {
    chainKey: FundingChainKey;
    contractAddress: string;
    scanStartBlock: number;
  }): Promise<{
    nextBlock: number;
    walletSetRevision: number;
    checkpoint: { blockNumber: number; blockHash: string } | null;
  }>;
  advanceChainScanCursor(input: {
    chainKey: FundingChainKey;
    contractAddress: string;
    expectedNextBlock: number;
    nextBlock: number;
    checkpointBlock: number;
    checkpointHash: string;
    expectedWalletSetRevision: number;
  }): Promise<boolean>;
  resolveWalletTenant(chainKey: FundingChainKey, walletAddress: string): Promise<string | undefined>;
  getWalletForWorker(tenantId: string, chainKey: FundingChainKey, walletAddress: string): Promise<TenantWalletBinding | undefined>;
  findAwaitingFundingByTransactionHash(
    tenantId: string,
    walletId: string,
    chainKey: FundingChainKey,
    transactionHash: string,
  ): Promise<TenantFundingTransaction | undefined>;
  settleFunding(input: {
    tenantId: string;
    fundingId: string;
    walletId: string;
    chainKey: FundingChainKey;
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    amountAtomic: string;
    observedAt: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }>;
  settleDirectDeposit(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    chainKey: FundingChainKey;
    walletAddress: string;
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    amountAtomic: string;
    observedAt: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }>;
  reconcileRecordedChainCredit(input: {
    tenantId: string;
    fundingId: string;
    walletId: string;
    chainKey: FundingChainKey;
    transactionHash: string;
    destinationAmountAtomic: string;
  }): Promise<{ transaction: TenantFundingTransaction; matched: boolean; applied: boolean }>;
  recordWalletOutflow(input: {
    tenantId: string;
    walletId: string;
    chainKey: FundingChainKey;
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    amountAtomic: string;
    destinationAddress: string;
    observedAt: string;
  }): Promise<boolean>;
}

/**
 * One canonical USDC movement in the ledger's own vocabulary, whatever the chain called it.
 * `transactionIndex` only orders transfers inside a block where the chain reports one; an EVM log
 * index is already block-wide, so it is zero there.
 */
export interface NormalizedUsdcTransfer {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  from: string;
  to: string;
  amountAtomic: string;
  transactionIndex: number;
}

/**
 * The per-family half of the indexer: vouches for a reader's transfer and maps it onto the ledger's
 * fields. Anything it cannot vouch for is thrown, never dropped -- a transfer the reader served
 * that the adapter cannot name is a reader contradicting itself, which is not evidence.
 */
export interface UsdcTransferAdapter<Transfer> {
  normalize(transfer: Transfer): NormalizedUsdcTransfer;
}

function positiveAmount(value: string): boolean {
  return isAtomicAmount(value) && parseAtomicAmount(value) > 0n;
}

function safeIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evmUsdcTransferAdapter(chain: EvmChainDescriptor): UsdcTransferAdapter<EvmUsdcTransfer> {
  return {
    normalize(transfer) {
      if (transfer.chainId !== chain.chainId || transfer.removed || !isEvmTransactionHash(transfer.transactionHash) ||
        !isEvmTransactionHash(transfer.blockHash) || !isEvmAddress(transfer.from) || !isEvmAddress(transfer.to) ||
        !safeIndex(transfer.logIndex) || !safeIndex(transfer.blockNumber) || !positiveAmount(transfer.amountAtomic)) {
        throw new Error(`${chain.displayName} USDC transfer is invalid`);
      }
      return {
        transactionHash: transfer.transactionHash,
        logIndex: transfer.logIndex,
        blockNumber: transfer.blockNumber,
        blockHash: transfer.blockHash,
        from: transfer.from,
        to: transfer.to,
        amountAtomic: transfer.amountAtomic,
        transactionIndex: 0,
      };
    },
  };
}

export function solanaUsdcTransferAdapter(chain: SolanaChainDescriptor): UsdcTransferAdapter<SolanaUsdcTransfer> {
  return {
    normalize(transfer) {
      if (transfer.chainKey !== chain.key || transfer.caip2 !== chain.caip2 || !isSolanaSignature(transfer.signature) ||
        !isSolanaAddress(transfer.blockhash) || !isSolanaAddress(transfer.from) || !isSolanaAddress(transfer.to) ||
        !safeIndex(transfer.instructionIndex) || !safeIndex(transfer.transactionIndex) || !safeIndex(transfer.slot) ||
        !positiveAmount(transfer.amountAtomic)) {
        throw new Error(`${chain.displayName} USDC transfer is invalid`);
      }
      return {
        transactionHash: transfer.signature,
        logIndex: transfer.instructionIndex,
        blockNumber: transfer.slot,
        blockHash: transfer.blockhash,
        from: transfer.from,
        to: transfer.to,
        amountAtomic: transfer.amountAtomic,
        transactionIndex: transfer.transactionIndex,
      };
    },
  };
}

export class TenantChainReorgDetectedError extends Error {
  /** The confirmed checkpoint that left the chain the RPC serves, and which rail it was on. Identifies
   * the divergence so the durable halt record and its deduplication key survive across polls and
   * restarts. On a finalized-only chain a changed checkpoint is an RPC identity problem rather than
   * a reorganization; the halt is the same, the review is not (docs/runbooks/BASE_REORG.md). */
  readonly checkpoint: { chainKey: FundingChainKey; blockNumber: number; blockHash: string };

  constructor(checkpoint: { chainKey?: FundingChainKey; blockNumber: number; blockHash: string }) {
    const chainKey = checkpoint.chainKey ?? 'base';
    super(`${CHAINS[chainKey].displayName} chain checkpoint changed; funding indexing is halted for reorg review`);
    this.name = 'TenantChainReorgDetectedError';
    this.checkpoint = { chainKey, blockNumber: checkpoint.blockNumber, blockHash: checkpoint.blockHash };
  }
}

const MAX_SCAN_RANGE_BLOCKS = Number(MAX_SCAN_RANGE);

function safeBlock(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} scan block is invalid`);
  return Number(value);
}

/**
 * Credits and debits canonical USDC for every production pet wallet on one rail.
 *
 * The chain-specific half lives in the reader and the adapter; this class owns what is the same on
 * every rail: the durable cursor and checkpoint, the confirmed window, the independent block-hash
 * re-check before any settlement, tenant resolution, and the idempotent settle/outflow handshake.
 * Addresses and hashes are compared under the rail's own identity rules -- lowercase hex on an EVM
 * chain, exact base58 on Solana -- because lowercasing base58 turns one wallet into another.
 */
export class TenantUsdcIndexer<Transfer> {
  readonly #chain: FundingChainDescriptor;
  readonly #reader: CheckpointingUsdcTransferReader<Transfer>;
  readonly #adapter: UsdcTransferAdapter<Transfer>;
  readonly #repository: TenantUsdcIndexerRepository;
  readonly #usdcAsset: string;
  readonly #confirmations: number;
  readonly #scanStartBlock: number;
  readonly #maxScanRange: number;
  readonly #pageSize: number;
  readonly #maxWallets: number;
  readonly #now: () => Date;

  constructor(options: {
    chain: FundingChainDescriptor;
    reader: CheckpointingUsdcTransferReader<Transfer>;
    adapter: UsdcTransferAdapter<Transfer>;
    repository: TenantUsdcIndexerRepository;
    usdcAsset: string;
    confirmations: number;
    scanStartBlock: number;
    /** Heights per scan: the RPC-cost budget of one poll, at most the reader's own 1,999 ceiling. */
    maxScanRange?: number;
    walletPageSize?: number;
    maxWallets?: number;
    now?: () => Date;
  }) {
    const label = options.chain.displayName;
    if (!isFundingChainKey(options.chain.key) || !isCanonicalUsdcAsset(options.chain, options.usdcAsset) ||
      !Number.isSafeInteger(options.confirmations) || options.confirmations < 1 ||
      !Number.isSafeInteger(options.scanStartBlock) || options.scanStartBlock < 0) {
      throw new Error(`Tenant ${label} indexer configuration is invalid`);
    }
    const maxScanRange = options.maxScanRange ?? MAX_SCAN_RANGE_BLOCKS;
    if (!Number.isSafeInteger(maxScanRange) || maxScanRange < 1 || maxScanRange > MAX_SCAN_RANGE_BLOCKS) {
      throw new Error(`Tenant ${label} scan window is invalid`);
    }
    const pageSize = options.walletPageSize ?? 500;
    const maxWallets = options.maxWallets ?? 10_000;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000 ||
      !Number.isSafeInteger(maxWallets) || maxWallets < pageSize || maxWallets > 100_000) {
      throw new Error(`Tenant ${label} wallet scan limits are invalid`);
    }
    this.#chain = options.chain;
    this.#reader = options.reader;
    this.#adapter = options.adapter;
    this.#repository = options.repository;
    this.#usdcAsset = normalizeChainAddress(options.chain, options.usdcAsset);
    this.#confirmations = options.confirmations;
    this.#scanStartBlock = options.scanStartBlock;
    this.#maxScanRange = maxScanRange;
    this.#pageSize = pageSize;
    this.#maxWallets = maxWallets;
    this.#now = options.now ?? (() => new Date());
  }

  get chain(): FundingChainDescriptor { return this.#chain; }

  async scanOnce(): Promise<
    { fromBlock: number; toBlock: number; processed: number; nextBlock: number } |
    { processed: number; nextBlock: number }
  > {
    const chain = this.#chain;
    const label = chain.displayName;
    const cursor = await this.#repository.getChainScanCursor({
      chainKey: chain.key, contractAddress: this.#usdcAsset, scanStartBlock: this.#scanStartBlock,
    });
    if (!Number.isSafeInteger(cursor.nextBlock) || cursor.nextBlock < this.#scanStartBlock) {
      throw new Error(`Tenant ${label} scan cursor is invalid`);
    }
    if (cursor.checkpoint) {
      if (!Number.isSafeInteger(cursor.checkpoint.blockNumber) || cursor.checkpoint.blockNumber < 0 ||
        cursor.checkpoint.blockNumber >= cursor.nextBlock || !isChainBlockHash(chain, cursor.checkpoint.blockHash)) {
        throw new Error(`Tenant ${label} scan checkpoint is invalid`);
      }
      const canonical = await this.#reader.blockHash(BigInt(cursor.checkpoint.blockNumber));
      if (!this.#sameBlockHash(canonical, cursor.checkpoint.blockHash)) {
        throw new TenantChainReorgDetectedError({
          chainKey: chain.key, blockNumber: cursor.checkpoint.blockNumber, blockHash: cursor.checkpoint.blockHash,
        });
      }
    }

    // An empty wallet set used to return here, pinning the cursor at the scan start for the whole
    // pre-launch period: the first funded wallet then inherited every block since deploy (~1,999
    // blocks per 15s poll against Base's ~43,200/day, i.e. hours of catch-up before its first
    // deposit was credited) while readiness reported success throughout. A window with no
    // eligible wallet has nothing creditable, so it is safe to walk past it -- and doing so lays
    // down the checkpoint the reorg check above otherwise never gets.
    const walletAddresses = await this.#loadWalletAddresses();
    const latest = await this.#reader.latestBlockNumber();
    const confirmed = confirmedHead(latest, this.#confirmations);
    if (confirmed === undefined || BigInt(cursor.nextBlock) > confirmed) {
      return { processed: 0, nextBlock: cursor.nextBlock };
    }
    const checkpoint = await this.#windowCheckpoint(cursor.nextBlock, safeBlock(confirmed, label));
    if (!checkpoint) return { processed: 0, nextBlock: cursor.nextBlock };
    const toBlock = checkpoint.blockNumber;
    const transfers = walletAddresses.length === 0 ? [] : await this.#readTransfers(cursor.nextBlock, toBlock, walletAddresses);

    // The checkpoint's own hash was just read; every other block a transfer names is re-fetched
    // independently of the log that named it before anything settles.
    const verifiedBlockHashes = new Map<number, string>([[checkpoint.blockNumber, checkpoint.blockHash]]);
    const verifyBlock = async (blockNumber: number): Promise<string> => {
      const prior = verifiedBlockHashes.get(blockNumber);
      if (prior !== undefined) return prior;
      const hash = await this.#reader.blockHash(BigInt(blockNumber));
      verifiedBlockHashes.set(blockNumber, hash);
      return hash;
    };
    for (const item of transfers) {
      const canonical = await verifyBlock(item.blockNumber);
      if (!this.#sameBlockHash(canonical, item.blockHash)) {
        throw new TenantChainReorgDetectedError({ chainKey: chain.key, blockNumber: item.blockNumber, blockHash: item.blockHash });
      }
    }
    const scannedAddressSet = new Set(walletAddresses);
    const bindingCache = new Map<string, TenantWalletBinding | undefined>();
    const resolveBinding = async (address: string): Promise<TenantWalletBinding | undefined> => {
      const key = normalizeChainAddress(chain, address);
      if (!scannedAddressSet.has(key)) return undefined;
      if (bindingCache.has(key)) return bindingCache.get(key);
      const tenantId = await this.#repository.resolveWalletTenant(chain.key, address);
      if (!tenantId) {
        bindingCache.set(key, undefined);
        return undefined;
      }
      const binding = await this.#repository.getWalletForWorker(tenantId, chain.key, address);
      if (!binding || binding.tenantId !== tenantId || binding.chainKey !== controlChainFor(chain.key) ||
        (binding.fundingChainKey ?? chain.key) !== chain.key ||
        !['active', 'provisioning'].includes(binding.status) ||
        !sameAddressOn(chain.key, binding.smartWalletAddress, key)) {
        throw new Error(`Resolved ${label} wallet binding is invalid`);
      }
      bindingCache.set(key, binding);
      return binding;
    };

    let processed = 0;
    for (const item of transfers) {
      const [incoming, outgoing] = await Promise.all([resolveBinding(item.to), resolveBinding(item.from)]);
      if (incoming && outgoing && incoming.walletId === outgoing.walletId && incoming.tenantId === outgoing.tenantId) continue;
      if (incoming && await this.#processCredit(incoming, item)) processed += 1;
      if (outgoing && await this.#repository.recordWalletOutflow({
        tenantId: outgoing.tenantId,
        walletId: outgoing.walletId,
        chainKey: chain.key,
        transactionHash: item.transactionHash,
        logIndex: item.logIndex,
        blockNumber: item.blockNumber,
        blockHash: item.blockHash,
        amountAtomic: item.amountAtomic,
        destinationAddress: item.to,
        observedAt: this.#now().toISOString(),
      })) processed += 1;
    }
    const nextBlock = toBlock + 1;
    const advanced = await this.#repository.advanceChainScanCursor({
      chainKey: chain.key,
      contractAddress: this.#usdcAsset,
      expectedNextBlock: cursor.nextBlock,
      nextBlock,
      checkpointBlock: toBlock,
      checkpointHash: checkpoint.blockHash,
      expectedWalletSetRevision: cursor.walletSetRevision,
    });
    // A refused compare-and-set means a wallet became funding-eligible while this window's log
    // query was in flight, so the window must be re-scanned with the new wallet set -- holding the
    // cursor is the guard that stops it skipping that wallet's deposits. It is NOT a scan failure:
    // every credit above already committed in its own transaction. Throwing here latched
    // failedScanAt in financial-worker-http.ts and made /health/ready answer 503 with 'deposits
    // are not being credited' -- false, and page-worthy -- on ordinary wallet provisioning.
    // ponytail: ceiling is that sustained contention is invisible -- a wallet flipping eligible in
    // every single window would hold the cursor forever behind a green readiness. Bounded in
    // practice by signup rate against a ~15s poll, and no deposit is lost either way because the
    // window is re-scanned. Upgrade path: a TenantChainScanCursorContendedError the worker counts
    // (financial-worker-http.ts) so consecutive contentions become alertable.
    if (!advanced) return { processed, nextBlock: cursor.nextBlock };
    return { fromBlock: cursor.nextBlock, toBlock, processed, nextBlock };
  }

  /**
   * The block this scan ends on, or nothing while no block at or after `nextBlock` is confirmed.
   *
   * The window is `maxScanRange` heights and ends on the last block produced inside it. Every EVM
   * height has a block, so that is the window's last height; Solana skips slots, so it can be
   * lower, and a skipped stretch longer than the window (what a cluster outage leaves behind)
   * holds no block at all. Nothing in such a stretch is creditable, but the cursor can only ever
   * advance onto a block, so the search widens until the first block at or after `nextBlock` is
   * found -- doubling, then bisecting, each probe one cheap `getBlocks` range -- and the window
   * then ends one range past that block, so the scan never fetches more blocks than its budget.
   */
  async #windowCheckpoint(nextBlock: number, confirmedBlock: number): Promise<{ blockNumber: number; blockHash: string } | undefined> {
    const range = this.#maxScanRange;
    const first = await this.#checkpointAt(Math.min(nextBlock + range - 1, confirmedBlock));
    if (first.blockNumber >= nextBlock) return first;
    // Known: no block in [nextBlock, below]. Widen until a block appears, or the head is reached.
    let below = Math.min(nextBlock + range - 1, confirmedBlock);
    let above: number | undefined;
    for (let span = range; above === undefined && below < confirmedBlock; span *= 2) {
      const probe = Math.min(below + span, confirmedBlock);
      const checkpoint = await this.#checkpointAt(probe);
      if (checkpoint.blockNumber >= nextBlock) above = checkpoint.blockNumber;
      else below = probe;
    }
    if (above === undefined) return undefined;
    // A block exists in (below, above]; find the first one, so the window fetches one range at most.
    while (above - below > 1) {
      const mid = below + Math.floor((above - below) / 2);
      const checkpoint = await this.#checkpointAt(mid);
      if (checkpoint.blockNumber >= nextBlock) above = checkpoint.blockNumber;
      else below = mid;
    }
    return this.#checkpointAt(Math.min(above + range - 1, confirmedBlock));
  }

  async #checkpointAt(toBlock: number): Promise<{ blockNumber: number; blockHash: string }> {
    const label = this.#chain.displayName;
    const checkpoint = await this.#reader.checkpointAt(BigInt(toBlock));
    if (typeof checkpoint.blockNumber !== 'bigint' || checkpoint.blockNumber < 0n || checkpoint.blockNumber > BigInt(toBlock) ||
      !isChainBlockHash(this.#chain, checkpoint.blockHash)) {
      throw new Error(`Tenant ${label} scan checkpoint is invalid`);
    }
    return { blockNumber: safeBlock(checkpoint.blockNumber, label), blockHash: canonicalChainBlockHash(this.#chain.key, checkpoint.blockHash) };
  }

  /** Reads the window in reader-sized ranges (one, in the ordinary case) and orders it by position. */
  async #readTransfers(fromBlock: number, toBlock: number, walletAddresses: string[]): Promise<NormalizedUsdcTransfer[]> {
    const label = this.#chain.displayName;
    const transfers: NormalizedUsdcTransfer[] = [];
    for (let from = fromBlock; from <= toBlock; from += MAX_SCAN_RANGE_BLOCKS) {
      const to = Math.min(from + MAX_SCAN_RANGE_BLOCKS - 1, toBlock);
      const page = await this.#reader.getUsdcTransfers({ fromBlock: BigInt(from), toBlock: BigInt(to), walletAddresses });
      for (const raw of page) {
        const item = this.#adapter.normalize(raw);
        if (item.blockNumber < from || item.blockNumber > to) throw new Error(`${label} USDC transfer is invalid`);
        transfers.push(item);
      }
    }
    return transfers.sort((left, right) =>
      left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex);
  }

  #sameBlockHash(left: string, right: string): boolean {
    const chain = this.#chain;
    return isChainBlockHash(chain, left) && isChainBlockHash(chain, right) &&
      canonicalChainBlockHash(chain.key, left) === canonicalChainBlockHash(chain.key, right);
  }

  #sameTransactionId(left: string | null, right: string): boolean {
    const chain = this.#chain;
    return left !== null && isChainTransactionId(chain, left) && isChainTransactionId(chain, right) &&
      canonicalChainTransactionId(chain.key, left) === canonicalChainTransactionId(chain.key, right);
  }

  async #processCredit(binding: TenantWalletBinding, transfer: NormalizedUsdcTransfer): Promise<boolean> {
    const chain = this.#chain;
    const label = chain.displayName;
    const awaiting = await this.#repository.findAwaitingFundingByTransactionHash(
      binding.tenantId, binding.walletId, chain.key, transfer.transactionHash,
    );
    const common = {
      tenantId: binding.tenantId,
      walletId: binding.walletId,
      chainKey: chain.key,
      transactionHash: transfer.transactionHash,
      logIndex: transfer.logIndex,
      blockNumber: transfer.blockNumber,
      blockHash: transfer.blockHash,
      amountAtomic: transfer.amountAtomic,
      observedAt: this.#now().toISOString(),
    };
    if (awaiting) {
      if (awaiting.tenantId !== binding.tenantId || awaiting.walletId !== binding.walletId ||
        awaiting.chainKey !== chain.key ||
        !sameAddressOn(chain.key, awaiting.walletAddress, binding.smartWalletAddress) ||
        awaiting.rail !== 'stripe_onramp' || awaiting.status !== 'pending' ||
        // The repository deliberately returns chargeback_review alongside awaiting_chain, and
        // settleFunding preserves that flag rather than promoting it to confirmed. Rejecting it
        // here would throw out of the scan loop and halt all indexing on this rail for the tenant.
        !['awaiting_chain', 'chargeback_review'].includes(awaiting.reconciliationStatus) ||
        !this.#sameTransactionId(awaiting.transactionHash, transfer.transactionHash)) {
        throw new Error(`Awaiting Stripe funding does not match the canonical ${label} transfer`);
      }
      if (awaiting.destinationAmountAtomic === transfer.amountAtomic) {
        return (await this.#repository.settleFunding({ ...common, fundingId: awaiting.fundingId })).applied;
      }
    }
    const direct = await this.#repository.settleDirectDeposit({
      ...common,
      petId: binding.petId,
      walletAddress: binding.smartWalletAddress,
    });

    // Close the only unsafe race: Stripe can move the funding row to awaiting_chain
    // after the first lookup but before this direct credit commits. Whichever side
    // commits second performs the same idempotent reclassification handshake.
    const delayed = await this.#repository.findAwaitingFundingByTransactionHash(
      binding.tenantId, binding.walletId, chain.key, transfer.transactionHash,
    );
    if (!delayed) return direct.applied;
    if (delayed.tenantId !== binding.tenantId || delayed.walletId !== binding.walletId ||
      delayed.chainKey !== chain.key ||
      !sameAddressOn(chain.key, delayed.walletAddress, binding.smartWalletAddress) ||
      delayed.rail !== 'stripe_onramp' || delayed.status !== 'pending' ||
      !['awaiting_chain', 'chargeback_review'].includes(delayed.reconciliationStatus) ||
      !this.#sameTransactionId(delayed.transactionHash, transfer.transactionHash)) {
      throw new Error(`Delayed Stripe funding does not match the canonical ${label} transfer`);
    }
    if (delayed.destinationAmountAtomic !== transfer.amountAtomic) return direct.applied;
    const reconciled = await this.#repository.reconcileRecordedChainCredit({
      tenantId: binding.tenantId,
      fundingId: delayed.fundingId,
      walletId: binding.walletId,
      chainKey: chain.key,
      transactionHash: transfer.transactionHash,
      destinationAmountAtomic: transfer.amountAtomic,
    });
    return direct.applied || reconciled.applied;
  }

  /**
   * Every production wallet on this rail, in the storage form the rail compares under. Pages are
   * checked strictly ascending under that same form: the SQL orders bytewise (`COLLATE "C"`), which
   * is what the JS code-unit comparison sees, on lowercase hex and on mixed-case base58 alike.
   */
  async #loadWalletAddresses(): Promise<string[]> {
    const chain = this.#chain;
    const label = chain.displayName;
    const result: string[] = [];
    let afterAddress: string | null = null;
    while (true) {
      const page = await this.#repository.listActiveWalletAddressesPage(chain.key, afterAddress, this.#pageSize);
      if (page.length > this.#pageSize) throw new Error(`Tenant ${label} wallet page is invalid`);
      let previous = afterAddress ?? '';
      for (const address of page) {
        if (!isChainAddress(chain, address)) throw new Error(`Tenant ${label} wallet page is not strictly ordered`);
        const normalized = normalizeChainAddress(chain, address);
        if (normalized <= previous) throw new Error(`Tenant ${label} wallet page is not strictly ordered`);
        previous = normalized;
        result.push(normalized);
        if (result.length > this.#maxWallets) throw new Error(`Tenant ${label} wallet scan limit was exceeded`);
      }
      if (page.length < this.#pageSize) return result;
      afterAddress = result.at(-1) ?? null;
    }
  }
}

export class TenantUsdcIndexingWorker {
  readonly #indexer: { scanOnce(): Promise<unknown> };
  #active: Promise<unknown> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #haltedBy: TenantChainReorgDetectedError | undefined;

  constructor(indexer: { scanOnce(): Promise<unknown> }) {
    this.#indexer = indexer;
  }

  async runOnce(): Promise<unknown | undefined> {
    // A detected reorg halts this worker one-way until the process restarts. This matters for
    // the mid-scan detection path: a transfer whose block hash changed leaves no durable
    // footprint -- the stored checkpoint predates it -- so without this latch the next poll
    // would see the new canonical logs, scan clean, resume crediting, and never re-announce
    // the divergence the durable record write may have just failed to persist. Re-throwing the
    // same error every poll keeps crediting stopped AND retries the halt record (via the
    // caller's onError) until it durably lands.
    if (this.#haltedBy) throw this.#haltedBy;
    if (this.#active) return undefined;
    const operation = this.#indexer.scanOnce();
    this.#active = operation;
    try {
      return await operation;
    } catch (error) {
      if (error instanceof TenantChainReorgDetectedError) this.#haltedBy = error;
      throw error;
    } finally {
      this.#active = undefined;
    }
  }

  start(
    pollMs: number,
    onError: (error: unknown) => void = () => undefined,
    onScan: () => void = () => undefined,
  ): void {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 3_600_000) {
      throw new Error('Tenant USDC indexer poll interval is invalid');
    }
    if (this.#timer) return;
    // Only a completed scan reports success. runOnce resolves undefined when a previous scan is
    // still in flight, which is the shape a hung scan takes -- counting that as progress would
    // clear the very failure state readiness needs to keep reporting.
    const run = () => {
      void this.runOnce().then((result) => { if (result !== undefined) onScan(); }, onError);
    };
    run();
    this.#timer = setInterval(run, pollMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    try {
      await this.#active;
    } catch {
      // A scheduled invocation is reported through the start callback.
    }
  }
}
