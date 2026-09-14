import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import {
  ERC20_TRANSFER_EVENT_ABI,
  ViemBaseSepoliaExecutionReader,
  type BaseSepoliaReceipt,
  type BaseSepoliaReceiptLog,
} from './chain.js';

const sender = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const recipient = '0x1111111111111111111111111111111111111111' as const;
const transactionHash = `0x${'b'.repeat(64)}` as const;
const blockHash = `0x${'c'.repeat(64)}` as const;
const canonicalBlock = async () => ({ hash: blockHash, number: 1000n });
const approvalEventAbi = [{
  type: 'event' as const,
  name: 'Approval',
  anonymous: false,
  inputs: [
    { indexed: true, name: 'owner', type: 'address' },
    { indexed: true, name: 'spender', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;

function eventTopics(from: `0x${string}`, to: `0x${string}`): [Hex, ...Hex[]] {
  return encodeEventTopics({
    abi: ERC20_TRANSFER_EVENT_ABI, eventName: 'Transfer', args: { from, to },
  }) as [Hex, ...Hex[]];
}

function transferLog(overrides: Partial<BaseSepoliaReceiptLog> = {}): BaseSepoliaReceiptLog {
  return {
    address: BASE_SEPOLIA_USDC,
    topics: eventTopics(sender, recipient),
    data: encodeAbiParameters([{ type: 'uint256' }], [12_990_000n]),
    transactionHash, blockHash, blockNumber: 1000n, logIndex: 7, removed: false,
    ...overrides,
  };
}

function receipt(overrides: Partial<BaseSepoliaReceipt> = {}): BaseSepoliaReceipt {
  return {
    status: 'success', transactionHash, blockHash, blockNumber: 1000n, logs: [transferLog()], ...overrides,
  };
}

describe('Base Sepolia execution receipt verification', () => {
  it('returns only the exact finalized canonical USDC transfer evidence', async () => {
    const client = { getChainId: vi.fn(async () => 84532), getBlockNumber: vi.fn(async () => 1012n), getBlock: vi.fn(canonicalBlock), getTransactionReceipt: vi.fn(async () => receipt()) };
    const reader = new ViemBaseSepoliaExecutionReader(client);
    await expect(reader.verifyTransfer({
      transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12,
    })).resolves.toEqual({ transactionHash, blockHash, blockNumber: 1000, logIndex: 7, confirmedAtBlock: 1012 });
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: transactionHash });
  });

  it('ignores canonical USDC Approval logs used by gas payment', async () => {
    const approval = transferLog({
      topics: encodeEventTopics({
        abi: approvalEventAbi, eventName: 'Approval', args: { owner: sender, spender: recipient },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: 'uint256' }], [9_263n]),
      logIndex: 6,
    });
    const client = {
      getChainId: vi.fn(async () => 84532),
      getBlockNumber: vi.fn(async () => 1012n),
      getBlock: vi.fn(canonicalBlock),
      getTransactionReceipt: vi.fn(async () => receipt({ logs: [approval, transferLog()] })),
    };
    const reader = new ViemBaseSepoliaExecutionReader(client);
    await expect(reader.verifyTransfer({
      transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12,
    })).resolves.toMatchObject({ transactionHash, logIndex: 7 });
  });

  it('rejects a receipt provider that is not actually connected to Base Sepolia', async () => {
    const reader = new ViemBaseSepoliaExecutionReader({
      getChainId: async () => 8453,
      getBlockNumber: async () => 1012n,
      getBlock: canonicalBlock,
      getTransactionReceipt: async () => receipt(),
    });
    await expect(reader.verifyTransfer({ transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12 }))
      .rejects.toThrow('Base Sepolia chain identity mismatch');
  });

  it('rejects a receipt whose block hash is no longer canonical', async () => {
    const getBlock = vi.fn(async () => ({
      hash: `0x${'d'.repeat(64)}`,
      number: 1000n,
    }));
    const client = {
      getChainId: vi.fn(async () => 84532),
      getBlockNumber: vi.fn(async () => 1012n),
      getBlock,
      getTransactionReceipt: vi.fn(async () => receipt()),
    };
    const reader = new ViemBaseSepoliaExecutionReader(client);

    await expect(reader.verifyTransfer({
      transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12,
    })).rejects.toThrow(/block identity|canonical/i);
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: 1000n });
  });

  it.each([
    ['reverted receipt', receipt({ status: 'reverted' })],
    ['wrong receipt hash', receipt({ transactionHash: `0x${'d'.repeat(64)}` })],
    ['removed log', receipt({ logs: [transferLog({ removed: true })] })],
    ['wrong contract', receipt({ logs: [transferLog({ address: sender })] })],
    ['wrong sender', receipt({ logs: [transferLog({ topics: eventTopics(recipient, recipient) })] })],
    ['wrong recipient', receipt({ logs: [transferLog({ topics: eventTopics(sender, sender) })] })],
    ['wrong amount', receipt({ logs: [transferLog({ data: encodeAbiParameters([{ type: 'uint256' }], [1n]) })] })],
    ['wrong log transaction', receipt({ logs: [transferLog({ transactionHash: `0x${'d'.repeat(64)}` })] })],
    ['wrong log block', receipt({ logs: [transferLog({ blockHash: `0x${'d'.repeat(64)}` })] })],
    ['duplicate expected transfer', receipt({ logs: [transferLog(), transferLog({ logIndex: 8 })] })],
  ])('rejects %s for manual review', async (_label, value) => {
    const reader = new ViemBaseSepoliaExecutionReader({ getChainId: async () => 84532, getBlockNumber: async () => 1012n, getBlock: canonicalBlock, getTransactionReceipt: async () => value });
    await expect(reader.verifyTransfer({ transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12 })).rejects.toThrow();
  });

  it('selects one exact log when a transaction has two otherwise identical transfers', async () => {
    const duplicate = receipt({ logs: [transferLog(), transferLog({ logIndex: 8 })] });
    const reader = new ViemBaseSepoliaExecutionReader({
      getChainId: async () => 84532,
      getBlockNumber: async () => 1012n,
      getBlock: canonicalBlock,
      getTransactionReceipt: async () => duplicate,
    });

    await expect(reader.verifyTransfer({
      transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12, logIndex: 8,
    })).resolves.toMatchObject({ transactionHash, logIndex: 8 });
  });

  it('rejects insufficient confirmation depth and malformed canonical logs', async () => {
    const shallow = new ViemBaseSepoliaExecutionReader({ getChainId: async () => 84532, getBlockNumber: async () => 1011n, getBlock: canonicalBlock, getTransactionReceipt: async () => receipt() });
    await expect(shallow.verifyTransfer({ transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12 })).rejects.toThrow('confirmation');
    const malformed = new ViemBaseSepoliaExecutionReader({
      getBlockNumber: async () => 1012n,
      getChainId: async () => 84532,
      getBlock: canonicalBlock,
      getTransactionReceipt: async () => receipt({ logs: [transferLog({ data: '0xbroken' })] }),
    });
    await expect(malformed.verifyTransfer({ transactionHash, sender, recipient, amountAtomic: '12990000', confirmations: 12 })).rejects.toThrow();
  });
});
