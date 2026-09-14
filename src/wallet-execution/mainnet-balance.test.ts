import { describe, expect, it, vi } from 'vitest';
import { BASE_MAINNET_USDC } from '../funding/config.js';
import { ViemBaseUsdcBalanceReader } from './mainnet-balance.js';
import { getAddress } from 'viem';

function reader(client: { getChainId(): Promise<number>; readContract(input: unknown): Promise<unknown> }) {
  return new ViemBaseUsdcBalanceReader(client as unknown as ConstructorParameters<typeof ViemBaseUsdcBalanceReader>[0]);
}

describe('Base mainnet USDC balance-at-block reader', () => {
  it('checks chain identity and reads the canonical contract at the exact comparison block', async () => {
    const readContract = vi.fn(async () => 7_500_000n);
    const balance = reader({ getChainId: async () => 8453, readContract });

    await expect(balance.balanceAtomicAt('0x3333333333333333333333333333333333333333', 2_000n))
      .resolves.toBe(7_500_000n);
    // The block pin is the point: reading "latest" would race in-flight transfers and turn
    // ordinary indexer lag into false discrepancies.
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: getAddress(BASE_MAINNET_USDC), functionName: 'balanceOf', blockNumber: 2_000n,
    }));
  });

  it('rejects invalid addresses, blocks, the wrong chain, and malformed balances', async () => {
    const wallet = '0x3333333333333333333333333333333333333333';
    await expect(reader({ getChainId: async () => 8453, readContract: async () => 0n }).balanceAtomicAt('bad', 1n)).rejects.toThrow('address');
    await expect(reader({ getChainId: async () => 8453, readContract: async () => 0n }).balanceAtomicAt(wallet, -1n)).rejects.toThrow('block');
    await expect(reader({ getChainId: async () => 1, readContract: async () => 0n }).balanceAtomicAt(wallet, 1n)).rejects.toThrow('chain');
    await expect(reader({ getChainId: async () => 8453, readContract: async () => '0' }).balanceAtomicAt(wallet, 1n)).rejects.toThrow('balance');
  });
});
