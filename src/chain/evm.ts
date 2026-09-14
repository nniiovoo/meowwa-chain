import { createPublicClient, encodeEventTopics, http, parseAbi, type Chain, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import {
  CHAINS,
  EVM_ADDRESS_PATTERN,
  EVM_HASH_PATTERN,
  type EvmChainDescriptor,
} from '@meowwa/chain-domain';

/**
 * The EVM facts every Base reader used to restate for itself: the address and hash shapes, the
 * ERC-20 `Transfer` event and `transfer` call, and the viem chain object for a descriptor. One
 * copy, so the funding indexer, the sandbox receive scanner, the execution verifier and the
 * controlled merchant cannot drift apart on what "a canonical USDC transfer" looks like.
 */
export { EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN };

export const ERC20_TRANSFER_ABI = [{
  type: 'function' as const,
  name: 'transfer',
  stateMutability: 'nonpayable' as const,
  inputs: [
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

export const ERC20_TRANSFER_EVENT_ABI = [{
  type: 'event' as const,
  name: 'Transfer',
  anonymous: false,
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;

export const ERC20_TRANSFER_EVENT_TOPIC = encodeEventTopics({
  abi: ERC20_TRANSFER_EVENT_ABI,
  eventName: 'Transfer',
})[0].toLowerCase();

export const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);

/** Block numbers travel as bigint on the wire and as safe integers in the ledger; refuse the gap. */
export function safeBlockNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is invalid`);
  return Number(value);
}

const viemChains: Record<number, Chain> = {
  [CHAINS.base.chainId]: base,
  [CHAINS.base_sepolia.chainId]: baseSepolia,
};

export function viemChain(chain: EvmChainDescriptor): Chain {
  const resolved = viemChains[chain.chainId];
  if (!resolved) throw new Error(`No viem chain definition for ${chain.displayName}`);
  return resolved;
}

export function createEvmPublicClient(chain: EvmChainDescriptor, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: viemChain(chain), transport: http(rpcUrl, { retryCount: 3, timeout: 15_000 }) }) as PublicClient;
}
