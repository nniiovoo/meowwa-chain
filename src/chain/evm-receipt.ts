import { decodeEventLog, getAddress, type Hex } from 'viem';
import type { EvmChainDescriptor } from '@meowwa/chain-domain';
import { ERC20_TRANSFER_EVENT_ABI, ERC20_TRANSFER_EVENT_TOPIC, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN, safeBlockNumber } from './evm.js';

export interface EvmReceiptLog {
  address: string;
  topics: [Hex, ...Hex[]];
  data: Hex;
  transactionHash: string | null;
  blockHash: string | null;
  blockNumber: bigint | null;
  logIndex: number | null;
  removed?: boolean;
}

export interface EvmReceipt {
  status: 'success' | 'reverted';
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  logs: EvmReceiptLog[];
}

export interface EvmReceiptClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: string | null; number: bigint; timestamp?: bigint }>;
  getTransactionReceipt(input: { hash: `0x${string}` }): Promise<EvmReceipt>;
}

export class ChainConfirmationPendingError extends Error {
  constructor() {
    super('Chain confirmation depth is insufficient');
    this.name = 'ChainConfirmationPendingError';
  }
}

/** One decoded canonical USDC `Transfer` log, addresses checksummed. */
export interface CanonicalUsdcTransferLog {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  logIndex: number;
}

export interface VerifiedEvmReceipt {
  transactionHash: `0x${string}`;
  blockHash: `0x${string}`;
  blockNumber: number;
  confirmedAtBlock: number;
  blockTimestamp: bigint | undefined;
  transfers: CanonicalUsdcTransferLog[];
}

/** Whether a receipt is deep enough: the head must be at least `confirmations` past its block. */
export function receiptConfirmed(receiptBlock: bigint, latestBlock: bigint, confirmations: number): boolean {
  return latestBlock >= receiptBlock && latestBlock - receiptBlock >= BigInt(confirmations);
}

/**
 * The receipt check every settlement path shares: the RPC is on the expected chain, the receipt
 * is for the named transaction and succeeded, it is at least `confirmations` deep, the block it
 * names is still the canonical block at that height, and every canonical USDC `Transfer` log in
 * it is positioned consistently and decodes. Callers then match the decoded transfers against
 * what they expected; this function does not know what "expected" means.
 *
 * `fail` builds the caller's error, so an execution verifier can raise its evidence-mismatch
 * class and the controlled merchant its own messages without restating the checks.
 */
export async function verifyCanonicalUsdcReceipt(client: EvmReceiptClient, input: {
  chain: EvmChainDescriptor;
  transactionHash: string;
  confirmations: number;
  minConfirmations: number;
  label: string;
  fail: (message: string) => Error;
}): Promise<VerifiedEvmReceipt> {
  const { chain, label, fail } = input;
  if (!EVM_HASH_PATTERN.test(input.transactionHash)) throw fail(`Invalid ${label} transaction hash`);
  if (!Number.isSafeInteger(input.confirmations) || input.confirmations < input.minConfirmations || input.confirmations > 100) {
    throw fail(`Invalid ${label} confirmation depth`);
  }
  if (await client.getChainId() !== chain.chainId) throw fail(`${label} chain identity mismatch`);
  const transactionHash = input.transactionHash.toLowerCase() as `0x${string}`;
  const [receipt, latestBlock] = await Promise.all([
    client.getTransactionReceipt({ hash: transactionHash }),
    client.getBlockNumber(),
  ]);
  if (receipt.status !== 'success') throw fail(`${label} transaction reverted`);
  if (!EVM_HASH_PATTERN.test(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== transactionHash ||
    !EVM_HASH_PATTERN.test(receipt.blockHash)) throw fail(`${label} receipt identity mismatch`);
  if (!receiptConfirmed(receipt.blockNumber, latestBlock, input.confirmations)) throw new ChainConfirmationPendingError();
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!block || block.number !== receipt.blockNumber || block.hash === null || !EVM_HASH_PATTERN.test(block.hash) ||
    block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw fail(`${label} block identity is not canonical`);
  const usdc = getAddress(chain.usdc.asset);
  const transfers: CanonicalUsdcTransferLog[] = [];
  for (const log of receipt.logs) {
    if (!EVM_ADDRESS_PATTERN.test(log.address) || getAddress(log.address) !== usdc) continue;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_EVENT_TOPIC) continue;
    if (log.removed) throw fail(`Removed ${label} log requires review`);
    if (log.transactionHash === null || log.blockHash === null || log.blockNumber === null || log.logIndex === null ||
      !EVM_HASH_PATTERN.test(log.transactionHash) || !EVM_HASH_PATTERN.test(log.blockHash) ||
      log.transactionHash.toLowerCase() !== transactionHash ||
      log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() || log.blockNumber !== receipt.blockNumber ||
      !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw fail(`${label} transfer log position is invalid`);
    let decoded;
    try {
      decoded = decodeEventLog({ abi: ERC20_TRANSFER_EVENT_ABI, eventName: 'Transfer', data: log.data, topics: log.topics, strict: true });
    } catch {
      throw fail(`Canonical ${label} USDC log could not be decoded`);
    }
    transfers.push({ from: getAddress(decoded.args.from), to: getAddress(decoded.args.to), value: decoded.args.value, logIndex: log.logIndex });
  }
  return {
    transactionHash,
    blockHash: receipt.blockHash.toLowerCase() as `0x${string}`,
    blockNumber: safeBlockNumber(receipt.blockNumber, `${label} block number`),
    confirmedAtBlock: safeBlockNumber(latestBlock, `${label} confirmed head`),
    blockTimestamp: block.timestamp,
    transfers,
  };
}
