import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_USDC_CONTRACT,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_CONTRACT,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_DEVNET_USDC_MINT,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_MAINNET_USDC_MINT,
} from './codes.js';

/**
 * The one place that knows what "a chain" is. Every rail (funding, receive, execution, withdrawal)
 * used to restate the Base chain ID, USDC contract, address shape and Privy chain name for itself,
 * so adding a second network meant finding every copy. A descriptor carries all of it, and the
 * validators below are keyed on the descriptor's family rather than on the assumption that an
 * address is twenty hex bytes.
 */
export const CHAIN_KEYS = ['base', 'base_sepolia', 'solana', 'solana_devnet'] as const;
export type ChainKey = (typeof CHAIN_KEYS)[number];
export type ChainFamily = 'evm' | 'solana';
export type ChainEnvironment = 'production' | 'test';

interface ChainDescriptorBase {
  readonly key: ChainKey;
  readonly family: ChainFamily;
  /** CAIP-2 identifier, the form Privy and wallet standards use to name a network. */
  readonly caip2: string;
  /** The `source.chain` name Privy's transfer action and policies use for this network. */
  readonly privyChain: string;
  /** The Privy wallet `chain_type` an embedded wallet on this network is created with. */
  readonly privyChainType: 'ethereum' | 'solana';
  readonly displayName: string;
  readonly environment: ChainEnvironment;
  readonly usdc: {
    readonly symbol: 'USDC';
    readonly decimals: 6;
    /** Canonical USDC: the ERC-20 contract on an EVM chain, the SPL mint on Solana. */
    readonly asset: string;
  };
}

export interface EvmChainDescriptor extends ChainDescriptorBase {
  readonly family: 'evm';
  readonly chainId: number;
}

export interface SolanaChainDescriptor extends ChainDescriptorBase {
  readonly family: 'solana';
  /** Full base58 genesis hash; the CAIP-2 reference is its first 32 characters. */
  readonly genesisHash: string;
}

export type ChainDescriptor = EvmChainDescriptor | SolanaChainDescriptor;

export const USDC_DECIMALS = 6;

export const CHAINS = {
  base: {
    key: 'base', family: 'evm', chainId: BASE_MAINNET_CHAIN_ID, caip2: `eip155:${BASE_MAINNET_CHAIN_ID}`,
    privyChain: 'base', privyChainType: 'ethereum', displayName: 'Base', environment: 'production',
    usdc: { symbol: 'USDC', decimals: 6, asset: BASE_MAINNET_USDC_CONTRACT },
  },
  base_sepolia: {
    key: 'base_sepolia', family: 'evm', chainId: BASE_SEPOLIA_CHAIN_ID, caip2: `eip155:${BASE_SEPOLIA_CHAIN_ID}`,
    privyChain: 'base_sepolia', privyChainType: 'ethereum', displayName: 'Base Sepolia', environment: 'test',
    usdc: { symbol: 'USDC', decimals: 6, asset: BASE_SEPOLIA_USDC_CONTRACT },
  },
  solana: {
    key: 'solana', family: 'solana', genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    caip2: `solana:${SOLANA_MAINNET_GENESIS_HASH.slice(0, 32)}`,
    privyChain: 'solana', privyChainType: 'solana', displayName: 'Solana', environment: 'production',
    usdc: { symbol: 'USDC', decimals: 6, asset: SOLANA_MAINNET_USDC_MINT },
  },
  solana_devnet: {
    key: 'solana_devnet', family: 'solana', genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    caip2: `solana:${SOLANA_DEVNET_GENESIS_HASH.slice(0, 32)}`,
    privyChain: 'solana_devnet', privyChainType: 'solana', displayName: 'Solana Devnet', environment: 'test',
    usdc: { symbol: 'USDC', decimals: 6, asset: SOLANA_DEVNET_USDC_MINT },
  },
} as const satisfies Record<ChainKey, ChainDescriptor>;

export const ALL_CHAINS: readonly ChainDescriptor[] = CHAIN_KEYS.map((key) => CHAINS[key]);

export function chainByKey(key: string): ChainDescriptor | undefined {
  return (CHAIN_KEYS as readonly string[]).includes(key) ? CHAINS[key as ChainKey] : undefined;
}

export function chainByCaip2(caip2: string): ChainDescriptor | undefined {
  return ALL_CHAINS.find((chain) => chain.caip2 === caip2);
}

export function chainByPrivyChain(privyChain: string): ChainDescriptor | undefined {
  return ALL_CHAINS.find((chain) => chain.privyChain === privyChain);
}

export function chainByEvmChainId(chainId: number): EvmChainDescriptor | undefined {
  return ALL_CHAINS.find((chain): chain is EvmChainDescriptor => chain.family === 'evm' && chain.chainId === chainId);
}

export function isEvmChain(chain: ChainDescriptor): chain is EvmChainDescriptor {
  return chain.family === 'evm';
}

export function isSolanaChain(chain: ChainDescriptor): chain is SolanaChainDescriptor {
  return chain.family === 'solana';
}

// ---------------------------------------------------------------------------------------------
// Rails: the production chains money moves on, and the control-plane networks that bind them
// ---------------------------------------------------------------------------------------------

/** A production rail a pet wallet receives and withdraws canonical USDC on. */
export const FUNDING_CHAIN_KEYS = ['base', 'solana'] as const;
export type FundingChainKey = (typeof FUNDING_CHAIN_KEYS)[number];
/** The control-plane network a pet wallet's binding is provisioned and attested on. */
export const CONTROL_CHAIN_KEYS = ['base_sepolia', 'solana_devnet'] as const;
export type ControlChainKey = (typeof CONTROL_CHAIN_KEYS)[number];

export function isFundingChainKey(value: string): value is FundingChainKey {
  return (FUNDING_CHAIN_KEYS as readonly string[]).includes(value);
}

export function isControlChainKey(value: string): value is ControlChainKey {
  return (CONTROL_CHAIN_KEYS as readonly string[]).includes(value);
}

/**
 * The production rail a control-plane binding funds. One Privy wallet per family serves both
 * networks -- the binding is attested on the test network and receives real USDC on the production
 * one -- so the pair is fixed by family rather than configured.
 */
export function fundingChainFor(controlKey: ControlChainKey): FundingChainKey {
  return controlKey === 'solana_devnet' ? 'solana' : 'base';
}

/** The control-plane network whose binding funds this production rail. */
export function controlChainFor(fundingKey: FundingChainKey): ControlChainKey {
  return fundingKey === 'solana' ? 'solana_devnet' : 'base_sepolia';
}

// ---------------------------------------------------------------------------------------------
// Block explorers
// ---------------------------------------------------------------------------------------------

const EXPLORER_ORIGINS: Record<ChainKey, string> = {
  base: 'https://basescan.org',
  base_sepolia: 'https://sepolia.basescan.org',
  solana: 'https://solscan.io',
  solana_devnet: 'https://solscan.io',
};

function resolveChain(chain: ChainDescriptor | ChainKey): ChainDescriptor {
  const resolved = typeof chain === 'string' ? chainByKey(chain) : chain;
  if (!resolved) throw new Error(`Unknown chain ${String(chain)}`);
  return resolved;
}

function explorerUrl(chain: ChainDescriptor, path: string): string {
  // Solscan serves every cluster from one origin and picks the network from the query string.
  const cluster = chain.key === 'solana_devnet' ? '?cluster=devnet' : '';
  return `${EXPLORER_ORIGINS[chain.key]}/${path}${cluster}`;
}

/**
 * A public explorer page for one transaction. The id is validated for the chain's family before
 * it is placed in a URL, so a value that is not a transaction id there cannot become a link.
 */
export function explorerTransactionUrl(chain: ChainDescriptor | ChainKey, transactionId: string): string {
  const resolved = resolveChain(chain);
  if (!isChainTransactionId(resolved, transactionId)) throw new Error(`Invalid ${resolved.displayName} transaction id`);
  return explorerUrl(resolved, `tx/${transactionId}`);
}

/** A public explorer page for one address; Solscan calls the address page an account. */
export function explorerAddressUrl(chain: ChainDescriptor | ChainKey, address: string): string {
  const resolved = resolveChain(chain);
  if (!isChainAddress(resolved, address)) throw new Error(`Invalid ${resolved.displayName} address`);
  return explorerUrl(resolved, `${resolved.family === 'evm' ? 'address' : 'account'}/${address}`);
}

// ---------------------------------------------------------------------------------------------
// Address and transaction identity
// ---------------------------------------------------------------------------------------------

export const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
export const EVM_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
export const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/;
export const POSITIVE_ATOMIC_AMOUNT_PATTERN = /^[1-9][0-9]*$/;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SOLANA_PUBKEY_BYTES = 32;
const SOLANA_SIGNATURE_BYTES = 64;

/** Decodes Bitcoin-alphabet base58. Returns undefined for any character outside the alphabet. */
export function decodeBase58(value: string): Uint8Array | undefined {
  if (value.length === 0) return new Uint8Array(0);
  if (!BASE58_PATTERN.test(value)) return undefined;
  const bytes: number[] = [];
  for (const char of value) {
    let carry = BASE58_ALPHABET.indexOf(char);
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index]! * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of value) {
    if (char !== '1') break;
    leadingZeros += 1;
  }
  const decoded = new Uint8Array(leadingZeros + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    decoded[leadingZeros + bytes.length - 1 - index] = bytes[index]!;
  }
  return decoded;
}

export function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros += 1;
  }
  const digits: number[] = [];
  for (const byte of bytes.subarray(leadingZeros)) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index]! << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return '1'.repeat(leadingZeros) + digits.reverse().map((digit) => BASE58_ALPHABET[digit]!).join('');
}

function base58ByteLength(value: string): number | undefined {
  const decoded = decodeBase58(value);
  return decoded === undefined ? undefined : decoded.length;
}

export function isSolanaAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && base58ByteLength(value) === SOLANA_PUBKEY_BYTES;
}

export function isSolanaSignature(value: string): boolean {
  // Character bounds are only a cheap pre-check; the byte length after decoding is the rule.
  return value.length >= 64 && value.length <= 88 && base58ByteLength(value) === SOLANA_SIGNATURE_BYTES;
}

export function isChainAddress(chain: ChainDescriptor, value: string): boolean {
  return chain.family === 'evm' ? EVM_ADDRESS_PATTERN.test(value) : isSolanaAddress(value);
}

export function isChainTransactionId(chain: ChainDescriptor, value: string): boolean {
  return chain.family === 'evm' ? EVM_HASH_PATTERN.test(value) : isSolanaSignature(value);
}

/** A Solana blockhash is 32 bytes of base58: the shape of a public key, not of a signature. */
export function isSolanaBlockhash(value: string): boolean {
  return isSolanaAddress(value);
}

/**
 * Whether a value is a block identity on this chain: a 32-byte hex hash on an EVM chain, a
 * blockhash on Solana (where the scan checkpoints are slots and the hash is the slot's blockhash).
 */
export function isChainBlockHash(chain: ChainDescriptor, value: string): boolean {
  return chain.family === 'evm' ? EVM_HASH_PATTERN.test(value) : isSolanaBlockhash(value);
}

/**
 * The storage form of an address: lowercase hex for EVM (the ledger's CHECK constraints require
 * it, and hex case carries no information), unchanged for Solana (base58 is case-significant, so
 * lowercasing would turn one address into a different one).
 */
export function normalizeChainAddress(chain: ChainDescriptor, value: string): string {
  if (!isChainAddress(chain, value)) throw new Error(`Invalid ${chain.displayName} address`);
  return chain.family === 'evm' ? value.toLowerCase() : value;
}

export function sameChainAddress(chain: ChainDescriptor, left: string, right: string): boolean {
  return isChainAddress(chain, left) && isChainAddress(chain, right) &&
    normalizeChainAddress(chain, left) === normalizeChainAddress(chain, right);
}

export function isCanonicalUsdcAsset(chain: ChainDescriptor, asset: string): boolean {
  return sameChainAddress(chain, asset, chain.usdc.asset);
}

// ---------------------------------------------------------------------------------------------
// Receive URIs
// ---------------------------------------------------------------------------------------------

/**
 * A wallet-scannable request for canonical USDC to one pet wallet.
 *
 * EVM chains use EIP-681 with the token contract as the URI target and the pet wallet as the
 * `transfer(address,uint256)` recipient. Solana uses the Solana Pay transfer-request form, which
 * names the recipient's wallet and the SPL mint; the paying wallet derives the associated token
 * account itself, so no token account ever appears in the URI.
 */
export function buildUsdcReceiveUri(chain: ChainDescriptor, recipientAddress: string): string {
  if (!isChainAddress(chain, recipientAddress)) throw new Error('Invalid recipient address for USDC receive URI');
  return chain.family === 'evm'
    ? `ethereum:${chain.usdc.asset}@${chain.chainId}/transfer?address=${recipientAddress}`
    : `solana:${recipientAddress}?spl-token=${chain.usdc.asset}`;
}

// ---------------------------------------------------------------------------------------------
// USDC amounts
// ---------------------------------------------------------------------------------------------

/** Atomic (six-decimal) USDC to a decimal string with trailing zeros trimmed: '12990000' -> '12.99'. */
export function formatUsdcAtomic(value: string): string {
  if (!ATOMIC_AMOUNT_PATTERN.test(value)) throw new Error('Invalid USDC amount');
  const padded = value.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Decimal USDC with at most six fraction digits to its atomic string: '12.99' -> '12990000'. */
export function parseUsdcDecimal(value: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!match) throw new Error('Invalid USDC amount');
  const atomic = BigInt(match[1]!) * (10n ** BigInt(USDC_DECIMALS)) +
    BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0') || '0');
  return atomic.toString();
}
