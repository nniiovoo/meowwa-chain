import { getAddress, type PublicClient } from 'viem';
import { EVM_ADDRESS_PATTERN, type EvmChainDescriptor } from '@meowwa/chain-domain';
import { ERC20_BALANCE_ABI, createEvmPublicClient } from './evm.js';

export type EvmBalanceClient = Pick<PublicClient, 'getChainId' | 'readContract'>;

/**
 * Reads a wallet's canonical USDC balance on one EVM chain, at the head or pinned to a block.
 *
 * The block pin is what makes a reconciliation sweep exact: bounding the indexed net and the
 * on-chain read to the same height means neither side can be missing events the other has.
 * Reading "latest" instead races every in-flight transfer and turns ordinary indexer lag into
 * false discrepancies.
 */
export class ViemEvmUsdcBalanceReader {
  readonly #client: EvmBalanceClient;
  readonly #chain: EvmChainDescriptor;

  constructor(client: EvmBalanceClient, chain: EvmChainDescriptor) {
    this.#client = client;
    this.#chain = chain;
  }

  async balanceAtomic(address: string): Promise<bigint> {
    return this.#read(address, undefined);
  }

  async balanceAtomicAt(address: string, blockNumber: bigint): Promise<bigint> {
    if (blockNumber < 0n) throw new Error(`${this.#chain.displayName} comparison block is invalid`);
    return this.#read(address, blockNumber);
  }

  async #read(address: string, blockNumber: bigint | undefined): Promise<bigint> {
    const label = this.#chain.displayName;
    if (!EVM_ADDRESS_PATTERN.test(address)) throw new Error(`Invalid ${label} wallet address`);
    if (await this.#client.getChainId() !== this.#chain.chainId) throw new Error(`${label} chain identity mismatch`);
    const balance = await this.#client.readContract({
      address: getAddress(this.#chain.usdc.asset),
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [getAddress(address)],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    if (typeof balance !== 'bigint' || balance < 0n) throw new Error(`${label} USDC balance is invalid`);
    return balance;
  }
}

export function createViemEvmUsdcBalanceReader(rpcUrl: string, chain: EvmChainDescriptor): ViemEvmUsdcBalanceReader {
  return new ViemEvmUsdcBalanceReader(createEvmPublicClient(chain, rpcUrl), chain);
}
