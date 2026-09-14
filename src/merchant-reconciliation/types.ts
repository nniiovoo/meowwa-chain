export type MerchantOrderStatus =
  | 'prepared'
  | 'submitting'
  | 'submitted'
  | 'confirmed'
  | 'fulfilled'
  | 'unknown'
  | 'cancel_pending'
  | 'cancelled'
  | 'failed'
  | 'review_required';

export type MerchantRefundStatus =
  | 'prepared'
  | 'submitting'
  | 'submitted'
  | 'provider_confirmed'
  | 'chain_confirmed'
  | 'unknown'
  | 'failed'
  | 'review_required';

export interface ControlledMerchantQuote {
  quoteId: string;
  providerRevision: string;
  merchantId: string;
  merchantName: string;
  merchantRecipient: string;
  productId: string;
  productName: string;
  amountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  feesMinor: number;
  expiresAt: string;
  verifiedAt: string;
}

export interface MerchantOrder {
  orderId: string;
  requestId: string;
  ownerId: string;
  petId: string;
  quoteId: string;
  merchantId: string;
  productId: string;
  merchantRecipient: string;
  petWalletAddress: string;
  amountMinor: number;
  amountAtomic: string;
  paymentTransactionHash: `0x${string}`;
  providerReference: string;
  providerOrderId: string | null;
  status: MerchantOrderStatus;
  failureCode: string | null;
  internalSettledAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface MerchantRefund {
  refundId: string;
  orderId: string;
  requestId: string;
  amountMinor: number;
  amountAtomic: string;
  providerReference: string;
  providerRefundId: string | null;
  transactionHash: `0x${string}` | null;
  blockHash: `0x${string}` | null;
  blockNumber: number | null;
  logIndex: number | null;
  status: MerchantRefundStatus;
  failureCode: string | null;
  confirmedAt: string | null;
  internalSettledAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface MerchantReconciliationEvent {
  eventId: string;
  aggregateType: 'order' | 'refund';
  aggregateId: string;
  kind: string;
  fromStatus: MerchantOrderStatus | MerchantRefundStatus | null;
  toStatus: MerchantOrderStatus | MerchantRefundStatus;
  detail: string | null;
  createdAt: string;
}

export type PrepareMerchantOrderInput = Omit<MerchantOrder,
  'providerOrderId' | 'status' | 'failureCode' | 'internalSettledAt' | 'createdAt' | 'updatedAt' | 'version'>;

export type PrepareMerchantRefundInput = Pick<MerchantRefund,
  'refundId' | 'orderId' | 'requestId' | 'amountMinor' | 'amountAtomic' | 'providerReference'>;
