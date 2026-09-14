import { CHAINS } from '@meowwa/chain-domain';
import { ERC20_TRANSFER_EVENT_ABI, ERC20_TRANSFER_EVENT_TOPIC, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN, createEvmPublicClient } from '../chain/evm.js';
import {
  ChainConfirmationPendingError,
  verifyCanonicalUsdcReceipt,
  type EvmReceipt,
  type EvmReceiptClient,
  type EvmReceiptLog,
} from '../chain/evm-receipt.js';

export { ChainConfirmationPendingError, ERC20_TRANSFER_EVENT_ABI, ERC20_TRANSFER_EVENT_TOPIC };
export type BaseSepoliaReceiptLog = EvmReceiptLog;
export type BaseSepoliaReceipt = EvmReceipt;
export type BaseSepoliaReceiptClient = EvmReceiptClient;

export interface VerifiedBaseSepoliaTransfer {
  transactionHash: `0x${string}`;
  blockHash: `0x${string}`;
  blockNumber: number;
  logIndex: number;
  confirmedAtBlock: number;
}

export interface BaseSepoliaExecutionReader {
  verifyTransfer(input: {
    transactionHash: `0x${string}`;
    sender: string;
    recipient: string;
    amountAtomic: string;
    confirmations: number;
    logIndex?: number;
  }): Promise<VerifiedBaseSepoliaTransfer>;
}

const amountPattern = /^[1-9][0-9]*$/;
const chain = CHAINS.base_sepolia;
const label = chain.displayName;

export class ChainEvidenceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainEvidenceMismatchError';
  }
}

/**
 * Independent verification of one sandbox execution: the provider said it sent a transfer, and
 * this confirms, from the chain alone, that exactly one canonical USDC transfer from the pet
 * wallet to the recipient for the exact amount is finalized in a canonical block.
 */
export class ViemBaseSepoliaExecutionReader implements BaseSepoliaExecutionReader {
  readonly #client: EvmReceiptClient;

  constructor(client: EvmReceiptClient) {
    this.#client = client;
  }

  async ready(): Promise<boolean> {
    const [chainId, blockNumber] = await Promise.all([this.#client.getChainId(), this.#client.getBlockNumber()]);
    return chainId === chain.chainId && blockNumber >= 0n;
  }

  async verifyTransfer(input: {
    transactionHash: `0x${string}`;
    sender: string;
    recipient: string;
    amountAtomic: string;
    confirmations: number;
    logIndex?: number;
  }): Promise<VerifiedBaseSepoliaTransfer> {
    if (!EVM_HASH_PATTERN.test(input.transactionHash)) throw new ChainEvidenceMismatchError(`Invalid ${label} transaction hash`);
    if (!EVM_ADDRESS_PATTERN.test(input.sender) || !EVM_ADDRESS_PATTERN.test(input.recipient)) throw new ChainEvidenceMismatchError(`Invalid ${label} transfer address`);
    if (!amountPattern.test(input.amountAtomic)) throw new ChainEvidenceMismatchError(`Invalid ${label} transfer amount`);
    if (input.logIndex !== undefined && (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0)) {
      throw new ChainEvidenceMismatchError(`Invalid ${label} transfer log index`);
    }
    const receipt = await verifyCanonicalUsdcReceipt(this.#client, {
      chain, transactionHash: input.transactionHash, confirmations: input.confirmations, minConfirmations: 1, label,
      fail: (message) => new ChainEvidenceMismatchError(message),
    });
    const sender = input.sender.toLowerCase();
    const recipient = input.recipient.toLowerCase();
    const expectedAmount = BigInt(input.amountAtomic);
    const matching = receipt.transfers.filter((transfer) =>
      transfer.from.toLowerCase() === sender && transfer.to.toLowerCase() === recipient && transfer.value === expectedAmount &&
      (input.logIndex === undefined || transfer.logIndex === input.logIndex));
    if (matching.length !== 1) throw new ChainEvidenceMismatchError(`${label} receipt does not contain exactly one expected USDC transfer`);
    return {
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      logIndex: matching[0]!.logIndex,
      confirmedAtBlock: receipt.confirmedAtBlock,
    };
  }
}

export function createViemBaseSepoliaExecutionReader(rpcUrl: string): ViemBaseSepoliaExecutionReader {
  return new ViemBaseSepoliaExecutionReader(createEvmPublicClient(chain, rpcUrl) as unknown as EvmReceiptClient);
}
