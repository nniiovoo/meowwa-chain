import { POC_CATALOG, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN } from '@meowwa/chain-domain';
import { keccak256 } from 'viem';
import { MerchantIdentityConflictError } from '../merchant-reconciliation/repository.js';
import {
  ControlledMerchantRepository,
  controlledMerchantDigest,
  orderIdentity,
  refundIdentity,
} from './repository.js';
import type {
  ControlledMerchantOrderRecord,
  ControlledMerchantPaymentReader,
  ControlledMerchantQuote,
  ControlledMerchantRefundExecutor,
  ControlledMerchantRefundRecord,
  MerchantProviderOrder,
  MerchantProviderRefund,
} from './types.js';

const addressPattern = EVM_ADDRESS_PATTERN;
const hashPattern = EVM_HASH_PATTERN;
const orderReferencePattern = /^mwo_[a-f0-9]{61}$/;
const refundReferencePattern = /^mwr_[a-f0-9]{61}$/;

function assertIdentifier(value: string, label: string): void {
  if (!value || value.trim() !== value || value.length > 255) throw new Error(`Invalid ${label}`);
}

function amountAtomic(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) throw new Error('Invalid controlled merchant amount');
  return (BigInt(amountMinor) * 10_000n).toString();
}

function publicOrder(record: ControlledMerchantOrderRecord): MerchantProviderOrder {
  return {
    providerReference: record.providerReference,
    providerOrderId: record.providerOrderId,
    status: record.status,
  };
}

function publicRefund(record: ControlledMerchantRefundRecord): MerchantProviderRefund {
  return {
    providerReference: record.providerReference,
    providerRefundId: record.providerRefundId,
    status: record.status,
    ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

export class FirstPartyControlledMerchantService {
  readonly #repository: ControlledMerchantRepository;
  readonly #paymentReader: ControlledMerchantPaymentReader;
  readonly #refundExecutor: ControlledMerchantRefundExecutor;
  readonly #merchantRecipient: `0x${string}`;
  readonly #providerRevision: string;
  readonly #confirmations: number;
  readonly #now: () => Date;
  #refundTail: Promise<void> = Promise.resolve();

  constructor(options: {
    repository: ControlledMerchantRepository;
    paymentReader: ControlledMerchantPaymentReader;
    refundExecutor: ControlledMerchantRefundExecutor;
    merchantRecipient: `0x${string}`;
    providerRevision: string;
    confirmations: number;
    now?: () => Date;
  }) {
    if (!addressPattern.test(options.merchantRecipient)) throw new Error('Invalid controlled merchant recipient');
    assertIdentifier(options.providerRevision, 'controlled merchant provider revision');
    if (!Number.isSafeInteger(options.confirmations) || options.confirmations < 2 || options.confirmations > 100) {
      throw new Error('Invalid controlled merchant confirmation depth');
    }
    this.#repository = options.repository;
    this.#paymentReader = options.paymentReader;
    this.#refundExecutor = options.refundExecutor;
    this.#merchantRecipient = options.merchantRecipient.toLowerCase() as `0x${string}`;
    this.#providerRevision = options.providerRevision;
    this.#confirmations = options.confirmations;
    this.#now = options.now ?? (() => new Date());
  }

  async fetchQuotes(): Promise<ControlledMerchantQuote[]> {
    const now = this.#now();
    const bucketStart = new Date(Math.floor(now.getTime() / 900_000) * 900_000);
    const expiresAt = new Date(bucketStart.getTime() + 900_000);
    return POC_CATALOG.map((product) => this.#repository.putQuote({
      quoteId: `quote_${controlledMerchantDigest({
        providerRevision: this.#providerRevision,
        productId: product.productId,
        merchantRecipient: this.#merchantRecipient,
        verifiedAt: bucketStart.toISOString(),
      }).slice(0, 48)}`,
      providerRevision: this.#providerRevision,
      merchantId: product.merchantId,
      merchantName: 'MeowWa Controlled Merchant',
      merchantRecipient: this.#merchantRecipient,
      productId: product.productId,
      productName: product.name,
      amountMinor: product.priceMinor,
      taxMinor: 0,
      shippingMinor: 0,
      feesMinor: 0,
      expiresAt: expiresAt.toISOString(),
      verifiedAt: bucketStart.toISOString(),
    }));
  }

  async createOrder(input: {
    providerReference: string; quoteId: string; requestId: string; amountMinor: number; paymentTransactionHash: `0x${string}`;
  }): Promise<MerchantProviderOrder> {
    this.#validateOrder(input);
    const existing = this.#repository.getOrder(input.providerReference);
    if (existing) {
      if (existing.identitySha256 !== controlledMerchantDigest(orderIdentity(input))) {
        throw new MerchantIdentityConflictError('Controlled merchant order replay conflicts');
      }
      return publicOrder(existing);
    }
    const quote = this.#repository.getQuote(input.quoteId);
    if (!quote || quote.merchantRecipient !== this.#merchantRecipient ||
      quote.amountMinor !== input.amountMinor || !POC_CATALOG.some((product) =>
        product.productId === quote.productId && product.merchantId === quote.merchantId && product.priceMinor === quote.amountMinor)) {
      throw new Error('Controlled merchant quote is missing, expired, or inconsistent');
    }
    const payment = await this.#paymentReader.verifyPayment({
      transactionHash: input.paymentTransactionHash,
      recipient: this.#merchantRecipient,
      amountAtomic: amountAtomic(input.amountMinor),
      confirmations: this.#confirmations,
    });
    const paymentAt = Date.parse(payment.blockTimestamp);
    const quoteVerifiedAt = Date.parse(quote.verifiedAt);
    const quoteExpiresAt = Date.parse(quote.expiresAt);
    if (!Number.isFinite(paymentAt) || !Number.isFinite(quoteVerifiedAt) || !Number.isFinite(quoteExpiresAt) ||
      paymentAt < quoteVerifiedAt || paymentAt >= quoteExpiresAt) {
      throw new Error('Controlled merchant quote is missing, expired, or inconsistent');
    }
    if (payment.transactionHash !== input.paymentTransactionHash.toLowerCase() || !addressPattern.test(payment.sender) ||
      !hashPattern.test(payment.blockHash) || !Number.isSafeInteger(payment.blockNumber) || payment.blockNumber < 0 ||
      !Number.isSafeInteger(payment.logIndex) || payment.logIndex < 0) {
      throw new Error('Controlled merchant payment identity mismatch');
    }
    const record = this.#repository.putOrder({
      ...input,
      paymentTransactionHash: input.paymentTransactionHash.toLowerCase() as `0x${string}`,
      providerOrderId: `order_${controlledMerchantDigest(input.providerReference).slice(0, 48)}`,
      petWalletAddress: payment.sender.toLowerCase() as `0x${string}`,
      paymentBlockHash: payment.blockHash.toLowerCase() as `0x${string}`,
      paymentBlockNumber: payment.blockNumber,
      paymentLogIndex: payment.logIndex,
    });
    return publicOrder(record);
  }

  async getOrder(providerReference: string): Promise<MerchantProviderOrder | undefined> {
    if (!orderReferencePattern.test(providerReference)) throw new Error('Invalid controlled merchant order reference');
    const record = this.#repository.getOrder(providerReference);
    return record ? publicOrder(record) : undefined;
  }

  async createRefund(input: {
    providerReference: string; providerOrderId: string; requestId: string; amountMinor: number;
  }): Promise<MerchantProviderRefund> {
    this.#validateRefund(input);
    const existing = this.#repository.getRefund(input.providerReference);
    if (existing) {
      if (existing.identitySha256 !== controlledMerchantDigest(refundIdentity(input))) {
        throw new MerchantIdentityConflictError('Controlled merchant refund replay conflicts');
      }
      return this.#continueRefund(existing);
    }
    const order = this.#repository.getOrderByProviderId(input.providerOrderId);
    if (!order || order.requestId !== input.requestId || order.amountMinor !== input.amountMinor || order.status !== 'confirmed') {
      throw new Error('Controlled merchant refund does not match a confirmed order');
    }
    const record = this.#repository.prepareRefund({
      ...input,
      providerRefundId: `refund_${controlledMerchantDigest(input.providerReference).slice(0, 48)}`,
      recipient: order.petWalletAddress,
      amountAtomic: amountAtomic(input.amountMinor),
    });
    return this.#continueRefund(record);
  }

  async getRefund(providerReference: string): Promise<MerchantProviderRefund | undefined> {
    if (!refundReferencePattern.test(providerReference)) throw new Error('Invalid controlled merchant refund reference');
    const record = this.#repository.getRefund(providerReference);
    return record ? this.#continueRefund(record) : undefined;
  }

  async #continueRefund(record: ControlledMerchantRefundRecord): Promise<MerchantProviderRefund> {
    return this.#serializedRefund(async () => {
      // Re-broadcasting a transaction already in the mempool is an RPC error, and every refund
      // necessarily sits in that window (confirmations >= 2). An unhandled throw here failed
      // createRefund and getRefund for every pet because of one unrelated in-flight refund.
      // Isolate each record; the unresolved count below preserves the nonce barrier that the
      // throw previously provided by accident.
      let unresolvedOtherRefunds = 0;
      for (const pending of this.#repository.listSignedPendingRefunds()) {
        if (pending.providerReference === record.providerReference) continue;
        let status: 'confirmed' | 'failed' | 'pending' | undefined;
        try {
          status = await this.#refundExecutor.broadcastAndConfirm({
            transactionHash: pending.transactionHash!,
            serializedTransaction: pending.serializedTransaction!,
          });
        } catch { status = undefined; }
        if (status === 'confirmed' || status === 'failed') {
          this.#repository.finishRefund(
            pending.providerReference,
            status,
            status === 'failed' ? 'Base Sepolia refund transaction reverted' : undefined,
          );
          continue;
        }
        unresolvedOtherRefunds += 1;
      }
      let current = this.#repository.getRefund(record.providerReference)!;
      if (current.status !== 'pending') return publicRefund(current);
      if (!current.transactionHash || !current.serializedTransaction) {
        // Signing now would claim a nonce an already-signed but unconfirmed refund still holds.
        // Report this refund as still pending and let the reconciler poll again.
        if (unresolvedOtherRefunds > 0) return publicRefund(current);
        const prepared = await this.#refundExecutor.prepareRefund({
          recipient: current.recipient,
          amountAtomic: current.amountAtomic,
        });
        if (!hashPattern.test(prepared.transactionHash) || !/^0x[0-9a-fA-F]+$/.test(prepared.serializedTransaction) ||
          keccak256(prepared.serializedTransaction).toLowerCase() !== prepared.transactionHash.toLowerCase()) {
          throw new Error('Controlled merchant refund signer returned invalid transaction data');
        }
        current = this.#repository.attachSignedRefund({
          providerReference: current.providerReference,
          transactionHash: prepared.transactionHash.toLowerCase() as `0x${string}`,
          serializedTransaction: prepared.serializedTransaction.toLowerCase() as `0x${string}`,
        });
      }
      const status = await this.#refundExecutor.broadcastAndConfirm({
        transactionHash: current.transactionHash!,
        serializedTransaction: current.serializedTransaction!,
      });
      if (status === 'confirmed' || status === 'failed') current = this.#repository.finishRefund(
        current.providerReference,
        status,
        status === 'failed' ? 'Base Sepolia refund transaction reverted' : undefined,
      );
      return publicRefund(current);
    });
  }

  #serializedRefund<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#refundTail.then(operation, operation);
    this.#refundTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #validateOrder(input: {
    providerReference: string; quoteId: string; requestId: string; amountMinor: number; paymentTransactionHash: string;
  }): void {
    if (!orderReferencePattern.test(input.providerReference)) throw new Error('Invalid controlled merchant order reference');
    assertIdentifier(input.quoteId, 'controlled merchant quote ID');
    assertIdentifier(input.requestId, 'controlled merchant request ID');
    amountAtomic(input.amountMinor);
    if (!hashPattern.test(input.paymentTransactionHash)) throw new Error('Invalid controlled merchant payment hash');
  }

  #validateRefund(input: { providerReference: string; providerOrderId: string; requestId: string; amountMinor: number }): void {
    if (!refundReferencePattern.test(input.providerReference)) throw new Error('Invalid controlled merchant refund reference');
    assertIdentifier(input.providerOrderId, 'controlled merchant provider order ID');
    assertIdentifier(input.requestId, 'controlled merchant request ID');
    amountAtomic(input.amountMinor);
  }
}
