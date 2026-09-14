import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import { ViemBaseSepoliaReceiveChainReader, type BaseSepoliaReceiveRpcLog } from './receive-chain.js';

const wallet = '0x1111111111111111111111111111111111111111' as const;
const sender = '0x2222222222222222222222222222222222222222' as const;
const transactionHash = `0x${'a'.repeat(64)}` as const;
const blockHash = `0x${'b'.repeat(64)}` as const;

function rpcLog(overrides: Partial<BaseSepoliaReceiveRpcLog> = {}): BaseSepoliaReceiveRpcLog {
  return {
    address: BASE_SEPOLIA_USDC,
    args: { from: sender, to: wallet, value: 12_500_000n },
    blockNumber: 100n,
    blockHash,
    transactionHash,
    logIndex: 4,
    removed: false,
    ...overrides,
  };
}

describe('Base Sepolia receive chain reader', () => {
  it('reads only canonical inbound USDC logs and preserves ordered transfer identity', async () => {
    const getLogs = vi.fn(async () => [rpcLog()]);
    const reader = new ViemBaseSepoliaReceiveChainReader({
      getChainId: async () => 84532,
      getBlockNumber: async () => 112n,
      getBlock: async () => ({ hash: blockHash }),
      getLogs,
    }, BASE_SEPOLIA_USDC);

    await expect(reader.latestBlockNumber()).resolves.toBe(112n);
    await expect(reader.blockHash(100n)).resolves.toBe(blockHash);
    await expect(reader.getUsdcTransfers({ fromBlock: 1n, toBlock: 100n, walletAddresses: [wallet] })).resolves.toEqual([{
      chainId: 84532, transactionHash, logIndex: 4, blockNumber: 100, blockHash,
      from: sender, to: wallet, amountAtomic: '12500000', removed: false,
    }]);
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: BASE_SEPOLIA_USDC, fromBlock: 1n, toBlock: 100n, args: { to: [wallet] },
    }));
  });

  it.each([
    rpcLog({ address: sender }),
    rpcLog({ removed: true }),
    rpcLog({ args: { from: sender, to: 'not-an-address', value: 1n } }),
    rpcLog({ args: { from: sender, to: wallet, value: 0n } }),
    rpcLog({ blockHash: null }),
  ])('rejects untrusted or incomplete receive logs', async (log) => {
    const reader = new ViemBaseSepoliaReceiveChainReader({
      getChainId: async () => 84532,
      getBlockNumber: async () => 112n,
      getLogs: async () => [log],
    }, BASE_SEPOLIA_USDC);
    await expect(reader.getUsdcTransfers({ fromBlock: 1n, toBlock: 100n, walletAddresses: [wallet] })).rejects.toThrow();
  });

  it('fails closed on wrong chain and invalid ranges without querying logs', async () => {
    const getLogs = vi.fn(async () => []);
    const reader = new ViemBaseSepoliaReceiveChainReader({ getChainId: async () => 8453, getBlockNumber: async () => 0n, getLogs }, BASE_SEPOLIA_USDC);
    await expect(reader.latestBlockNumber()).rejects.toThrow(/chain identity/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 101n, toBlock: 100n, walletAddresses: [wallet] })).rejects.toThrow(/range/i);
    await expect(reader.getUsdcTransfers({ fromBlock: 1n, toBlock: 2n, walletAddresses: [] })).resolves.toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });
});
