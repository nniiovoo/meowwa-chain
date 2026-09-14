import type { MerchantProviderOrder, MerchantProviderRefund } from '../merchant-reconciliation/provider.js';
import type { ControlledMerchantQuote } from '../merchant-reconciliation/types.js';

export interface VerifiedMerchantPayment {
  sender: `0x${string}`;
  transactionHash: `0x${string}`;
  blockHash: `0x${string}`;
  blockNumber: number;
  blockTimestamp: string;
  logIndex: number;
}

export interface ControlledMerchantPaymentReader {
  verifyPayment(input: {
    transactionHash: `0x${string}`;
    recipient: `0x${string}`;
    amountAtomic: string;
    confirmations: number;
  }): Promise<VerifiedMerchantPayment>;
}

export interface PreparedMerchantRefundTransaction {
  transactionHash: `0x${string}`;
  serializedTransaction: `0x${string}`;
}

export interface ControlledMerchantRefundExecutor {
  prepareRefund(input: {
    recipient: `0x${string}`;
    amountAtomic: string;
  }): Promise<PreparedMerchantRefundTransaction>;
  broadcastAndConfirm(input: PreparedMerchantRefundTransaction): Promise<'pending' | 'confirmed' | 'failed'>;
}

export interface ControlledMerchantOrderRecord extends MerchantProviderOrder {
  status: 'confirmed';
  quoteId: string;
  requestId: string;
  amountMinor: number;
  paymentTransactionHash: `0x${string}`;
  petWalletAddress: `0x${string}`;
  paymentBlockHash: `0x${string}`;
  paymentBlockNumber: number;
  paymentLogIndex: number;
  identitySha256: string;
}

export interface ControlledMerchantRefundRecord extends MerchantProviderRefund {
  providerOrderId: string;
  requestId: string;
  amountMinor: number;
  recipient: `0x${string}`;
  amountAtomic: string;
  serializedTransaction?: `0x${string}` | undefined;
  identitySha256: string;
}

export type {
  ControlledMerchantQuote,
  MerchantProviderOrder,
  MerchantProviderRefund,
};
