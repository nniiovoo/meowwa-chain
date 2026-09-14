import { describe, expect, it, vi } from 'vitest';
import { CHAINS, SOLANA_DEVNET_USDC_MINT, encodeBase58 } from '@meowwa/chain-domain';
import {
  SOLANA_TOKEN_PROGRAM_ID,
  SolanaUsdcTransferReader,
  createSolanaRpcClient,
  type SolanaBlock,
  type SolanaBlockTransaction,
  type SolanaRpcClient,
} from './solana-usdc-transfer-reader.js';

const key = (fill: number): string => encodeBase58(new Uint8Array(32).fill(fill));
const signatureOf = (fill: number): string => encodeBase58(new Uint8Array(64).fill(fill));

const chain = CHAINS.solana_devnet;
const wallet = key(0x11);
const walletUsdcAccount = key(0x12);
const sender = key(0x22);
const senderUsdcAccount = key(0x23);
const otherMint = key(0x99);
const otherMintAccount = key(0x98);
const signature = signatureOf(0xaa);
const blockhash = key(0xbb);

function tokenBalance(accountIndex: number, owner: string, mint: string = SOLANA_DEVNET_USDC_MINT) {
  return { accountIndex, mint, owner, uiTokenAmount: { amount: '0', decimals: 6 } };
}

function transferChecked(source: string, destination: string, amount: string, mint: string = SOLANA_DEVNET_USDC_MINT) {
  return {
    program: 'spl-token', programId: SOLANA_TOKEN_PROGRAM_ID,
    parsed: { type: 'transferChecked', info: { source, destination, mint, authority: sender, tokenAmount: { amount, decimals: 6 } } },
  };
}

function transfer(source: string, destination: string, amount: string) {
  return { program: 'spl-token', programId: SOLANA_TOKEN_PROGRAM_ID, parsed: { type: 'transfer', info: { source, destination, authority: sender, amount } } };
}

function transaction(overrides: Partial<SolanaBlockTransaction> & { instructions?: SolanaBlockTransaction['transaction']['message']['instructions'] } = {}): SolanaBlockTransaction {
  const { instructions, ...rest } = overrides;
  return {
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [sender, senderUsdcAccount, walletUsdcAccount, otherMintAccount, SOLANA_TOKEN_PROGRAM_ID],
        instructions: instructions ?? [transferChecked(senderUsdcAccount, walletUsdcAccount, '2500000')],
      },
    },
    meta: {
      err: null,
      preTokenBalances: [tokenBalance(1, sender), tokenBalance(2, wallet), tokenBalance(3, sender, otherMint)],
      postTokenBalances: [tokenBalance(1, sender), tokenBalance(2, wallet), tokenBalance(3, sender, otherMint)],
      innerInstructions: [],
    },
    ...rest,
  };
}

function block(transactions: SolanaBlockTransaction[] = [transaction()]): SolanaBlock {
  return { blockhash, transactions };
}

function client(overrides: Partial<SolanaRpcClient> = {}): SolanaRpcClient {
  return {
    getGenesisHash: async () => chain.genesisHash,
    getSlot: async () => 1012,
    getBlocks: async (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index),
    getBlock: async () => block(),
    getTokenAccountsByOwner: async () => ({ context: { slot: 1012 }, value: [] }),
    ...overrides,
  };
}

const expectedCredit = {
  chainKey: 'solana_devnet', caip2: chain.caip2, signature, transactionIndex: 0, instructionIndex: 0, slot: 1000, blockhash,
  from: sender, to: wallet, fromTokenAccount: senderUsdcAccount, toTokenAccount: walletUsdcAccount, amountAtomic: '2500000',
};

describe('Solana USDC transfer reader', () => {
  it('reads finalized canonical USDC credits by owner and reports slot and blockhash as position', async () => {
    const getBlock = vi.fn(async () => block());
    const getBlocks = vi.fn(async () => [1000]);
    const reader = new SolanaUsdcTransferReader(client({ getBlock, getBlocks }), { chain, direction: 'inbound' });
    await expect(reader.latestBlockNumber()).resolves.toBe(1012n);
    await expect(reader.blockHash(1000n)).resolves.toBe(blockhash);
    await expect(reader.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).resolves.toEqual([expectedCredit]);
    expect(getBlocks).toHaveBeenCalledWith(1000, 1000, { commitment: 'finalized' });
    expect(getBlock).toHaveBeenCalledWith(1000, expect.objectContaining({ commitment: 'finalized', encoding: 'jsonParsed', transactionDetails: 'full' }));
  });

  it('credits a transfer without a mint field and a CPI inner instruction through the token-balance owner map', async () => {
    const inner = transaction({
      instructions: [{ program: 'some-router', programId: key(0x77) }],
      meta: {
        err: null,
        preTokenBalances: [tokenBalance(1, sender), tokenBalance(2, wallet)],
        postTokenBalances: [tokenBalance(1, sender), tokenBalance(2, wallet)],
        innerInstructions: [{ index: 0, instructions: [transfer(senderUsdcAccount, walletUsdcAccount, '750000')] }],
      },
    });
    const reader = new SolanaUsdcTransferReader(client({ getBlocks: async () => [1000], getBlock: async () => block([inner]) }), { chain, direction: 'inbound' });
    await expect(reader.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).resolves.toEqual([
      { ...expectedCredit, instructionIndex: 1, amountAtomic: '750000' },
    ]);
  });

  it('reads the wallet\'s own outflows only when asked for both directions', async () => {
    const outflow = transaction({ instructions: [transferChecked(walletUsdcAccount, senderUsdcAccount, '100')] });
    const both = new SolanaUsdcTransferReader(client({ getBlocks: async () => [1000], getBlock: async () => block([outflow]) }), { chain, direction: 'both' });
    const inbound = new SolanaUsdcTransferReader(client({ getBlocks: async () => [1000], getBlock: async () => block([outflow]) }), { chain, direction: 'inbound' });
    await expect(both.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).resolves.toEqual([
      { ...expectedCredit, from: wallet, to: sender, fromTokenAccount: walletUsdcAccount, toTokenAccount: senderUsdcAccount, amountAtomic: '100' },
    ]);
    await expect(inbound.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).resolves.toEqual([]);
  });

  it.each([
    ['a failed transaction', transaction({ meta: { err: { InstructionError: [0, 'Custom'] }, preTokenBalances: [], postTokenBalances: [] } })],
    ['a look-alike mint', transaction({ instructions: [transferChecked(otherMintAccount, walletUsdcAccount, '1', otherMint)] })],
    ['a transfer to an untracked owner', transaction({ instructions: [transferChecked(walletUsdcAccount, senderUsdcAccount, '1')] })],
    ['a token instruction that is not a transfer', transaction({ instructions: [{ program: 'spl-token', programId: SOLANA_TOKEN_PROGRAM_ID, parsed: { type: 'approve', info: { source: walletUsdcAccount, amount: '1' } } }] })],
    ['a transfer under a different token program', transaction({ instructions: [{ ...transferChecked(senderUsdcAccount, walletUsdcAccount, '1'), programId: key(0x55) }] })],
  ])('ignores %s', async (_, entry) => {
    const reader = new SolanaUsdcTransferReader(client({ getBlocks: async () => [1000], getBlock: async () => block([entry]) }), { chain, direction: 'inbound' });
    await expect(reader.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).resolves.toEqual([]);
  });

  it.each([
    ['a zero amount', transaction({ instructions: [transferChecked(senderUsdcAccount, walletUsdcAccount, '0')] })],
    ['a transfer whose source owner is unknown', transaction({ meta: { err: null, preTokenBalances: [tokenBalance(2, wallet)], postTokenBalances: [tokenBalance(2, wallet)] } })],
    ['a malformed signature', transaction({ transaction: { signatures: ['nope'], message: { accountKeys: [], instructions: [] } } })],
    ['a token balance outside the account list', transaction({ meta: { err: null, preTokenBalances: [tokenBalance(40, wallet)], postTokenBalances: [] } })],
  ])('refuses %s instead of guessing', async (_, entry) => {
    const reader = new SolanaUsdcTransferReader(client({ getBlocks: async () => [1000], getBlock: async () => block([entry]) }), { chain, direction: 'inbound' });
    await expect(reader.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).rejects.toThrow();
  });

  it('rejects an RPC connected to a different network before reading any block', async () => {
    const getBlocks = vi.fn(async () => [1000]);
    const rpc = client({ getGenesisHash: async () => CHAINS.solana.genesisHash, getBlocks });
    const reader = new SolanaUsdcTransferReader(rpc, { chain, direction: 'inbound' });
    await expect(reader.latestBlockNumber()).rejects.toThrow(/chain identity/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).rejects.toThrow(/chain identity/i);
    expect(getBlocks).not.toHaveBeenCalled();
  });

  it('checkpoints the last produced slot at or below a window end that was skipped', async () => {
    // Slots 1001 and 1002 were skipped: a leader missed its turn, so the numbers exist but no
    // block does. A checkpoint must name a block the chain can serve again later.
    const produced = new Set([998, 999, 1000, 1003]);
    const getBlocks = vi.fn(async (from: number, to: number) => [...produced].filter((slot) => slot >= from && slot <= to).sort((a, b) => a - b));
    const getBlock = vi.fn(async () => block());
    const reader = new SolanaUsdcTransferReader(client({ getBlocks, getBlock }), { chain, direction: 'inbound' });
    await expect(reader.checkpointAt(1002n)).resolves.toEqual({ blockNumber: 1000n, blockHash: blockhash });
    await expect(reader.checkpointAt(1003n)).resolves.toEqual({ blockNumber: 1003n, blockHash: blockhash });
    expect(getBlocks).toHaveBeenCalledTimes(2);
    expect(getBlock).toHaveBeenCalledWith(1000, expect.objectContaining({ commitment: 'finalized' }));
    expect(getBlock).toHaveBeenCalledWith(1003, expect.objectContaining({ commitment: 'finalized' }));
  });

  it('walks back through scan-sized ranges when the window end sits in a long skipped stretch', async () => {
    const getBlocks = vi.fn(async (from: number, to: number) => (from <= 500 && 500 <= to ? [500] : []));
    const reader = new SolanaUsdcTransferReader(client({ getBlocks }), { chain, direction: 'inbound' });
    await expect(reader.checkpointAt(3000n)).resolves.toEqual({ blockNumber: 500n, blockHash: blockhash });
    // A short range first, then full ranges, never overlapping and never below slot 0.
    const ranges = getBlocks.mock.calls.map(([from, to]) => [from, to]);
    expect(ranges[0]).toEqual([2937, 3000]);
    expect(ranges.every(([from, to], index) => from! >= 0 && to! >= from! && (index === 0 || to! === ranges[index - 1]![0]! - 1))).toBe(true);
    expect(ranges.at(-1)).toEqual([0, 937]);
  });

  it('refuses a checkpoint the RPC cannot ground: no block within the lookback, or slots outside the asked range', async () => {
    const empty = new SolanaUsdcTransferReader(client({ getBlocks: async () => [] }), { chain, direction: 'inbound' });
    await expect(empty.checkpointAt(10n)).rejects.toThrow(/no finalized block/i);
    await expect(empty.checkpointAt(-1n)).rejects.toThrow(/invalid/i);
    const outside = new SolanaUsdcTransferReader(client({ getBlocks: async () => [2000] }), { chain, direction: 'inbound' });
    await expect(outside.checkpointAt(1000n)).rejects.toThrow(/outside the checkpoint range/i);
    const foreign = new SolanaUsdcTransferReader(client({ getGenesisHash: async () => CHAINS.solana.genesisHash }), { chain, direction: 'inbound' });
    await expect(foreign.checkpointAt(1000n)).rejects.toThrow(/chain identity/i);
  });

  it('treats a finalized slot the RPC cannot serve or returns out of range as an error, not a gap', async () => {
    const missing = new SolanaUsdcTransferReader(client({ getBlocks: async () => [1000], getBlock: async () => null }), { chain, direction: 'inbound' });
    await expect(missing.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1000n, walletAddresses: [wallet] })).rejects.toThrow(/unavailable/i);
    const outside = new SolanaUsdcTransferReader(client({ getBlocks: async () => [1000, 1003] }), { chain, direction: 'inbound' });
    await expect(outside.getUsdcTransfers({ fromBlock: 1000n, toBlock: 1002n, walletAddresses: [wallet] })).rejects.toThrow(/outside the scan range/i);
  });

  it('rejects invalid ranges, foreign addresses and empty wallet sets without making RPC calls', async () => {
    const getBlocks = vi.fn(async () => []);
    const reader = new SolanaUsdcTransferReader(client({ getBlocks }), { chain, direction: 'inbound' });
    await expect(reader.getUsdcTransfers({ fromBlock: 1001n, toBlock: 1000n, walletAddresses: [wallet] })).rejects.toThrow(/range/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 1n, toBlock: 3000n, walletAddresses: [wallet] })).rejects.toThrow(/range/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 1n, toBlock: 2n, walletAddresses: ['0x1111111111111111111111111111111111111111'] })).rejects.toThrow(/address/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 1n, toBlock: 2n, walletAddresses: [] })).resolves.toEqual([]);
    expect(getBlocks).not.toHaveBeenCalled();
  });

  it('refuses a non-canonical or malformed mint at construction', () => {
    expect(() => new SolanaUsdcTransferReader(client(), { chain, usdcMint: otherMint, direction: 'inbound' })).toThrow(/canonical/i);
    expect(() => new SolanaUsdcTransferReader(client(), { chain, usdcMint: '0xabc', direction: 'inbound' })).toThrow(/invalid/i);
    expect(() => new SolanaUsdcTransferReader(client(), { chain: CHAINS.solana, usdcMint: SOLANA_DEVNET_USDC_MINT, direction: 'inbound' })).toThrow(/canonical/i);
  });

  it('speaks plain JSON-RPC and surfaces RPC errors instead of empty results', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number };
      if (body.method === 'getSlot') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 42 }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32004, message: 'Block not available' } }));
    });
    const rpc = createSolanaRpcClient('https://rpc.example.test', fetchImpl as unknown as typeof fetch);
    await expect(rpc.getSlot({ commitment: 'finalized' })).resolves.toBe(42);
    await expect(rpc.getBlock(7, { commitment: 'finalized', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0, rewards: false }))
      .rejects.toThrow(/Block not available/);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ jsonrpc: '2.0', method: 'getSlot', params: [{ commitment: 'finalized' }] });
  });
});
