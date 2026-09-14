import type { ControlledMerchantQuote } from './types.js';

export interface MerchantProviderOrder {
  providerReference: string;
  providerOrderId: string;
  status: 'pending' | 'confirmed' | 'fulfilled' | 'cancelled' | 'failed';
  reason?: string | undefined;
}

export interface MerchantProviderRefund {
  providerReference: string;
  providerRefundId: string;
  status: 'pending' | 'confirmed' | 'failed';
  transactionHash?: `0x${string}` | undefined;
  reason?: string | undefined;
}

export interface ControlledMerchantProvider {
  fetchQuotes(): Promise<ControlledMerchantQuote[]>;
  createOrder(input: {
    providerReference: string;
    quoteId: string;
    requestId: string;
    amountMinor: number;
    paymentTransactionHash: `0x${string}`;
  }): Promise<MerchantProviderOrder>;
  getOrder(providerReference: string): Promise<MerchantProviderOrder | undefined>;
  createRefund(input: {
    providerReference: string;
    providerOrderId: string;
    requestId: string;
    amountMinor: number;
  }): Promise<MerchantProviderRefund>;
  getRefund(providerReference: string): Promise<MerchantProviderRefund | undefined>;
}
