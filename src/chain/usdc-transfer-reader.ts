/**
 * What an indexer needs from any chain, whatever the chain calls its units.
 *
 * "Block number" is the chain's monotonic height: an EVM block number, a Solana slot. "Block hash"
 * is the identity of the block at that height, which the indexer checkpoints so a later scan can
 * notice the chain it recorded is no longer the chain the RPC serves. Transfers carry the fields
 * the ledger keys on; the per-family shapes below add what each chain can prove about position.
 */
export interface UsdcTransferReader<Transfer> {
  latestBlockNumber(): Promise<bigint>;
  blockHash(blockNumber: bigint): Promise<string>;
  getUsdcTransfers(input: { fromBlock: bigint; toBlock: bigint; walletAddresses: string[] }): Promise<Transfer[]>;
}

/** The block a scan window ends on: its height and the identity of the block produced there. */
export interface ChainCheckpoint {
  blockNumber: bigint;
  blockHash: string;
}

/**
 * A reader that can name the checkpoint for a scan window. Not every height has a block: an EVM
 * chain produces one at every number, but Solana skips slots, and a window that ends on a skipped
 * slot has no block to checkpoint. `checkpointAt(toBlock)` answers with the last block produced at
 * or below `toBlock` — `toBlock` itself on EVM — so the indexer records evidence that exists.
 */
export interface CheckpointingUsdcTransferReader<Transfer> extends UsdcTransferReader<Transfer> {
  checkpointAt(toBlock: bigint): Promise<ChainCheckpoint>;
}

/** Head minus the confirmation depth, or nothing while the chain is shorter than the depth. */
export function confirmedHead(latestBlock: bigint, confirmations: number): bigint | undefined {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('Chain confirmations must be a positive integer');
  const depth = BigInt(confirmations);
  return latestBlock >= depth ? latestBlock - depth : undefined;
}

/** A read scan is bounded so one RPC call cannot be asked for an unbounded log set. */
export const MAX_SCAN_RANGE = 1_999n;

export function assertScanRange(label: string, fromBlock: bigint, toBlock: bigint): void {
  if (fromBlock < 0n || toBlock < fromBlock) throw new Error(`${label} scan range is invalid`);
  if (toBlock - fromBlock >= MAX_SCAN_RANGE) throw new Error(`${label} scan range exceeds ${MAX_SCAN_RANGE.toLocaleString('en-US')} blocks`);
}

/**
 * Two RPC responses can name the same transfer; two different transfers can never share an
 * identity. Anything else is an RPC that contradicts itself, which is not evidence.
 */
export function dedupeTransfers<Transfer>(label: string, transfers: Transfer[], identity: (transfer: Transfer) => string): Transfer[] {
  const unique = new Map<string, Transfer>();
  for (const transfer of transfers) {
    const key = identity(transfer);
    const prior = unique.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(transfer)) throw new Error(`${label} RPC returned conflicting transfer logs`);
    unique.set(key, transfer);
  }
  return [...unique.values()];
}
