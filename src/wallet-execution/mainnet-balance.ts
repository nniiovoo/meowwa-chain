import { CHAINS } from '@meowwa/chain-domain';
import { createEvmPublicClient } from '../chain/evm.js';
import { ViemEvmUsdcBalanceReader, type EvmBalanceClient } from '../chain/evm-usdc-balance-reader.js';

/** The generic EVM balance reader pinned to Base mainnet, for the reconciliation sweep's block-pinned read. */
export class ViemBaseUsdcBalanceReader extends ViemEvmUsdcBalanceReader {
  constructor(client: EvmBalanceClient) {
    super(client, CHAINS.base);
  }
}

export function createViemBaseUsdcBalanceReader(rpcUrl: string): ViemBaseUsdcBalanceReader {
  return new ViemBaseUsdcBalanceReader(createEvmPublicClient(CHAINS.base, rpcUrl));
}
