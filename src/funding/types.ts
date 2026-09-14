import {
  ATOMIC_AMOUNT_PATTERN,
  CHAINS,
  EVM_ADDRESS_PATTERN,
  EVM_HASH_PATTERN,
  isChainAddress,
  isChainBlockHash,
  isChainTransactionId,
  normalizeChainAddress,
  type ChainKey,
} from '@meowwa/chain-domain';

export type EvmAddress = `0x${string}`;
export type EvmTransactionHash = `0x${string}`;

// The rail vocabulary lives in the domain registry (packages/domain/src/chain.ts) so the API, web
// and mobile clients name the same chains; these re-exports keep the API's import path stable.
export {
  CONTROL_CHAIN_KEYS,
  FUNDING_CHAIN_KEYS,
  controlChainFor,
  fundingChainFor,
  isChainBlockHash,
  isControlChainKey,
  isFundingChainKey,
  isSolanaBlockhash,
  type ControlChainKey,
  type FundingChainKey,
} from '@meowwa/chain-domain';

export function isAtomicAmount(value: string): boolean {
  return ATOMIC_AMOUNT_PATTERN.test(value);
}

export function isEvmAddress(value: string): value is EvmAddress {
  return EVM_ADDRESS_PATTERN.test(value);
}

export function isEvmTransactionHash(value: string): value is EvmTransactionHash {
  return EVM_HASH_PATTERN.test(value);
}

export function parseAtomicAmount(value: string): bigint {
  if (!isAtomicAmount(value)) throw new Error('Invalid USDC atomic amount');
  return BigInt(value);
}

/**
 * The storage form of an address on a chain: lowercase hex on an EVM chain, the base58 value
 * unchanged on Solana (case carries information there, so lowercasing makes a different key).
 * Throws unless the value is an address of that chain's family.
 */
export function canonicalChainAddress(chainKey: ChainKey, value: string): string {
  const chain = CHAINS[chainKey];
  if (!isChainAddress(chain, value)) throw new Error(`Invalid ${chain.displayName} address`);
  return normalizeChainAddress(chain, value);
}

/** Lowercase hex on an EVM chain, the base58 signature unchanged on Solana. */
export function canonicalChainTransactionId(chainKey: ChainKey, value: string): string {
  const chain = CHAINS[chainKey];
  if (!isChainTransactionId(chain, value)) throw new Error(`Invalid ${chain.displayName} transaction id`);
  return chain.family === 'evm' ? value.toLowerCase() : value;
}

/** Lowercase hex on an EVM chain, the base58 blockhash unchanged on Solana. */
export function canonicalChainBlockHash(chainKey: ChainKey, value: string): string {
  const chain = CHAINS[chainKey];
  if (!isChainBlockHash(chain, value)) throw new Error(`Invalid ${chain.displayName} block hash`);
  return chain.family === 'evm' ? value.toLowerCase() : value;
}

/** Whether two values name the same address on a chain; false when either is not an address there. */
export function sameAddressOn(chainKey: ChainKey, left: string, right: string): boolean {
  const chain = CHAINS[chainKey];
  return isChainAddress(chain, left) && isChainAddress(chain, right) &&
    normalizeChainAddress(chain, left) === normalizeChainAddress(chain, right);
}
