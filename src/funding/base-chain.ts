import { CHAINS } from '@meowwa/chain-domain';
import { createEvmPublicClient } from '../chain/evm.js';
import {
  ViemEvmUsdcTransferReader,
  type EvmLogClient,
  type EvmRpcLog,
  type EvmUsdcTransfer,
} from '../chain/evm-usdc-transfer-reader.js';
import { confirmedHead, type UsdcTransferReader } from '../chain/usdc-transfer-reader.js';
import type { EvmAddress } from './types.js';

/**
 * The Base mainnet funding reader: canonical USDC credits and debits for production pet wallets.
 * It is the generic EVM reader pinned to one chain; the names below are what the financial worker
 * and its tests have always imported.
 */
export { confirmedHead };
export type BaseRpcLog = EvmRpcLog;
export type BaseLogClient = EvmLogClient;
export type BaseUsdcTransfer = EvmUsdcTransfer<typeof CHAINS.base.chainId>;

export interface CheckpointedBaseChainReader extends UsdcTransferReader<BaseUsdcTransfer> {
  blockHash(blockNumber: bigint): Promise<`0x${string}`>;
  getUsdcTransfers(input: { fromBlock: bigint; toBlock: bigint; walletAddresses: EvmAddress[] }): Promise<BaseUsdcTransfer[]>;
}

export class ViemBaseChainReader extends ViemEvmUsdcTransferReader<typeof CHAINS.base.chainId> implements CheckpointedBaseChainReader {
  constructor(client: BaseLogClient, usdcContract: EvmAddress) {
    super(client, { chain: CHAINS.base, usdcContract, direction: 'both' });
  }
}

export function createViemBaseChainReader(rpcUrl: string, usdcContract: EvmAddress): ViemBaseChainReader {
  return new ViemBaseChainReader(createEvmPublicClient(CHAINS.base, rpcUrl) as unknown as BaseLogClient, usdcContract);
}
