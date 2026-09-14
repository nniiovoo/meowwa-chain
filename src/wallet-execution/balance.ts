import { CHAINS } from '@meowwa/chain-domain';
import { createEvmPublicClient } from '../chain/evm.js';
import { ViemEvmUsdcBalanceReader, type EvmBalanceClient } from '../chain/evm-usdc-balance-reader.js';

export interface BaseSepoliaUsdcBalanceReader {
  balanceAtomic(address: string): Promise<bigint>;
}

/** The generic EVM balance reader pinned to the Base Sepolia sandbox. */
export class ViemBaseSepoliaUsdcBalanceReader extends ViemEvmUsdcBalanceReader implements BaseSepoliaUsdcBalanceReader {
  constructor(client: EvmBalanceClient) {
    super(client, CHAINS.base_sepolia);
  }
}

export function createViemBaseSepoliaUsdcBalanceReader(rpcUrl: string): ViemBaseSepoliaUsdcBalanceReader {
  return new ViemBaseSepoliaUsdcBalanceReader(createEvmPublicClient(CHAINS.base_sepolia, rpcUrl));
}
