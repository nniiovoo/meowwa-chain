import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { BASE_SEPOLIA_USDC, ERC20_TRANSFER_ABI } from '../wallet-control/policy.js';
import {
  createPrivyWalletExecutionApi,
  PrivyWalletExecutionProvider,
  PrivyWalletExecutionStatusProvider,
  type PrivyWalletActionStatusApi,
  type PrivyWalletExecutionApi,
} from './privy-provider.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const userOperationHash = `0x${'b'.repeat(64)}`;
const referenceId = `mw_${'d'.repeat(61)}`;
const walletId = 'embedded_123';
const recipient = '0x1111111111111111111111111111111111111111';
const calldata = encodeFunctionData({
  abi: ERC20_TRANSFER_ABI,
  functionName: 'transfer',
  args: [recipient, 12990000n],
});

function input() {
  return {
    embeddedWalletId: walletId,
    smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    caip2: 'eip155:84532' as const,
    contract: BASE_SEPOLIA_USDC.toLowerCase(),
    calldata,
    referenceId,
    sign: vi.fn(async () => 'der-signature-base64'),
  };
}

function action(overrides: Record<string, unknown> = {}) {
  return {
    actionId: 'privy_action_123',
    status: 'pending',
    type: 'transfer',
    walletId,
    sourceChain: 'base_sepolia',
    sourceAsset: 'usdc',
    sourceAmount: '12.99',
    destinationAddress: recipient,
    ...overrides,
  };
}

function lookup() {
  return { providerTransactionId: 'privy_action_123', providerWalletId: walletId, referenceId, recipient, amountAtomic: '12990000' };
}

describe('Privy wallet execution provider', () => {
  it('submits one exact Base Sepolia USDC transfer action with the external sign function', async () => {
    const sendTransaction = vi.fn<PrivyWalletExecutionApi['sendTransaction']>(async () => action());
    const provider = new PrivyWalletExecutionProvider({ sendTransaction });
    await expect(provider.submit(input())).resolves.toEqual({
      providerTransactionId: 'privy_action_123', transactionHash: null, userOperationHash: null,
    });
    expect(sendTransaction).toHaveBeenCalledWith({
      walletId,
      caip2: 'eip155:84532',
      referenceId,
      recipient,
      amountAtomic: '12990000',
      sign: expect.any(Function),
    });
  });

  it.each([
    ['missing action ID', { actionId: '' }],
    ['wrong action type', { type: 'swap' }],
    ['wrong wallet', { walletId: 'embedded_attacker' }],
    ['wrong chain', { sourceChain: 'base' }],
    ['wrong asset', { sourceAsset: 'usdt' }],
    ['wrong amount', { sourceAmount: '13' }],
    ['wrong recipient', { destinationAddress: '0x2222222222222222222222222222222222222222' }],
  ])('rejects %s as an ambiguous provider response', async (_label, responseOverride) => {
    const provider = new PrivyWalletExecutionProvider({ sendTransaction: vi.fn(async () => action(responseOverride)) });
    await expect(provider.submit(input())).rejects.toThrow('invalid transfer action');
  });

  it.each([
    ['wrong selector', `0x${'c'.repeat(136)}`],
    ['zero recipient', encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: ['0x0000000000000000000000000000000000000000', 1n] })],
    ['zero amount', encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [recipient, 0n] })],
  ])('rejects %s calldata before calling Privy', async (_label, malformedCalldata) => {
    const sendTransaction = vi.fn<PrivyWalletExecutionApi['sendTransaction']>(async () => action());
    const provider = new PrivyWalletExecutionProvider({ sendTransaction });
    await expect(provider.submit({ ...input(), calldata: malformedCalldata as `0x${string}` })).rejects.toThrow('Invalid execution calldata');
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('normalizes a succeeded wallet action without treating it as chain settlement', async () => {
    const getAction = vi.fn<PrivyWalletActionStatusApi['getAction']>(async () => ({
      id: 'privy_action_123', status: 'succeeded', type: 'transfer', walletId,
      sourceChain: 'base_sepolia', sourceAsset: 'usdc', sourceAmount: '12.990000', destinationAddress: recipient,
      steps: [{
        type: 'evm_user_operation', caip2: 'eip155:84532', status: 'confirmed', transactionHash: null,
        bundleTransactionHash: transactionHash, userOperationHash,
      }],
    }));
    const provider = new PrivyWalletExecutionStatusProvider({ getAction });
    await expect(provider.getTransaction(lookup())).resolves.toEqual({
      providerTransactionId: 'privy_action_123', status: 'confirmed', caip2: 'eip155:84532',
      providerWalletId: walletId, referenceId, transactionHash,
    });
    expect(getAction).toHaveBeenCalledWith('privy_action_123', walletId);
  });

  it('keeps a pending wallet action pending and rejects wrong or ambiguous action evidence', async () => {
    const pending = new PrivyWalletExecutionStatusProvider({ getAction: vi.fn(async () => ({
      id: 'privy_action_123', status: 'pending', type: 'transfer', walletId,
      sourceChain: 'base_sepolia', sourceAsset: 'usdc', sourceAmount: '12.99', destinationAddress: recipient, steps: [],
    })) });
    await expect(pending.getTransaction(lookup())).resolves.toMatchObject({ status: 'pending', transactionHash: null });

    const wrong = new PrivyWalletExecutionStatusProvider({ getAction: vi.fn(async () => ({
      id: 'privy_action_123', status: 'succeeded', type: 'transfer', walletId,
      sourceChain: 'base_sepolia', sourceAsset: 'usdc', sourceAmount: '12.99', destinationAddress: recipient,
      steps: [
        { type: 'evm_transaction', caip2: 'eip155:84532', status: 'confirmed', transactionHash, bundleTransactionHash: null, userOperationHash: null },
        { type: 'evm_transaction', caip2: 'eip155:84532', status: 'confirmed', transactionHash: `0x${'c'.repeat(64)}`, bundleTransactionHash: null, userOperationHash: null },
      ],
    })) });
    await expect(wrong.getTransaction(lookup())).rejects.toThrow('ambiguous action hashes');
  });

  it('signs the exact Transfer API body and binds the provider idempotency key', async () => {
    const lowLevelTransfer = vi.fn(async () => ({
      id: 'privy_action_123', status: 'pending', type: 'transfer', wallet_id: walletId,
      source_chain: 'base_sepolia', source_asset: 'usdc', source_amount: '12.99', destination_address: recipient,
    }));
    const client = {
      getRequestExpiry: () => 1_800_000_000_000,
      wallets: () => ({ _transfer: lowLevelTransfer }),
    } as unknown as Parameters<typeof createPrivyWalletExecutionApi>[0];
    const api = createPrivyWalletExecutionApi(client, 'app_123');
    const sign = vi.fn(async (payload: Uint8Array) => {
      const request = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      expect(request).toMatchObject({
        method: 'POST',
        url: `https://api.privy.io/v1/wallets/${walletId}/transfer`,
        body: {
          source: { asset: 'usdc', amount: '12.99', chain: 'base_sepolia' },
          destination: { address: recipient },
          amount_type: 'exact_input',
        },
        headers: {
          'privy-app-id': 'app_123',
          'privy-idempotency-key': referenceId,
          'privy-request-expiry': '1800000000000',
        },
      });
      return 'authorization-signature';
    });
    await expect(api.sendTransaction({
      walletId, caip2: 'eip155:84532', referenceId, recipient, amountAtomic: '12990000', sign,
    })).resolves.toMatchObject({ actionId: 'privy_action_123', sourceAmount: '12.99' });
    expect(lowLevelTransfer).toHaveBeenCalledWith(walletId, expect.objectContaining({
      source: { asset: 'usdc', amount: '12.99', chain: 'base_sepolia' },
      destination: { address: recipient },
      amount_type: 'exact_input',
      'privy-authorization-signature': 'authorization-signature',
      'privy-idempotency-key': referenceId,
      'privy-request-expiry': '1800000000000',
    }));
  });
});
