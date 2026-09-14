import { BASE_SEPOLIA_USDC_CONTRACT, CHAINS } from '@meowwa/chain-domain';
import { createEvmPublicClient } from '../chain/evm.js';
import {
  ViemEvmUsdcTransferReader,
  type EvmLogClient,
  type EvmRpcLog,
  type EvmUsdcTransfer,
} from '../chain/evm-usdc-transfer-reader.js';
import type { UsdcTransferReader } from '../chain/usdc-transfer-reader.js';
import type { EvmAddress } from '../funding/types.js';

/**
 * The Base Sepolia sandbox receive reader: inbound canonical test-USDC only, for the POC ledger.
 * Same generic EVM reader as the mainnet funding indexer, pinned to the sandbox chain and to the
 * inbound direction.
 */
export type BaseSepoliaReceiveRpcLog = EvmRpcLog;
export type BaseSepoliaReceiveLogClient = EvmLogClient;
export type BaseSepoliaReceiveTransfer = EvmUsdcTransfer<typeof CHAINS.base_sepolia.chainId>;

export interface BaseSepoliaReceiveChainReader extends UsdcTransferReader<BaseSepoliaReceiveTransfer> {
  blockHash(blockNumber: bigint): Promise<`0x${string}`>;
  getUsdcTransfers(input: { fromBlock: bigint; toBlock: bigint; walletAddresses: EvmAddress[] }): Promise<BaseSepoliaReceiveTransfer[]>;
}

export class ViemBaseSepoliaReceiveChainReader extends ViemEvmUsdcTransferReader<typeof CHAINS.base_sepolia.chainId> implements BaseSepoliaReceiveChainReader {
  constructor(client: BaseSepoliaReceiveLogClient, usdcContract: EvmAddress = BASE_SEPOLIA_USDC_CONTRACT) {
    super(client, { chain: CHAINS.base_sepolia, usdcContract, direction: 'inbound' });
  }
}

export function createViemBaseSepoliaReceiveChainReader(rpcUrl: string, usdcContract: EvmAddress = BASE_SEPOLIA_USDC_CONTRACT): ViemBaseSepoliaReceiveChainReader {
  return new ViemBaseSepoliaReceiveChainReader(createEvmPublicClient(CHAINS.base_sepolia, rpcUrl) as unknown as BaseSepoliaReceiveLogClient, usdcContract);
}
