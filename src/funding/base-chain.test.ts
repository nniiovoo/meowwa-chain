import { describe, expect, it, vi } from 'vitest';
import { BASE_MAINNET_USDC } from './config.js';
import { ViemBaseChainReader, confirmedHead, type BaseRpcLog } from './base-chain.js';

const wallet = '0x1111111111111111111111111111111111111111' as const;
const sender = '0x2222222222222222222222222222222222222222' as const;
const transactionHash = `0x${'a'.repeat(64)}` as const;
const blockHash = `0x${'b'.repeat(64)}` as const;

function rpcLog(overrides: Partial<BaseRpcLog> = {}): BaseRpcLog {
  return {
    address: BASE_MAINNET_USDC,
    args: { from: sender, to: wallet, value: 2_500_000n },
    blockNumber: 1000n,
    blockHash,
    transactionHash,
    logIndex: 4,
    removed: false,
    ...overrides,
  };
}

describe('Base USDC chain reader', () => {
  it('computes the conservative confirmed head', () => {
    expect(confirmedHead(100n, 12)).toBe(88n);
    expect(confirmedHead(5n, 12)).toBeUndefined();
    expect(() => confirmedHead(100n, 0)).toThrow(/confirmations/i);
  });

  it('queries indexed sender and recipient logs, deduplicates them, and preserves bigint values', async () => {
    const getLogs = vi.fn(async (input: { args: Record<string, unknown> }) => input.args.to ? [rpcLog()] : [rpcLog()]);
    const getBlock = vi.fn(async () => ({ hash: blockHash }));
    const reader = new ViemBaseChainReader({ getChainId: async () => 8453, getBlockNumber: async () => 1012n, getBlock, getLogs }, BASE_MAINNET_USDC);
    await expect(reader.latestBlockNumber()).resolves.toBe(1012n);
    await expect(reader.blockHash(1000n)).resolves.toBe(blockHash);
    await expect(reader.getUsdcTransfers({ fromBlock: 900n, toBlock: 1000n, walletAddresses: [wallet] })).resolves.toEqual([{
      chainId: 8453, transactionHash, logIndex: 4, blockNumber: 1000, blockHash,
      from: sender, to: wallet, amountAtomic: '2500000', removed: false,
    }]);
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ address: BASE_MAINNET_USDC, fromBlock: 900n, toBlock: 1000n, args: { to: [wallet] } });
    expect(getLogs.mock.calls[1]?.[0]).toMatchObject({ address: BASE_MAINNET_USDC, fromBlock: 900n, toBlock: 1000n, args: { from: [wallet] } });
  });

  it('rejects log data from an RPC connected to a different chain', async () => {
    const getLogs = vi.fn(async () => [rpcLog()]);
    const client = {
      getChainId: vi.fn(async () => 1),
      getBlockNumber: vi.fn(async () => 1012n),
      getLogs,
    };
    const reader = new ViemBaseChainReader(client, BASE_MAINNET_USDC);

    await expect(reader.getUsdcTransfers({
      fromBlock: 900n, toBlock: 1000n, walletAddresses: [wallet],
    })).rejects.toThrow(/chain identity/i);
    expect(client.getChainId).toHaveBeenCalledOnce();
    expect(getLogs).not.toHaveBeenCalled();
  });

  it.each([
    rpcLog({ address: sender }),
    rpcLog({ removed: true }),
    rpcLog({ args: { from: sender, to: 'not-an-address', value: 1n } }),
    rpcLog({ args: { from: sender, to: wallet, value: 0n } }),
    rpcLog({ blockHash: null }),
  ])('rejects untrusted or incomplete RPC logs', async (log) => {
    const reader = new ViemBaseChainReader({ getChainId: async () => 8453, getBlockNumber: async () => 1012n, getLogs: async () => [log] }, BASE_MAINNET_USDC);
    await expect(reader.getUsdcTransfers({ fromBlock: 900n, toBlock: 1000n, walletAddresses: [wallet] })).rejects.toThrow();
  });

  it('rejects invalid scan ranges and empty wallet sets without making RPC calls', async () => {
    const getLogs = vi.fn(async () => []);
    const reader = new ViemBaseChainReader({ getChainId: async () => 8453, getBlockNumber: async () => 0n, getLogs }, BASE_MAINNET_USDC);
    await expect(reader.getUsdcTransfers({ fromBlock: 1001n, toBlock: 1000n, walletAddresses: [wallet] })).rejects.toThrow(/range/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 1n, toBlock: 2n, walletAddresses: [] })).resolves.toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });
});
