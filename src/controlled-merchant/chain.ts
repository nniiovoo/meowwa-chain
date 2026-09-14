import { lstatSync, readFileSync } from 'node:fs';
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_CONTRACT, CHAINS } from '@meowwa/chain-domain';
import { ERC20_TRANSFER_ABI, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN, createEvmPublicClient } from '../chain/evm.js';
import { receiptConfirmed, verifyCanonicalUsdcReceipt, type EvmReceipt, type EvmReceiptLog } from '../chain/evm-receipt.js';
import type {
  ControlledMerchantPaymentReader,
  ControlledMerchantRefundExecutor,
  PreparedMerchantRefundTransaction,
  VerifiedMerchantPayment,
} from './types.js';

const addressPattern = EVM_ADDRESS_PATTERN;
const hashPattern = EVM_HASH_PATTERN;
const amountPattern = /^[1-9][0-9]*$/;

export type ControlledMerchantChainReceipt = EvmReceipt;
export type ControlledMerchantChainLog = EvmReceiptLog;

export interface ControlledMerchantChainClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: string; number: bigint; timestamp: bigint }>;
  getTransactionReceipt(input: { hash: `0x${string}` }): Promise<ControlledMerchantChainReceipt>;
  getTransactionCount(input: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
  estimateFeesPerGas(input: { type: 'eip1559' }): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  estimateGas(input: { account: `0x${string}`; to: `0x${string}`; data: Hex; value: bigint }): Promise<bigint>;
  sendRawTransaction(input: { serializedTransaction: Hex }): Promise<`0x${string}`>;
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid ${label}`);
  return Number(value);
}

function validConfirmations(confirmations: number): void {
  if (!Number.isSafeInteger(confirmations) || confirmations < 2 || confirmations > 100) {
    throw new Error('Invalid controlled merchant confirmation depth');
  }
}

const confirmed = receiptConfirmed;

export class ViemControlledMerchantPaymentReader implements ControlledMerchantPaymentReader {
  readonly #client: ControlledMerchantChainClient;

  constructor(client: ControlledMerchantChainClient) { this.#client = client; }

  async ready(): Promise<boolean> {
    const [chainId, blockNumber] = await Promise.all([this.#client.getChainId(), this.#client.getBlockNumber()]);
    return chainId === BASE_SEPOLIA_CHAIN_ID && blockNumber >= 0n;
  }

  async verifyPayment(input: {
    transactionHash: `0x${string}`;
    recipient: `0x${string}`;
    amountAtomic: string;
    confirmations: number;
  }): Promise<VerifiedMerchantPayment> {
    if (!hashPattern.test(input.transactionHash)) throw new Error('Invalid controlled merchant payment hash');
    if (!addressPattern.test(input.recipient)) throw new Error('Invalid controlled merchant payment recipient');
    if (!amountPattern.test(input.amountAtomic)) throw new Error('Invalid controlled merchant payment amount');
    validConfirmations(input.confirmations);
    const receipt = await verifyCanonicalUsdcReceipt(this.#client, {
      chain: CHAINS.base_sepolia, transactionHash: input.transactionHash, confirmations: input.confirmations, minConfirmations: 2,
      label: 'Controlled merchant payment', fail: (message) => new Error(message),
    });
    if (receipt.blockTimestamp === undefined) throw new Error('Controlled merchant payment block timestamp is unavailable');
    const blockTimestampMs = safeNumber(receipt.blockTimestamp, 'controlled merchant payment block timestamp') * 1_000;
    if (!Number.isSafeInteger(blockTimestampMs)) throw new Error('Invalid controlled merchant payment block timestamp');
    const recipient = getAddress(input.recipient);
    const amount = BigInt(input.amountAtomic);
    const transfers = receipt.transfers.filter((transfer) => transfer.to === recipient && transfer.value === amount);
    if (transfers.length !== 1) throw new Error('Controlled merchant payment must contain exactly one canonical USDC transfer');
    return {
      sender: transfers[0]!.from.toLowerCase() as `0x${string}`,
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: new Date(blockTimestampMs).toISOString(),
      logIndex: transfers[0]!.logIndex,
    };
  }
}

export class ViemControlledMerchantRefundExecutor implements ControlledMerchantRefundExecutor {
  readonly #client: ControlledMerchantChainClient;
  readonly #account: LocalAccount;
  readonly #confirmations: number;

  constructor(options: { client: ControlledMerchantChainClient; account: LocalAccount; confirmations: number }) {
    validConfirmations(options.confirmations);
    this.#client = options.client;
    this.#account = options.account;
    this.#confirmations = options.confirmations;
  }

  get address(): `0x${string}` { return this.#account.address.toLowerCase() as `0x${string}`; }

  async ready(): Promise<boolean> {
    const [chainId, blockNumber] = await Promise.all([this.#client.getChainId(), this.#client.getBlockNumber()]);
    return chainId === BASE_SEPOLIA_CHAIN_ID && blockNumber >= 0n;
  }

  async prepareRefund(input: { recipient: `0x${string}`; amountAtomic: string }): Promise<PreparedMerchantRefundTransaction> {
    if (!addressPattern.test(input.recipient)) throw new Error('Invalid controlled merchant refund recipient');
    if (!amountPattern.test(input.amountAtomic)) throw new Error('Invalid controlled merchant refund amount');
    if (await this.#client.getChainId() !== BASE_SEPOLIA_CHAIN_ID) throw new Error('Controlled merchant Base Sepolia chain mismatch');
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [getAddress(input.recipient), BigInt(input.amountAtomic)],
    });
    const [nonce, fees, gas] = await Promise.all([
      this.#client.getTransactionCount({ address: this.address, blockTag: 'pending' }),
      this.#client.estimateFeesPerGas({ type: 'eip1559' }),
      this.#client.estimateGas({ account: this.address, to: BASE_SEPOLIA_USDC_CONTRACT, data, value: 0n }),
    ]);
    if (!Number.isSafeInteger(nonce) || nonce < 0 || gas < 21_000n || gas > 200_000n ||
      fees.maxFeePerGas < fees.maxPriorityFeePerGas || fees.maxFeePerGas > 100_000_000_000n ||
      fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > 10_000_000_000n) {
      throw new Error('Controlled merchant refund fee or nonce estimate is invalid');
    }
    const serializedTransaction = await this.#account.signTransaction({
      chainId: BASE_SEPOLIA_CHAIN_ID,
      type: 'eip1559',
      to: BASE_SEPOLIA_USDC_CONTRACT,
      data,
      value: 0n,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return {
      transactionHash: keccak256(serializedTransaction),
      serializedTransaction,
    };
  }

  async broadcastAndConfirm(input: PreparedMerchantRefundTransaction): Promise<'pending' | 'confirmed' | 'failed'> {
    if (!hashPattern.test(input.transactionHash) || !/^0x[0-9a-fA-F]+$/.test(input.serializedTransaction) ||
      keccak256(input.serializedTransaction) !== input.transactionHash.toLowerCase()) {
      throw new Error('Controlled merchant signed refund transaction identity mismatch');
    }
    if (await this.#client.getChainId() !== BASE_SEPOLIA_CHAIN_ID) throw new Error('Controlled merchant Base Sepolia chain mismatch');
    let receipt = await this.#receipt(input.transactionHash);
    if (!receipt) {
      try {
        const broadcastHash = await this.#client.sendRawTransaction({ serializedTransaction: input.serializedTransaction });
        if (broadcastHash.toLowerCase() !== input.transactionHash.toLowerCase()) {
          throw new Error('Controlled merchant refund broadcast hash mismatch');
        }
      } catch (error) {
        receipt = await this.#receipt(input.transactionHash);
        if (!receipt) throw error;
      }
      receipt ??= await this.#receipt(input.transactionHash);
    }
    if (!receipt) return 'pending';
    if (!hashPattern.test(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase() ||
      !hashPattern.test(receipt.blockHash)) throw new Error('Controlled merchant refund receipt identity mismatch');
    const latest = await this.#client.getBlockNumber();
    if (!confirmed(receipt.blockNumber, latest, this.#confirmations)) return 'pending';
    const block = await this.#client.getBlock({ blockNumber: receipt.blockNumber });
    if (!block || block.number !== receipt.blockNumber || !hashPattern.test(block.hash) ||
        block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error('Controlled merchant refund block identity is not canonical');
    }
    return receipt.status === 'success' ? 'confirmed' : 'failed';
  }

  async #receipt(transactionHash: `0x${string}`): Promise<ControlledMerchantChainReceipt | undefined> {
    try { return await this.#client.getTransactionReceipt({ hash: transactionHash }); }
    catch { return undefined; }
  }
}

export function loadControlledMerchantAccount(keyPath: string): LocalAccount {
  const file = lstatSync(keyPath);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) throw new Error('Controlled merchant key file must be a regular mode-0600 file');
  if (file.size < 64 || file.size > 256) throw new Error('Controlled merchant key file size is invalid');
  const privateKey = readFileSync(keyPath, 'utf8').trim();
  if (!EVM_HASH_PATTERN.test(privateKey)) throw new Error('Controlled merchant key file must contain one hex private key');
  return privateKeyToAccount(privateKey as `0x${string}`);
}

export function createControlledMerchantChain(rpcUrl: string, account: LocalAccount, confirmations: number): {
  paymentReader: ViemControlledMerchantPaymentReader;
  refundExecutor: ViemControlledMerchantRefundExecutor;
} {
  const client = createEvmPublicClient(CHAINS.base_sepolia, rpcUrl) as unknown as ControlledMerchantChainClient;
  return {
    paymentReader: new ViemControlledMerchantPaymentReader(client),
    refundExecutor: new ViemControlledMerchantRefundExecutor({ client, account, confirmations }),
  };
}
