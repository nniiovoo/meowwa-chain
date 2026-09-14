import { describe, expect, it, vi } from 'vitest';
import { CHAINS, SOLANA_DEVNET_USDC_MINT, encodeBase58 } from '@meowwa/chain-domain';
import { SolanaUsdcBalanceReader, createSolanaUsdcBalanceReader, type SolanaBalanceRpcClient } from './solana-usdc-balance-reader.js';
import { SOLANA_TOKEN_PROGRAM_ID, createSolanaRpcClient, type SolanaParsedTokenAccount } from './solana-usdc-transfer-reader.js';

const key = (fill: number): string => encodeBase58(new Uint8Array(32).fill(fill));

const chain = CHAINS.solana_devnet;
const owner = key(0x11);
const associatedAccount = key(0x12);
const adHocAccount = key(0x13);
const otherOwner = key(0x22);
const otherMint = key(0x99);

function tokenAccount(overrides: {
  pubkey?: string; owner?: string; mint?: string; amount?: string; decimals?: number;
  program?: string; programOwner?: string; type?: string;
} = {}): SolanaParsedTokenAccount {
  return {
    pubkey: overrides.pubkey ?? associatedAccount,
    account: {
      owner: overrides.programOwner ?? SOLANA_TOKEN_PROGRAM_ID,
      data: {
        program: overrides.program ?? 'spl-token',
        parsed: {
          type: overrides.type ?? 'account',
          info: {
            mint: overrides.mint ?? SOLANA_DEVNET_USDC_MINT,
            owner: overrides.owner ?? owner,
            state: 'initialized',
            tokenAmount: { amount: overrides.amount ?? '2500000', decimals: overrides.decimals ?? 6, uiAmount: 2.5, uiAmountString: '2.5' },
          },
        },
      },
    },
  };
}

function client(overrides: Partial<SolanaBalanceRpcClient> = {}, accounts: SolanaParsedTokenAccount[] = [tokenAccount()], slot = 1000): SolanaBalanceRpcClient {
  return {
    getGenesisHash: async () => chain.genesisHash,
    getTokenAccountsByOwner: vi.fn(async () => ({ context: { slot }, value: accounts })),
    ...overrides,
  };
}

describe('Solana USDC balance reader', () => {
  it('reads the finalized balance for the canonical mint and reports the slot it is the state of', async () => {
    const rpc = client();
    const reader = new SolanaUsdcBalanceReader(rpc, chain);
    await expect(reader.balanceAtomicFinalized(owner)).resolves.toEqual({ amountAtomic: 2_500_000n, slot: 1000 });
    expect(rpc.getTokenAccountsByOwner).toHaveBeenCalledWith(
      owner, { mint: SOLANA_DEVNET_USDC_MINT }, { commitment: 'finalized', encoding: 'jsonParsed' },
    );
    expect(reader.chain).toBe(chain);
  });

  it('sums every token account the owner holds for the mint, and reads zero for an owner with none', async () => {
    const two = new SolanaUsdcBalanceReader(client({}, [
      tokenAccount(), tokenAccount({ pubkey: adHocAccount, amount: '750000' }),
    ], 2000), chain);
    await expect(two.balanceAtomicFinalized(owner)).resolves.toEqual({ amountAtomic: 3_250_000n, slot: 2000 });

    const none = new SolanaUsdcBalanceReader(client({}, [], 42), chain);
    await expect(none.balanceAtomicFinalized(owner)).resolves.toEqual({ amountAtomic: 0n, slot: 42 });
  });

  it.each([
    ['a look-alike mint', tokenAccount({ mint: otherMint })],
    ['an account owned by someone else', tokenAccount({ owner: otherOwner })],
    ['an account under a different token program', tokenAccount({ programOwner: key(0x55) })],
    ['data the RPC could not parse', { pubkey: associatedAccount, account: { owner: SOLANA_TOKEN_PROGRAM_ID, data: ['AAAA', 'base64'] } }],
    ['a parsed record that is not a token account', tokenAccount({ type: 'mint' })],
    ['a non-USDC decimal scale', tokenAccount({ decimals: 9 })],
    ['a malformed amount', tokenAccount({ amount: '1.5' })],
  ])('refuses %s instead of returning a smaller balance', async (_, entry) => {
    const reader = new SolanaUsdcBalanceReader(client({}, [tokenAccount({ pubkey: adHocAccount }), entry]), chain);
    await expect(reader.balanceAtomicFinalized(owner)).rejects.toThrow(/canonical USDC account/i);
  });

  it('treats a duplicated account or a read without a slot as an invalid read', async () => {
    const duplicated = new SolanaUsdcBalanceReader(client({}, [tokenAccount(), tokenAccount()]), chain);
    await expect(duplicated.balanceAtomicFinalized(owner)).rejects.toThrow(/invalid/i);
    const slotless = new SolanaUsdcBalanceReader(client({
      getTokenAccountsByOwner: async () => ({ context: { slot: -1 }, value: [] }),
    }), chain);
    await expect(slotless.balanceAtomicFinalized(owner)).rejects.toThrow(/invalid/i);
  });

  it('rejects a foreign address and an RPC on a different network before reading any account', async () => {
    const getTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    const reader = new SolanaUsdcBalanceReader(client({ getTokenAccountsByOwner }), chain);
    await expect(reader.balanceAtomicFinalized('0x1111111111111111111111111111111111111111')).rejects.toThrow(/address/i);
    const foreign = new SolanaUsdcBalanceReader(client({ getGenesisHash: async () => CHAINS.solana.genesisHash, getTokenAccountsByOwner }), chain);
    await expect(foreign.balanceAtomicFinalized(owner)).rejects.toThrow(/chain identity/i);
    expect(getTokenAccountsByOwner).not.toHaveBeenCalled();
  });

  it('speaks getTokenAccountsByOwner over the plain JSON-RPC transport with the chain\'s canonical mint', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number };
      if (body.method === 'getGenesisHash') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: CHAINS.solana.genesisHash }));
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: body.id,
        result: { context: { slot: 7 }, value: [tokenAccount({ mint: CHAINS.solana.usdc.asset, amount: '5' })] },
      }));
    });
    const reader = new SolanaUsdcBalanceReader(createSolanaRpcClient('https://rpc.example.test', fetchImpl as unknown as typeof fetch), CHAINS.solana);
    await expect(reader.balanceAtomicFinalized(owner)).resolves.toEqual({ amountAtomic: 5n, slot: 7 });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      jsonrpc: '2.0', method: 'getTokenAccountsByOwner',
      params: [owner, { mint: CHAINS.solana.usdc.asset }, { commitment: 'finalized', encoding: 'jsonParsed' }],
    });
    // The factory pins the reader to the chain it is given, mint included.
    expect(createSolanaUsdcBalanceReader('https://rpc.example.test', CHAINS.solana).chain).toBe(CHAINS.solana);
  });
});
