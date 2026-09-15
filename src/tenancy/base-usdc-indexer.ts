import { CHAINS } from '@meowwa/chain-domain';
import type { CheckpointingUsdcTransferReader } from '../chain/usdc-transfer-reader.js';
import type { BaseUsdcTransfer, CheckpointedBaseChainReader } from '../funding/base-chain.js';
import type { EvmAddress } from '../funding/types.js';
import {
  TenantChainReorgDetectedError,
  TenantUsdcIndexer,
  TenantUsdcIndexingWorker,
  evmUsdcTransferAdapter,
  type TenantUsdcIndexerRepository,
} from './usdc-indexer.js';

/**
 * The Base mainnet funding indexer: the generic rail indexer pinned to CHAINS.base with the EVM
 * adapter. These are the names the financial worker and its tests have always imported; the
 * behaviour lives in ./usdc-indexer.ts, where a second rail is one more descriptor and adapter.
 */
export type TenantBaseUsdcIndexerRepository = TenantUsdcIndexerRepository;

/** Kept under its Base name for callers that predate the second rail; the checkpoint now names its rail. */
export { TenantChainReorgDetectedError as TenantBaseReorgDetectedError };

/**
 * A Base reader that may predate `checkpointAt`. Every EVM height has a block, so a window's last
 * block is its own checkpoint, and the hash read is the one the reader already exposes.
 */
function checkpointing(reader: CheckpointedBaseChainReader): CheckpointingUsdcTransferReader<BaseUsdcTransfer> {
  const candidate = reader as CheckpointedBaseChainReader & Partial<CheckpointingUsdcTransferReader<BaseUsdcTransfer>>;
  if (typeof candidate.checkpointAt === 'function') return candidate as CheckpointingUsdcTransferReader<BaseUsdcTransfer>;
  return {
    latestBlockNumber: () => reader.latestBlockNumber(),
    blockHash: (blockNumber) => reader.blockHash(blockNumber),
    getUsdcTransfers: (input) => reader.getUsdcTransfers({ ...input, walletAddresses: input.walletAddresses as EvmAddress[] }),
    checkpointAt: async (toBlock) => ({ blockNumber: toBlock, blockHash: await reader.blockHash(toBlock) }),
  };
}

export class TenantBaseUsdcIndexer extends TenantUsdcIndexer<BaseUsdcTransfer> {
  constructor(options: {
    repository: TenantBaseUsdcIndexerRepository;
    chain: CheckpointedBaseChainReader;
    usdcContract: EvmAddress;
    confirmations: number;
    scanStartBlock: number;
    walletPageSize?: number;
    maxWallets?: number;
    now?: () => Date;
  }) {
    const { chain, usdcContract, ...rest } = options;
    super({
      ...rest,
      chain: CHAINS.base,
      reader: checkpointing(chain),
      adapter: evmUsdcTransferAdapter(CHAINS.base),
      usdcAsset: usdcContract,
    });
  }
}

export class TenantBaseUsdcIndexingWorker extends TenantUsdcIndexingWorker {}
