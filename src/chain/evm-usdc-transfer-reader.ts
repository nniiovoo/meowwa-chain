import { getAddress, parseAbiItem } from 'viem';
import { isCanonicalUsdcAsset, type EvmChainDescriptor } from '@meowwa/chain-domain';
import { isEvmAddress, isEvmTransactionHash, type EvmAddress } from '../funding/types.js';
import { createEvmPublicClient, safeBlockNumber } from './evm.js';
import { assertScanRange, dedupeTransfers, type ChainCheckpoint, type CheckpointingUsdcTransferReader } from './usdc-transfer-reader.js';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export interface EvmRpcLog {
  address: string;
  args?: { from?: unknown; to?: unknown; value?: unknown };
  blockNumber: bigint | null;
  blockHash: string | null;
  transactionHash: string | null;
  logIndex: number | null;
  removed?: boolean;
}

export interface EvmLogClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock?(input: { blockNumber: bigint }): Promise<{ hash: string | null }>;
  getLogs(input: {
    address: EvmAddress;
    event: typeof transferEvent;
    args: { from?: EvmAddress[]; to?: EvmAddress[] };
    fromBlock: bigint;
    toBlock: bigint;
    strict: true;
  }): Promise<EvmRpcLog[]>;
}

export interface EvmUsdcTransfer<ChainId extends number = number> {
  chainId: ChainId;
  transactionHash: `0x${string}`;
  logIndex: number;
  blockNumber: number;
  blockHash: `0x${string}`;
  from: EvmAddress;
  to: EvmAddress;
  amountAtomic: string;
  removed: false;
}

export interface EvmUsdcTransferReaderOptions {
  chain: EvmChainDescriptor;
  /** Defaults to the chain's canonical USDC; anything else is refused. */
  usdcContract?: string;
  /** `inbound` reads credits only; `both` also reads the wallet's own outflows. */
  direction: 'inbound' | 'both';
}

/**
 * Reads canonical ERC-20 USDC `Transfer` logs for a set of wallets on one EVM chain.
 *
 * The chain is asserted against the RPC before every read, a removed log is refused rather than
 * ignored (it means the block it was in is gone, which is a reorg review, not a scan result), and
 * every position field must be present so the ledger can key on transaction hash plus log index.
 */
export class ViemEvmUsdcTransferReader<ChainId extends number = number> implements CheckpointingUsdcTransferReader<EvmUsdcTransfer<ChainId>> {
  readonly #client: EvmLogClient;
  readonly #chain: EvmChainDescriptor;
  readonly #usdcContract: EvmAddress;
  readonly #direction: 'inbound' | 'both';

  constructor(client: EvmLogClient, options: EvmUsdcTransferReaderOptions) {
    const usdcContract = options.usdcContract ?? options.chain.usdc.asset;
    if (!isEvmAddress(usdcContract)) throw new Error(`${options.chain.displayName} USDC contract is invalid`);
    if (!isCanonicalUsdcAsset(options.chain, usdcContract)) throw new Error(`${options.chain.displayName} USDC contract is not canonical`);
    this.#client = client;
    this.#chain = options.chain;
    this.#usdcContract = getAddress(usdcContract);
    this.#direction = options.direction;
  }

  get chain(): EvmChainDescriptor { return this.#chain; }

  async latestBlockNumber(): Promise<bigint> {
    await this.#assertChainIdentity();
    const block = await this.#client.getBlockNumber();
    safeBlockNumber(block, `${this.#chain.displayName} latest block number`);
    return block;
  }

  async blockHash(blockNumber: bigint): Promise<`0x${string}`> {
    if (blockNumber < 0n || blockNumber > BigInt(Number.MAX_SAFE_INTEGER) || !this.#client.getBlock) {
      throw new Error(`${this.#chain.displayName} checkpoint block number is invalid`);
    }
    await this.#assertChainIdentity();
    const block = await this.#client.getBlock({ blockNumber });
    if (!block || block.hash === null || !isEvmTransactionHash(block.hash)) {
      throw new Error(`${this.#chain.displayName} checkpoint block hash is unavailable`);
    }
    return block.hash.toLowerCase() as `0x${string}`;
  }

  /** Every EVM height has a block, so the window's last block is its own checkpoint. */
  async checkpointAt(toBlock: bigint): Promise<ChainCheckpoint> {
    return { blockNumber: toBlock, blockHash: await this.blockHash(toBlock) };
  }

  async getUsdcTransfers(input: { fromBlock: bigint; toBlock: bigint; walletAddresses: string[] }): Promise<EvmUsdcTransfer<ChainId>[]> {
    const label = this.#chain.displayName;
    assertScanRange(label, input.fromBlock, input.toBlock);
    if (input.walletAddresses.length === 0) return [];
    const addresses = [...new Set(input.walletAddresses.map((address) => {
      if (!isEvmAddress(address)) throw new Error(`${label} scan wallet address is invalid`);
      return getAddress(address);
    }))];
    await this.#assertChainIdentity();
    const query = { address: this.#usdcContract, event: transferEvent, fromBlock: input.fromBlock, toBlock: input.toBlock, strict: true as const };
    const queries = [this.#client.getLogs({ ...query, args: { to: addresses } })];
    if (this.#direction === 'both') queries.push(this.#client.getLogs({ ...query, args: { from: addresses } }));
    const logs = (await Promise.all(queries)).flat();
    const decoded = dedupeTransfers(label, logs.map((log) => this.#decodeLog(log)), (transfer) => `${transfer.transactionHash}:${transfer.logIndex}`);
    return decoded.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  }

  #decodeLog(log: EvmRpcLog): EvmUsdcTransfer<ChainId> {
    const label = this.#chain.displayName;
    if (!isEvmAddress(log.address) || getAddress(log.address) !== this.#usdcContract) throw new Error(`${label} log is not from canonical USDC`);
    if (log.removed) throw new Error(`Removed ${label} log requires reorg review`);
    if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null ||
      !isEvmTransactionHash(log.blockHash) || !isEvmTransactionHash(log.transactionHash) ||
      !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw new Error(`${label} log position is incomplete`);
    const from = log.args?.from;
    const to = log.args?.to;
    const value = log.args?.value;
    if (typeof from !== 'string' || typeof to !== 'string' || !isEvmAddress(from) || !isEvmAddress(to) || typeof value !== 'bigint' || value <= 0n) {
      throw new Error(`${label} USDC transfer arguments are invalid`);
    }
    return {
      chainId: this.#chain.chainId as ChainId,
      transactionHash: log.transactionHash.toLowerCase() as `0x${string}`,
      logIndex: log.logIndex,
      blockNumber: safeBlockNumber(log.blockNumber, `${label} block number`),
      blockHash: log.blockHash.toLowerCase() as `0x${string}`,
      from: getAddress(from),
      to: getAddress(to),
      amountAtomic: value.toString(),
      removed: false,
    };
  }

  async #assertChainIdentity(): Promise<void> {
    if (await this.#client.getChainId() !== this.#chain.chainId) throw new Error(`${this.#chain.displayName} chain identity mismatch`);
  }
}

export function createViemEvmUsdcTransferReader<ChainId extends number = number>(
  rpcUrl: string,
  options: EvmUsdcTransferReaderOptions,
): ViemEvmUsdcTransferReader<ChainId> {
  const client = createEvmPublicClient(options.chain, rpcUrl);
  return new ViemEvmUsdcTransferReader<ChainId>(client as unknown as EvmLogClient, options);
}
