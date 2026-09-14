import { createHash } from 'node:crypto';
import type { PaymentRequest } from '@meowwa/chain-domain';

export interface PaymentIntent {
  requestId: string;
  ownerId: string;
  petId: string;
  mandateId: string;
  merchantId: string;
  productId: string;
  quantity: number;
  amountMinor: number;
  currency: 'USDC';
  chainId: 84532;
  recipient: string;
  contract: string;
  quoteId: string;
  quoteExpiresAt: string;
  requestNonce: string;
  approvedBy: string | null;
  ownerConfirmationStatus: PaymentRequest['ownerConfirmationStatus'];
  requestedApprovalMode: PaymentRequest['requestedApprovalMode'];
  policyVersion: string;
  intentHash: string;
}

type PaymentIntentFields = Omit<PaymentIntent, 'intentHash'>;

function canonicalPaymentIntent(value: PaymentIntentFields): PaymentIntentFields {
  return {
    requestId: value.requestId, ownerId: value.ownerId, petId: value.petId, mandateId: value.mandateId,
    merchantId: value.merchantId, productId: value.productId, quantity: value.quantity,
    amountMinor: value.amountMinor, currency: value.currency, chainId: value.chainId,
    recipient: value.recipient.toLowerCase(), contract: value.contract.toLowerCase(),
    quoteId: value.quoteId, quoteExpiresAt: value.quoteExpiresAt, requestNonce: value.requestNonce,
    approvedBy: value.approvedBy ?? null, ownerConfirmationStatus: value.ownerConfirmationStatus,
    requestedApprovalMode: value.requestedApprovalMode, policyVersion: value.policyVersion,
  };
}

export function paymentIntentDigest(value: PaymentIntentFields): string {
  return createHash('sha256').update(JSON.stringify(canonicalPaymentIntent(value))).digest('hex');
}

export function paymentIntentForRequest(request: PaymentRequest): PaymentIntent {
  const fields = canonicalPaymentIntent({
    requestId: request.requestId, ownerId: request.ownerId, petId: request.petId, mandateId: request.mandateId,
    merchantId: request.merchantId, productId: request.productId, quantity: request.quantity,
    amountMinor: request.amountMinor, currency: request.currency, chainId: request.chainId,
    recipient: request.recipient, contract: request.contract, quoteId: request.quoteId,
    quoteExpiresAt: request.quoteExpiresAt, requestNonce: request.requestNonce,
    approvedBy: request.approvedBy ?? null, ownerConfirmationStatus: request.ownerConfirmationStatus,
    requestedApprovalMode: request.requestedApprovalMode, policyVersion: request.policyVersion,
  });
  return { ...fields, intentHash: paymentIntentDigest(fields) };
}

export type WalletSubmission =
  | { status: 'confirmed'; transactionHash: string; network: 'Base Sepolia'; token: 'test USDC' }
  | { status: 'pending'; submissionId: string }
  | { status: 'failed'; reason: string };

export interface WalletAdapter {
  submit(intent: PaymentIntent): WalletSubmission | Promise<WalletSubmission>;
}

export function submitTestnetPayment(intent: PaymentIntent): Extract<WalletSubmission, { status: 'confirmed' }> {
  return {
    status: 'confirmed',
    transactionHash: `0x${createHash('sha256').update(`base-sepolia:${intent.intentHash}`).digest('hex')}`,
    network: 'Base Sepolia' as const,
    token: 'test USDC' as const,
  };
}

export const simulatedWalletAdapter: WalletAdapter = { submit: submitTestnetPayment };
