import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_USDC_CONTRACT } from '@meowwa/chain-domain';
import { ViemBaseSepoliaUsdcBalanceReader } from './balance.js';

function reader(client: { getChainId(): Promise<number>; readContract(input: unknown): Promise<unknown> }) {
  return new ViemBaseSepoliaUsdcBalanceReader(client as unknown as ConstructorParameters<typeof ViemBaseSepoliaUsdcBalanceReader>[0]);
}

describe('Base Sepolia USDC balance reader', () => {
  it('checks chain identity and reads the canonical contract', async () => {
    const readContract = vi.fn(async () => 19_996_551n);
    const balance = reader({ getChainId: async () => 84532, readContract });

    await expect(balance.balanceAtomic('0x3333333333333333333333333333333333333333')).resolves.toBe(19_996_551n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: BASE_SEPOLIA_USDC_CONTRACT, functionName: 'balanceOf' }));
  });

  it('rejects invalid addresses, the wrong chain, and malformed balances', async () => {
    await expect(reader({ getChainId: async () => 84532, readContract: async () => 0n }).balanceAtomic('bad')).rejects.toThrow('address');
    await expect(reader({ getChainId: async () => 1, readContract: async () => 0n }).balanceAtomic('0x3333333333333333333333333333333333333333')).rejects.toThrow('chain');
    await expect(reader({ getChainId: async () => 84532, readContract: async () => '0' }).balanceAtomic('0x3333333333333333333333333333333333333333')).rejects.toThrow('balance');
  });
});
