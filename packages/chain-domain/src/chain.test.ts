import { describe, expect, it } from 'vitest';
import {
  ALL_CHAINS,
  CHAINS,
  CONTROL_CHAIN_KEYS,
  FUNDING_CHAIN_KEYS,
  BASE_MAINNET_USDC_CONTRACT,
  BASE_SEPOLIA_USDC_CONTRACT,
  SOLANA_DEVNET_USDC_MINT,
  SOLANA_MAINNET_USDC_MINT,
  buildUsdcReceiveUri,
  chainByCaip2,
  chainByEvmChainId,
  chainByKey,
  chainByPrivyChain,
  controlChainFor,
  decodeBase58,
  encodeBase58,
  explorerAddressUrl,
  explorerTransactionUrl,
  formatUsdcAtomic,
  fundingChainFor,
  isCanonicalUsdcAsset,
  isChainAddress,
  isChainBlockHash,
  isChainTransactionId,
  isControlChainKey,
  isFundingChainKey,
  isSolanaAddress,
  isSolanaBlockhash,
  isSolanaSignature,
  normalizeChainAddress,
  parseUsdcDecimal,
  sameChainAddress,
} from './index.js';

const evmWallet = '0x1111111111111111111111111111111111111111';
const evmHash = `0x${'a'.repeat(64)}`;
// The System Program id (32 zero bytes) and a 64-zero-byte signature: valid shapes with no key material.
const solanaWallet = '1'.repeat(32);
const solanaSignature = '1'.repeat(64);

// One fixture per chain family; every shape test below runs against both so a rule that only
// holds for hex addresses cannot pass unnoticed.
const fixtures = [
  { chain: CHAINS.base, address: evmWallet, transactionId: evmHash, foreignAddress: solanaWallet, foreignTransactionId: solanaSignature },
  { chain: CHAINS.base_sepolia, address: evmWallet, transactionId: evmHash, foreignAddress: solanaWallet, foreignTransactionId: solanaSignature },
  { chain: CHAINS.solana, address: SOLANA_MAINNET_USDC_MINT, transactionId: solanaSignature, foreignAddress: evmWallet, foreignTransactionId: evmHash },
  { chain: CHAINS.solana_devnet, address: SOLANA_DEVNET_USDC_MINT, transactionId: solanaSignature, foreignAddress: evmWallet, foreignTransactionId: evmHash },
] as const;

describe('chain registry', () => {
  it('names every supported network exactly once with the identifiers providers use', () => {
    expect(ALL_CHAINS.map((chain) => chain.key)).toEqual(['base', 'base_sepolia', 'solana', 'solana_devnet']);
    expect(new Set(ALL_CHAINS.map((chain) => chain.caip2)).size).toBe(ALL_CHAINS.length);
    expect(new Set(ALL_CHAINS.map((chain) => chain.privyChain)).size).toBe(ALL_CHAINS.length);
    expect(CHAINS.base).toMatchObject({ family: 'evm', chainId: 8453, caip2: 'eip155:8453', privyChainType: 'ethereum', environment: 'production' });
    expect(CHAINS.base_sepolia).toMatchObject({ family: 'evm', chainId: 84532, caip2: 'eip155:84532', environment: 'test' });
    // CAIP-2 references are the first 32 characters of the genesis hash; these are the published values.
    expect(CHAINS.solana).toMatchObject({ family: 'solana', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', privyChainType: 'solana', environment: 'production' });
    expect(CHAINS.solana_devnet).toMatchObject({ family: 'solana', caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', environment: 'test' });
    expect(CHAINS.base.usdc.asset).toBe(BASE_MAINNET_USDC_CONTRACT);
    expect(CHAINS.base_sepolia.usdc.asset).toBe(BASE_SEPOLIA_USDC_CONTRACT);
    for (const chain of ALL_CHAINS) expect(chain.usdc).toMatchObject({ symbol: 'USDC', decimals: 6 });
  });

  it('resolves a chain from any provider-facing identifier and refuses unknown ones', () => {
    expect(chainByKey('solana_devnet')).toBe(CHAINS.solana_devnet);
    expect(chainByCaip2('eip155:84532')).toBe(CHAINS.base_sepolia);
    expect(chainByPrivyChain('base')).toBe(CHAINS.base);
    expect(chainByEvmChainId(8453)).toBe(CHAINS.base);
    expect(chainByKey('ethereum')).toBeUndefined();
    expect(chainByCaip2('eip155:1')).toBeUndefined();
    expect(chainByPrivyChain('solana_testnet')).toBeUndefined();
    expect(chainByEvmChainId(1)).toBeUndefined();
    // Resolving by key must not fall through to Object.prototype.
    expect(chainByKey('constructor')).toBeUndefined();
  });

  it.each(fixtures)('validates $chain.key addresses and transaction ids by family, not by hex shape', ({ chain, address, transactionId, foreignAddress, foreignTransactionId }) => {
    expect(isChainAddress(chain, address)).toBe(true);
    expect(isChainAddress(chain, foreignAddress)).toBe(false);
    expect(isChainAddress(chain, '')).toBe(false);
    expect(isChainTransactionId(chain, transactionId)).toBe(true);
    expect(isChainTransactionId(chain, foreignTransactionId)).toBe(false);
    expect(isChainTransactionId(chain, address)).toBe(false);
    expect(isCanonicalUsdcAsset(chain, chain.usdc.asset)).toBe(true);
    expect(isCanonicalUsdcAsset(chain, foreignAddress)).toBe(false);
    expect(sameChainAddress(chain, address, address)).toBe(true);
    expect(() => normalizeChainAddress(chain, foreignAddress)).toThrow(/address/i);
  });

  it.each(fixtures)('tells a $chain.key block hash apart from a transaction id by family', ({ chain, address, transactionId, foreignAddress, foreignTransactionId }) => {
    // An EVM block hash has a transaction hash's shape; a Solana blockhash has a public key's.
    const blockHash = chain.family === 'evm' ? transactionId : address;
    const foreignBlockHash = chain.family === 'evm' ? foreignAddress : foreignTransactionId;
    expect(isChainBlockHash(chain, blockHash)).toBe(true);
    expect(isChainBlockHash(chain, foreignBlockHash)).toBe(false);
    expect(isChainBlockHash(chain, '')).toBe(false);
    if (chain.family === 'solana') {
      expect(isChainBlockHash(chain, transactionId)).toBe(false);
      expect(isSolanaBlockhash(address)).toBe(true);
      expect(isSolanaBlockhash(transactionId)).toBe(false);
    }
  });

  it('pairs each production rail with the control network whose binding funds it', () => {
    expect(FUNDING_CHAIN_KEYS).toEqual(['base', 'solana']);
    expect(CONTROL_CHAIN_KEYS).toEqual(['base_sepolia', 'solana_devnet']);
    expect(fundingChainFor('base_sepolia')).toBe('base');
    expect(fundingChainFor('solana_devnet')).toBe('solana');
    expect(controlChainFor('base')).toBe('base_sepolia');
    expect(controlChainFor('solana')).toBe('solana_devnet');
    // The pairing is an involution within one family, and never crosses families.
    for (const controlKey of CONTROL_CHAIN_KEYS) {
      expect(controlChainFor(fundingChainFor(controlKey))).toBe(controlKey);
      expect(CHAINS[fundingChainFor(controlKey)].family).toBe(CHAINS[controlKey].family);
      expect(CHAINS[fundingChainFor(controlKey)].environment).toBe('production');
      expect(CHAINS[controlKey].environment).toBe('test');
    }
    expect(isFundingChainKey('base')).toBe(true);
    expect(isFundingChainKey('solana')).toBe(true);
    expect(isFundingChainKey('base_sepolia')).toBe(false);
    expect(isControlChainKey('solana_devnet')).toBe(true);
    expect(isControlChainKey('solana')).toBe(false);
    expect(isFundingChainKey('constructor')).toBe(false);
    expect(isControlChainKey('')).toBe(false);
  });

  it('links to each network\'s public explorer, by descriptor or by key', () => {
    expect(explorerTransactionUrl(CHAINS.base, evmHash)).toBe(`https://basescan.org/tx/${evmHash}`);
    expect(explorerAddressUrl('base', evmWallet)).toBe(`https://basescan.org/address/${evmWallet}`);
    expect(explorerTransactionUrl('base_sepolia', evmHash)).toBe(`https://sepolia.basescan.org/tx/${evmHash}`);
    expect(explorerAddressUrl(CHAINS.base_sepolia, evmWallet)).toBe(`https://sepolia.basescan.org/address/${evmWallet}`);
    expect(explorerTransactionUrl(CHAINS.solana, solanaSignature)).toBe(`https://solscan.io/tx/${solanaSignature}`);
    expect(explorerAddressUrl('solana', solanaWallet)).toBe(`https://solscan.io/account/${solanaWallet}`);
    expect(explorerTransactionUrl('solana_devnet', solanaSignature)).toBe(`https://solscan.io/tx/${solanaSignature}?cluster=devnet`);
    expect(explorerAddressUrl(CHAINS.solana_devnet, solanaWallet)).toBe(`https://solscan.io/account/${solanaWallet}?cluster=devnet`);
    // A value that is not an id on that chain never becomes a link, and case is preserved as given.
    expect(() => explorerTransactionUrl('base', solanaSignature)).toThrow(/transaction id/i);
    expect(() => explorerAddressUrl('solana', evmWallet)).toThrow(/address/i);
    expect(() => explorerAddressUrl('base', evmHash)).toThrow(/address/i);
    expect(() => explorerTransactionUrl('ethereum' as never, evmHash)).toThrow(/unknown chain/i);
    expect(explorerAddressUrl('base', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe('https://basescan.org/address/0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('lowercases EVM addresses for storage but never touches case-significant base58', () => {
    expect(normalizeChainAddress(CHAINS.base, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(sameChainAddress(CHAINS.base, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(normalizeChainAddress(CHAINS.solana, SOLANA_MAINNET_USDC_MINT)).toBe(SOLANA_MAINNET_USDC_MINT);
    expect(isSolanaAddress(SOLANA_MAINNET_USDC_MINT.toLowerCase())).toBe(false);
    expect(sameChainAddress(CHAINS.solana, SOLANA_MAINNET_USDC_MINT, SOLANA_DEVNET_USDC_MINT)).toBe(false);
  });

  it('round-trips base58 and rejects characters outside the alphabet', () => {
    for (const value of [SOLANA_MAINNET_USDC_MINT, SOLANA_DEVNET_USDC_MINT, CHAINS.solana.genesisHash, solanaWallet]) {
      const decoded = decodeBase58(value);
      expect(decoded).toHaveLength(32);
      expect(encodeBase58(decoded!)).toBe(value);
    }
    expect(encodeBase58(new Uint8Array([0, 0, 1]))).toBe('112');
    expect(decodeBase58('112')).toEqual(new Uint8Array([0, 0, 1]));
    expect(encodeBase58(new Uint8Array(0))).toBe('');
    expect(decodeBase58('0OIl')).toBeUndefined();
    expect(isSolanaAddress(`${SOLANA_MAINNET_USDC_MINT}1`)).toBe(false);
    expect(isSolanaSignature(solanaWallet)).toBe(false);
    expect(isSolanaSignature(solanaSignature)).toBe(true);
    const fullSignature = encodeBase58(new Uint8Array(64).fill(255));
    expect(fullSignature).toHaveLength(88);
    expect(isSolanaSignature(fullSignature)).toBe(true);
    expect(isSolanaSignature(`${fullSignature}1`)).toBe(false);
    expect(isSolanaSignature(fullSignature.slice(0, 60))).toBe(false);
  });

  it('builds a wallet-scannable USDC request in each family\'s own URI standard', () => {
    expect(buildUsdcReceiveUri(CHAINS.base_sepolia, evmWallet)).toBe(`ethereum:${BASE_SEPOLIA_USDC_CONTRACT}@84532/transfer?address=${evmWallet}`);
    expect(buildUsdcReceiveUri(CHAINS.base, evmWallet)).toBe(`ethereum:${BASE_MAINNET_USDC_CONTRACT}@8453/transfer?address=${evmWallet}`);
    expect(buildUsdcReceiveUri(CHAINS.solana_devnet, solanaWallet)).toBe(`solana:${solanaWallet}?spl-token=${SOLANA_DEVNET_USDC_MINT}`);
    expect(buildUsdcReceiveUri(CHAINS.solana, solanaWallet)).toBe(`solana:${solanaWallet}?spl-token=${SOLANA_MAINNET_USDC_MINT}`);
    expect(() => buildUsdcReceiveUri(CHAINS.solana, evmWallet)).toThrow(/recipient address/i);
    expect(() => buildUsdcReceiveUri(CHAINS.base, solanaWallet)).toThrow(/recipient address/i);
  });

  it('converts USDC between atomic and decimal without precision loss', () => {
    expect(formatUsdcAtomic('12990000')).toBe('12.99');
    expect(formatUsdcAtomic('1000000')).toBe('1');
    expect(formatUsdcAtomic('1')).toBe('0.000001');
    expect(formatUsdcAtomic('0')).toBe('0');
    expect(formatUsdcAtomic('1234567891234')).toBe('1234567.891234');
    expect(formatUsdcAtomic((2n ** 64n).toString())).toBe('18446744073709.551616');
    expect(parseUsdcDecimal('12.990000')).toBe('12990000');
    expect(parseUsdcDecimal('0.5')).toBe('500000');
    expect(parseUsdcDecimal('0')).toBe('0');
    expect(() => parseUsdcDecimal('0.0000001')).toThrow('Invalid USDC amount');
    expect(() => parseUsdcDecimal('1.')).toThrow('Invalid USDC amount');
    expect(() => formatUsdcAtomic('01')).toThrow('Invalid USDC amount');
    expect(() => formatUsdcAtomic('-1')).toThrow('Invalid USDC amount');
  });
});
