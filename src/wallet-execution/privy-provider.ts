import { formatRequestForAuthorizationSignature, type PrivyClient } from '@privy-io/node';
import { CHAINS, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN, sameChainAddress, type EvmChainDescriptor } from '@meowwa/chain-domain';
import { decodeFunctionData, getAddress } from 'viem';
import {
  ERC20_TRANSFER_ABI,
  formatUsdcAmountAtomic,
  parseUsdcAmountAtomic,
  PRIVY_USDC_ASSET,
} from '../wallet-control/policy.js';
import type {
  WalletExecutionProvider,
  WalletExecutionProviderInput,
  WalletExecutionProviderResult,
  WalletExecutionProviderStatus,
  WalletExecutionProviderTransaction,
  WalletExecutionStatusProvider,
} from './provider.js';

interface PrivyWalletExecutionApiInput {
  walletId: string;
  caip2: string;
  referenceId: string;
  recipient: string;
  amountAtomic: string;
  sign(payload: Uint8Array): Promise<string>;
}

interface PrivyWalletExecutionApiResult {
  actionId: string;
  status: string;
  type: string;
  walletId: string;
  sourceChain: string;
  sourceAsset: string | null;
  sourceAmount: string | null;
  destinationAddress: string;
}

export interface PrivyWalletExecutionApi {
  sendTransaction(input: PrivyWalletExecutionApiInput): Promise<PrivyWalletExecutionApiResult>;
}

interface PrivyWalletActionStep {
  type: string;
  caip2: string | null;
  status: string;
  transactionHash: string | null;
  bundleTransactionHash: string | null;
  userOperationHash: string | null;
}

interface PrivyWalletActionStatusApiResult {
  id: string;
  status: string;
  type: string;
  walletId: string;
  sourceChain: string;
  sourceAsset: string | null;
  sourceAmount: string | null;
  destinationAddress: string;
  steps: PrivyWalletActionStep[];
}

export interface PrivyWalletActionStatusApi {
  getAction(providerTransactionId: string, providerWalletId: string): Promise<PrivyWalletActionStatusApiResult>;
}

const identifierPattern = /^[A-Za-z0-9_-]{3,255}$/;
const hashPattern = EVM_HASH_PATTERN;
const addressPattern = EVM_ADDRESS_PATTERN;
const referencePattern = /^mw_[a-f0-9]{61}$/;
const calldataPattern = /^0x[a-fA-F0-9]{136}$/;
const actionStatuses = new Set(['pending', 'succeeded', 'rejected', 'failed']);

function validateTransferCalldata(calldata: `0x${string}`): { recipient: string; amountAtomic: string } {
  if (!calldataPattern.test(calldata)) throw new Error('Invalid execution calldata');
  let decoded: ReturnType<typeof decodeFunctionData<typeof ERC20_TRANSFER_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: calldata });
  } catch {
    throw new Error('Invalid execution calldata');
  }
  if (decoded.functionName !== 'transfer' || decoded.args.length !== 2) {
    throw new Error('Invalid execution calldata');
  }
  const [recipient, amount] = decoded.args;
  try {
    if (getAddress(recipient) === getAddress('0x0000000000000000000000000000000000000000') || amount <= 0n) {
      throw new Error('Invalid execution calldata');
    }
  } catch {
    throw new Error('Invalid execution calldata');
  }
  return { recipient: getAddress(recipient).toLowerCase(), amountAtomic: amount.toString() };
}

function optionalHash(value: string): `0x${string}` | null {
  if (value === '') return null;
  if (!hashPattern.test(value)) throw new Error('Privy returned an invalid transaction hash');
  return value.toLowerCase() as `0x${string}`;
}

function exactActionIdentity(action: {
  walletId: string;
  sourceChain: string;
  sourceAsset: string | null;
  sourceAmount: string | null;
  destinationAddress: string;
}, expected: { walletId: string; recipient: string; amountAtomic: string; chain: EvmChainDescriptor }): boolean {
  let sourceAmountAtomic: string;
  try { sourceAmountAtomic = parseUsdcAmountAtomic(action.sourceAmount ?? ''); } catch { return false; }
  return action.walletId === expected.walletId && action.sourceChain === expected.chain.privyChain &&
    action.sourceAsset === PRIVY_USDC_ASSET && sourceAmountAtomic === expected.amountAtomic &&
    action.destinationAddress.toLowerCase() === expected.recipient.toLowerCase();
}

/**
 * Submits one ABI-encoded ERC-20 transfer through Privy's chain-agnostic transfer action. The
 * chain is a constructor parameter rather than a constant so the same provider serves any EVM
 * network the registry knows; the intent encoding stays EVM-specific, which is why a Solana
 * execution provider would be a sibling class, not another parameter here.
 */
export class PrivyWalletExecutionProvider implements WalletExecutionProvider {
  readonly #api: PrivyWalletExecutionApi;
  readonly #chain: EvmChainDescriptor;

  constructor(api: PrivyWalletExecutionApi, chain: EvmChainDescriptor = CHAINS.base_sepolia) {
    this.#api = api;
    this.#chain = chain;
  }

  async submit(input: WalletExecutionProviderInput): Promise<WalletExecutionProviderResult> {
    if (!identifierPattern.test(input.embeddedWalletId)) throw new Error('Invalid embedded wallet ID');
    if (!addressPattern.test(input.smartWalletAddress)) throw new Error('Invalid smart wallet address');
    if (input.caip2 !== this.#chain.caip2) throw new Error('Invalid execution chain');
    if (!sameChainAddress(this.#chain, input.contract, this.#chain.usdc.asset)) throw new Error('Invalid execution token');
    const transfer = validateTransferCalldata(input.calldata);
    if (!referencePattern.test(input.referenceId)) throw new Error('Invalid execution reference');

    const response = await this.#api.sendTransaction({
      walletId: input.embeddedWalletId,
      caip2: this.#chain.caip2,
      referenceId: input.referenceId,
      recipient: transfer.recipient,
      amountAtomic: transfer.amountAtomic,
      sign: input.sign,
    });
    if (!identifierPattern.test(response.actionId) || !actionStatuses.has(response.status) || response.type !== 'transfer' ||
      !exactActionIdentity(response, {
        walletId: input.embeddedWalletId,
        recipient: transfer.recipient,
        amountAtomic: transfer.amountAtomic,
        chain: this.#chain,
      })) throw new Error('Privy returned an invalid transfer action');
    return {
      providerTransactionId: response.actionId,
      transactionHash: null,
      userOperationHash: null,
    };
  }
}

export class PrivyWalletExecutionStatusProvider implements WalletExecutionStatusProvider {
  readonly #api: PrivyWalletActionStatusApi;
  readonly #chain: EvmChainDescriptor;

  constructor(api: PrivyWalletActionStatusApi, chain: EvmChainDescriptor = CHAINS.base_sepolia) {
    this.#api = api;
    this.#chain = chain;
  }

  async getTransaction(input: Parameters<WalletExecutionStatusProvider['getTransaction']>[0]): Promise<WalletExecutionProviderTransaction> {
    if (!identifierPattern.test(input.providerTransactionId) || !identifierPattern.test(input.providerWalletId) ||
      !referencePattern.test(input.referenceId) || !addressPattern.test(input.recipient) ||
      !/^[1-9][0-9]*$/.test(input.amountAtomic)) throw new Error('Invalid Privy action lookup');
    const action = await this.#api.getAction(input.providerTransactionId, input.providerWalletId);
    if (action.id !== input.providerTransactionId || action.type !== 'transfer' || !actionStatuses.has(action.status) ||
      !exactActionIdentity(action, {
        walletId: input.providerWalletId,
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        chain: this.#chain,
      })) throw new Error('Privy returned an invalid action status');

    const evmSteps = action.steps.filter((step) => step.type === 'evm_transaction' || step.type === 'evm_user_operation');
    if (evmSteps.some((step) => step.caip2 !== this.#chain.caip2)) throw new Error('Privy returned an invalid action chain');
    const hashes = new Set(evmSteps.flatMap((step) => [step.transactionHash, step.bundleTransactionHash])
      .filter((value): value is string => value !== null)
      .map((value) => optionalHash(value))
      .filter((value): value is `0x${string}` => value !== null));
    if (hashes.size > 1) throw new Error('Privy returned ambiguous action hashes');
    const transactionHash = [...hashes][0] ?? null;
    let status: WalletExecutionProviderStatus;
    if (action.status === 'pending') status = 'pending';
    else if (action.status === 'failed' || action.status === 'rejected') status = 'failed';
    else status = 'confirmed';
    return {
      providerTransactionId: action.id,
      status,
      caip2: this.#chain.caip2,
      providerWalletId: action.walletId,
      referenceId: input.referenceId,
      transactionHash,
    };
  }
}

export function createPrivyWalletExecutionApi(client: PrivyClient, appId: string, chain: EvmChainDescriptor = CHAINS.base_sepolia): PrivyWalletExecutionApi {
  if (!appId.trim()) throw new Error('Privy app ID is required');
  return {
    async sendTransaction(input) {
      if (input.caip2 !== chain.caip2) throw new Error('Invalid execution chain');
      const body = {
        source: {
          asset: PRIVY_USDC_ASSET,
          amount: formatUsdcAmountAtomic(input.amountAtomic),
          chain: chain.privyChain,
        },
        destination: { address: input.recipient },
        amount_type: 'exact_input' as const,
      };
      const requestExpiry = client.getRequestExpiry();
      const signature = await input.sign(formatRequestForAuthorizationSignature({
        version: 1,
        method: 'POST',
        url: `https://api.privy.io/v1/wallets/${input.walletId}/transfer`,
        body,
        headers: {
          'privy-app-id': appId,
          'privy-idempotency-key': input.referenceId,
          ...(requestExpiry === undefined ? {} : { 'privy-request-expiry': String(requestExpiry) }),
        },
      }));
      const response = await client.wallets()._transfer(input.walletId, {
        ...body,
        'privy-authorization-signature': signature,
        'privy-idempotency-key': input.referenceId,
        ...(requestExpiry === undefined ? {} : { 'privy-request-expiry': String(requestExpiry) }),
      });
      return {
        actionId: response.id,
        status: response.status,
        type: response.type,
        walletId: response.wallet_id,
        sourceChain: response.source_chain,
        sourceAsset: response.source_asset ?? null,
        sourceAmount: response.source_amount ?? null,
        destinationAddress: response.destination_address,
      };
    },
  };
}

export function createPrivyWalletActionStatusApi(client: PrivyClient): PrivyWalletActionStatusApi {
  return {
    async getAction(providerTransactionId, providerWalletId) {
      const action = await client.wallets().actions.get(providerTransactionId, {
        wallet_id: providerWalletId,
        include: 'steps',
      });
      return {
        id: action.id,
        status: action.status,
        type: action.type,
        walletId: action.wallet_id,
        sourceChain: action.type === 'transfer' ? action.source_chain : '',
        sourceAsset: action.type === 'transfer' ? action.source_asset ?? null : null,
        sourceAmount: action.type === 'transfer' ? action.source_amount ?? null : null,
        destinationAddress: action.type === 'transfer' ? action.destination_address : '',
        steps: (action.steps ?? []).map((step) => ({
          type: step.type,
          caip2: 'caip2' in step ? step.caip2 : null,
          status: step.status,
          transactionHash: step.type === 'evm_transaction' ? step.transaction_hash : null,
          bundleTransactionHash: step.type === 'evm_user_operation' ? step.bundle_transaction_hash : null,
          userOperationHash: step.type === 'evm_user_operation' ? step.user_operation_hash : null,
        })),
      };
    },
  };
}
