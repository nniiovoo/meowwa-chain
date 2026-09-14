import { createHash } from 'node:crypto';
import { ALPHA_PRODUCT, POC_CATALOG } from '@meowwa/chain-domain';
import type { MerchantAdapter, MerchantQuote, OrderConfirmation, RefundConfirmation } from '../adapters/merchant.js';
import { MerchantIdentityConflictError, MerchantReconciliationRepository } from './repository.js';

export interface SettledPurchase {
  requestId: string;
  ownerId: string;
  petId: string;
  quoteId: string;
  merchantId: string;
  productId: string;
  merchantRecipient: string;
  amountMinor: number;
  paymentTransactionHash: `0x${string}`;
  petWalletAddress: string;
}

function digest(value: string): string {
  return createHash('sha512').update(value).digest('hex');
}

function orderId(requestId: string): string { return `mord_${digest(`order:${requestId}`).slice(0, 32)}`; }
function orderReference(requestId: string): string { return `mwo_${digest(`order-reference:${requestId}`).slice(0, 61)}`; }
function refundId(requestId: string): string { return `mref_${digest(`refund:${requestId}`).slice(0, 32)}`; }
function refundReference(requestId: string): string { return `mwr_${digest(`refund-reference:${requestId}`).slice(0, 61)}`; }

function pendingOrder(reason = 'Merchant order reconciliation is pending'): OrderConfirmation {
  return { status: 'pending', reason };
}

export class ControlledMerchantAdapter implements MerchantAdapter {
  readonly kind = 'controlled' as const;
  readonly #repository: MerchantReconciliationRepository;
  readonly #resolvePurchase: (requestId: string) => SettledPurchase | undefined;
  readonly #now: () => Date;

  constructor(options: {
    repository: MerchantReconciliationRepository;
    resolvePurchase(requestId: string): SettledPurchase | undefined;
    now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#resolvePurchase = options.resolvePurchase;
    this.#now = options.now ?? (() => new Date());
  }

  getQuote(now = this.#now()): MerchantQuote {
    return this.getQuoteForProduct(ALPHA_PRODUCT.productId, now);
  }

  getQuoteForProduct(productId: string, now = this.#now()): MerchantQuote {
    const product = POC_CATALOG.find((candidate) => candidate.productId === productId);
    if (!product) throw new Error('Controlled merchant product is unavailable');
    const quote = this.#repository.latestValidQuoteForProduct(productId, now);
    if (!quote) throw new Error('Controlled merchant quote is unavailable');
    const productPrice = quote.amountMinor - quote.taxMinor - quote.shippingMinor - quote.feesMinor;
    if (quote.merchantId !== product.merchantId || !Number.isSafeInteger(productPrice) || productPrice <= 0 || Date.parse(quote.verifiedAt) > now.getTime()) {
      throw new Error('Controlled merchant quote is invalid');
    }
    return {
      quoteId: quote.quoteId,
      merchant: { merchantId: quote.merchantId, name: quote.merchantName, recipient: quote.merchantRecipient },
      product: { productId: quote.productId, merchantId: quote.merchantId, name: quote.productName, category: product.category, priceMinor: productPrice },
      amountMinor: quote.amountMinor, taxMinor: quote.taxMinor, shippingMinor: quote.shippingMinor, feesMinor: quote.feesMinor,
      expiresAt: quote.expiresAt, verified: true,
    };
  }

  confirmOrder(requestId: string): OrderConfirmation {
    const existing = this.#repository.getOrderByRequestId(requestId);
    if (existing) {
      if (['confirmed', 'fulfilled'].includes(existing.status)) {
        return existing.providerOrderId ? { status: 'confirmed', orderId: existing.providerOrderId } : { status: 'failed', reason: 'Confirmed merchant order lacks provider identity' };
      }
      if (['failed', 'cancelled', 'review_required'].includes(existing.status)) return { status: 'failed', reason: 'Merchant order requires review' };
      return pendingOrder();
    }
    const purchase = this.#resolvePurchase(requestId);
    if (!purchase || purchase.requestId !== requestId) return { status: 'failed', reason: 'Settled purchase context is unavailable' };
    const quote = this.#repository.getQuote(purchase.quoteId);
    if (!quote || quote.merchantId !== purchase.merchantId || quote.productId !== purchase.productId ||
        quote.merchantRecipient.toLowerCase() !== purchase.merchantRecipient.toLowerCase() || quote.amountMinor !== purchase.amountMinor) {
      return { status: 'failed', reason: 'Settled purchase does not match authenticated quote' };
    }
    try {
      this.#repository.prepareOrder({
        orderId: orderId(requestId), requestId, ownerId: purchase.ownerId, petId: purchase.petId,
        quoteId: purchase.quoteId, merchantId: purchase.merchantId, productId: purchase.productId,
        merchantRecipient: purchase.merchantRecipient, petWalletAddress: purchase.petWalletAddress,
        amountMinor: purchase.amountMinor, amountAtomic: (BigInt(purchase.amountMinor) * 10_000n).toString(),
        paymentTransactionHash: purchase.paymentTransactionHash, providerReference: orderReference(requestId),
      });
      return pendingOrder();
    } catch (error) {
      return { status: 'failed', reason: error instanceof MerchantIdentityConflictError ? 'Merchant order identity conflict' : 'Merchant order could not be prepared' };
    }
  }

  verifyOrder(requestId: string, providerOrderId: string): boolean {
    const order = this.#repository.getOrderByRequestId(requestId);
    return order !== undefined && ['confirmed', 'fulfilled'].includes(order.status) && order.providerOrderId === providerOrderId;
  }

  refundOrder(requestId: string): RefundConfirmation {
    const existing = this.#repository.getRefundByRequestId(requestId);
    if (existing) {
      if (['failed', 'review_required'].includes(existing.status)) return { status: 'failed', reason: 'Merchant refund requires review' };
      return { status: 'pending', refundId: existing.refundId, reason: 'Merchant refund reconciliation is pending' };
    }
    const order = this.#repository.getOrderByRequestId(requestId);
    if (!order || !['confirmed', 'fulfilled'].includes(order.status) || !order.providerOrderId) {
      return { status: 'failed', reason: 'No confirmed controlled merchant order can be refunded' };
    }
    try {
      const prepared = this.#repository.prepareRefund({
        refundId: refundId(requestId), orderId: order.orderId, requestId,
        amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: refundReference(requestId),
      });
      return { status: 'pending', refundId: prepared.refundId, reason: 'Merchant refund reconciliation is pending' };
    } catch {
      return { status: 'failed', reason: 'Merchant refund could not be prepared' };
    }
  }
}
