import { describe, expect, it } from 'vitest';
import { CHAINS, encodeBase58 } from '@meowwa/chain-domain';
import { ViemEvmUsdcTransferReader, type EvmLogClient } from './evm-usdc-transfer-reader.js';
import { SolanaUsdcTransferReader, type SolanaRpcClient } from './solana-usdc-transfer-reader.js';
import { assertScanRange, confirmedHead, dedupeTransfers, type CheckpointingUsdcTransferReader } from './usdc-transfer-reader.js';

/**
 * The reader contract every indexer relies on, run against one reader per chain family so the
 * two cannot drift apart on ranges, identity checks or empty scans.
 */
const evmWallet = '0x1111111111111111111111111111111111111111';
const solanaWallet = encodeBase58(new Uint8Array(32).fill(0x11));

function evmReader(chainId: number): { reader: CheckpointingUsdcTransferReader<unknown>; calls: string[] } {
  const calls: string[] = [];
  const client: EvmLogClient = {
    getChainId: async () => chainId,
    getBlockNumber: async () => 500n,
    getBlock: async () => ({ hash: `0x${'b'.repeat(64)}` }),
    getLogs: async () => { calls.push('getLogs'); return []; },
  };
  return { reader: new ViemEvmUsdcTransferReader(client, { chain: CHAINS.base_sepolia, direction: 'inbound' }), calls };
}

function solanaReader(genesisHash: string): { reader: CheckpointingUsdcTransferReader<unknown>; calls: string[] } {
  const calls: string[] = [];
  const client: SolanaRpcClient = {
    getGenesisHash: async () => genesisHash,
    getSlot: async () => 500,
    // Every slot in a range was produced, except that slot 400 was skipped.
    getBlocks: async (from, to) => { calls.push('getBlocks'); return Array.from({ length: to - from + 1 }, (_, index) => from + index).filter((slot) => slot !== 400); },
    getBlock: async () => { calls.push('getBlock'); return { blockhash: solanaWallet, transactions: [] }; },
    getTokenAccountsByOwner: async () => ({ context: { slot: 500 }, value: [] }),
  };
  return { reader: new SolanaUsdcTransferReader(client, { chain: CHAINS.solana_devnet, direction: 'inbound' }), calls };
}

const families = [
  { name: 'Base Sepolia', ok: () => evmReader(84532), wrong: () => evmReader(1), wallet: evmWallet },
  { name: 'Solana devnet', ok: () => solanaReader(CHAINS.solana_devnet.genesisHash), wrong: () => solanaReader(CHAINS.solana.genesisHash), wallet: solanaWallet },
];

describe('USDC transfer reader contract', () => {
  it.each(families)('$name: reports a head, a checkpoint hash, and an empty scan through the same interface', async ({ ok, wallet }) => {
    const { reader } = ok();
    await expect(reader.latestBlockNumber()).resolves.toBe(500n);
    await expect(reader.blockHash(300n)).resolves.toMatch(/^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
    await expect(reader.getUsdcTransfers({ fromBlock: 100n, toBlock: 200n, walletAddresses: [wallet] })).resolves.toEqual([]);
  });

  // The window's last height is the checkpoint wherever a block was produced there. Where the
  // chain skipped it (Solana slot 400 in the fixture), the checkpoint is the last block below,
  // so what the indexer records can always be read back and compared.
  it.each(families)('$name: names the last produced block at or below the window end as the checkpoint', async ({ ok, name }) => {
    const { reader } = ok();
    const hash = /^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
    await expect(reader.checkpointAt(300n)).resolves.toEqual({ blockNumber: 300n, blockHash: expect.stringMatching(hash) });
    await expect(reader.checkpointAt(400n)).resolves.toEqual({
      blockNumber: name === 'Solana devnet' ? 399n : 400n, blockHash: expect.stringMatching(hash),
    });
  });

  it.each(families)('$name: fails closed on the wrong network before any read', async ({ wrong, wallet }) => {
    const { reader, calls } = wrong();
    await expect(reader.latestBlockNumber()).rejects.toThrow(/chain identity/i);
    await expect(reader.blockHash(1n)).rejects.toThrow(/chain identity/i);
    await expect(reader.checkpointAt(1n)).rejects.toThrow(/chain identity/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 100n, toBlock: 200n, walletAddresses: [wallet] })).rejects.toThrow(/chain identity/i);
    expect(calls).toEqual([]);
  });

  it.each(families)('$name: bounds a scan and skips the RPC for an empty wallet set', async ({ ok, wallet }) => {
    const { reader, calls } = ok();
    await expect(reader.getUsdcTransfers({ fromBlock: 201n, toBlock: 200n, walletAddresses: [wallet] })).rejects.toThrow(/range/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 0n, toBlock: 1999n, walletAddresses: [wallet] })).rejects.toThrow(/exceeds/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 0n, toBlock: 1998n, walletAddresses: [] })).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('computes the conservative confirmed head and refuses a zero depth', () => {
    expect(confirmedHead(100n, 12)).toBe(88n);
    expect(confirmedHead(5n, 12)).toBeUndefined();
    expect(() => confirmedHead(100n, 0)).toThrow(/confirmations/i);
  });

  it('accepts a repeated identical transfer and refuses two different transfers with one identity', () => {
    expect(assertScanRange('X', 0n, 1998n)).toBeUndefined();
    const a = { id: 'tx:1', amount: '5' };
    expect(dedupeTransfers('X', [a, { ...a }], (item) => item.id)).toEqual([a]);
    expect(() => dedupeTransfers('X', [a, { id: 'tx:1', amount: '6' }], (item) => item.id)).toThrow(/conflicting/i);
  });
});
