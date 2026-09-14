import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_CONTRACT } from '@meowwa/chain-domain';
import { ERC20_TRANSFER_EVENT_ABI } from '../wallet-execution/chain.js';
import {
  ViemControlledMerchantPaymentReader,
  ViemControlledMerchantRefundExecutor,
  loadControlledMerchantAccount,
  type ControlledMerchantChainClient,
  type ControlledMerchantChainReceipt,
} from './chain.js';

const merchant = `0x${'4'.repeat(40)}` as const;
const pet = `0x${'5'.repeat(40)}` as const;
const paymentHash = `0x${'1'.repeat(64)}` as const;
const blockHash = `0x${'3'.repeat(64)}` as const;
const blockTimestamp = BigInt(Date.parse('2026-07-17T12:01:00.000Z') / 1_000);
const approvalEventAbi = [{
  type: 'event' as const, name: 'Approval', anonymous: false,
  inputs: [
    { indexed: true, name: 'owner', type: 'address' },
    { indexed: true, name: 'spender', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;

function paymentReceipt(): ControlledMerchantChainReceipt {
  return {
    status: 'success',
    transactionHash: paymentHash,
    blockHash,
    blockNumber: 100n,
    logs: [{
      address: BASE_SEPOLIA_USDC_CONTRACT,
      topics: encodeEventTopics({
        abi: ERC20_TRANSFER_EVENT_ABI,
        eventName: 'Transfer',
        args: { from: pet, to: merchant },
      }) as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ type: 'uint256' }], [12_990_000n]),
      transactionHash: paymentHash,
      blockHash,
      blockNumber: 100n,
      logIndex: 3,
    }],
  };
}

function client(overrides: Partial<ControlledMerchantChainClient> = {}): ControlledMerchantChainClient {
  return {
    getChainId: vi.fn(async () => BASE_SEPOLIA_CHAIN_ID),
    getBlockNumber: vi.fn(async () => 103n),
    getBlock: vi.fn(async () => ({ hash: blockHash, number: 100n, timestamp: blockTimestamp })),
    getTransactionReceipt: vi.fn(async () => paymentReceipt()),
    getTransactionCount: vi.fn(async () => 7),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n })),
    estimateGas: vi.fn(async () => 65_000n),
    sendRawTransaction: vi.fn(async () => paymentHash),
    ...overrides,
  };
}

describe('controlled merchant Base Sepolia chain adapters', () => {
  it('loads only a regular mode-0600 merchant key file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meowwa-merchant-key-'));
    try {
      const keyPath = join(directory, 'merchant.key');
      await writeFile(keyPath, `0x${'0'.repeat(63)}1\n`, { mode: 0o600 });
      expect(loadControlledMerchantAccount(keyPath).address).toBe(privateKeyToAccount(`0x${'0'.repeat(63)}1`).address);
      await chmod(keyPath, 0o644);
      expect(() => loadControlledMerchantAccount(keyPath)).toThrow('mode-0600');
      await chmod(keyPath, 0o600);
      const linkPath = join(directory, 'merchant-link.key');
      await symlink(keyPath, linkPath);
      expect(() => loadControlledMerchantAccount(linkPath)).toThrow('regular');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('derives the pet wallet only from one exact canonical USDC payment', async () => {
    const reader = new ViemControlledMerchantPaymentReader(client());
    await expect(reader.verifyPayment({
      transactionHash: paymentHash,
      recipient: merchant,
      amountAtomic: '12990000',
      confirmations: 2,
    })).resolves.toEqual({
      sender: pet,
      transactionHash: paymentHash,
      blockHash,
      blockNumber: 100,
      blockTimestamp: '2026-07-17T12:01:00.000Z',
      logIndex: 3,
    });
  });

  it('allows USDC gas-payment logs while requiring one exact merchant transfer', async () => {
    const receipt = paymentReceipt();
    receipt.logs.unshift({
      ...receipt.logs[0]!,
      topics: encodeEventTopics({
        abi: approvalEventAbi, eventName: 'Approval', args: { owner: pet, spender: merchant },
      }) as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ type: 'uint256' }], [9_263n]),
      logIndex: 1,
    });
    receipt.logs.push({
      ...receipt.logs[1]!,
      topics: encodeEventTopics({
        abi: ERC20_TRANSFER_EVENT_ABI, eventName: 'Transfer',
        args: { from: pet, to: `0x${'6'.repeat(40)}` },
      }) as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ type: 'uint256' }], [3_449n]),
      logIndex: 4,
    });
    const reader = new ViemControlledMerchantPaymentReader(client({
      getTransactionReceipt: vi.fn(async () => receipt),
    }));
    await expect(reader.verifyPayment({
      transactionHash: paymentHash, recipient: merchant, amountAtomic: '12990000', confirmations: 2,
    })).resolves.toMatchObject({ sender: pet, logIndex: 3 });
  });

  it('rejects a duplicate expected merchant transfer in the payment transaction', async () => {
    const receipt = paymentReceipt();
    receipt.logs.push({ ...receipt.logs[0]!, logIndex: 4 });
    const reader = new ViemControlledMerchantPaymentReader(client({
      getTransactionReceipt: vi.fn(async () => receipt),
    }));
    await expect(reader.verifyPayment({
      transactionHash: paymentHash,
      recipient: merchant,
      amountAtomic: '12990000',
      confirmations: 2,
    })).rejects.toThrow('exactly one');
  });

  it('signs without broadcasting, then confirms only the exact persisted raw transaction', async () => {
    const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
    let broadcast = false;
    let preparedHash: `0x${string}` = paymentHash;
    const receipt = (): ControlledMerchantChainReceipt => ({
      status: 'success', transactionHash: preparedHash, blockHash, blockNumber: 100n, logs: [],
    });
    const chain = client({
      getTransactionReceipt: vi.fn(async () => {
        if (!broadcast) throw new Error('not found');
        return receipt();
      }),
      sendRawTransaction: vi.fn(async ({ serializedTransaction }) => {
        broadcast = true;
        const { keccak256 } = await import('viem');
        return keccak256(serializedTransaction);
      }),
    });
    const executor = new ViemControlledMerchantRefundExecutor({ client: chain, account, confirmations: 2 });
    const prepared = await executor.prepareRefund({ recipient: pet, amountAtomic: '12990000' });
    preparedHash = prepared.transactionHash;

    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    await expect(executor.broadcastAndConfirm(prepared)).resolves.toBe('confirmed');
    expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    await expect(executor.broadcastAndConfirm({
      ...prepared,
      transactionHash: `0x${'9'.repeat(64)}`,
    })).rejects.toThrow('identity mismatch');
  });

  it('does not confirm a refund receipt from a non-canonical block', async () => {
    const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
    let preparedHash: `0x${string}` = paymentHash;
    const chain = client({
      getTransactionReceipt: vi.fn(async () => ({
        status: 'success' as const, transactionHash: preparedHash, blockHash, blockNumber: 100n, logs: [],
      })),
      getBlock: vi.fn(async () => ({
        hash: `0x${'8'.repeat(64)}`, number: 100n, timestamp: blockTimestamp,
      })),
    });
    const executor = new ViemControlledMerchantRefundExecutor({ client: chain, account, confirmations: 2 });
    const prepared = await executor.prepareRefund({ recipient: pet, amountAtomic: '12990000' });
    preparedHash = prepared.transactionHash;

    await expect(executor.broadcastAndConfirm(prepared)).rejects.toThrow(/block identity|canonical/i);
    expect(chain.getBlock).toHaveBeenCalledWith({ blockNumber: 100n });
  });

  it('refuses an RPC fee or gas estimate above the POC safety ceiling before signing', async () => {
    const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
    const chain = client({ estimateGas: vi.fn(async () => 200_001n) });
    const executor = new ViemControlledMerchantRefundExecutor({ client: chain, account, confirmations: 2 });
    await expect(executor.prepareRefund({ recipient: pet, amountAtomic: '12990000' })).rejects.toThrow('fee or nonce');
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });
});
