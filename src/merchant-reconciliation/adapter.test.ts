import { describe, expect, it } from 'vitest';
import { ControlledMerchantAdapter } from './adapter.js';
import { MerchantReconciliationRepository } from './repository.js';

const now = () => new Date('2026-07-15T12:00:00.000Z');
const quote = {
  quoteId: 'quote_provider_001', providerRevision: 'rev_001', merchantId: 'merchant_approved_1',
  merchantName: 'MeowWa Controlled Merchant', merchantRecipient: '0x1111111111111111111111111111111111111111',
  productId: 'product_usual_food_1', productName: 'Usual Food', amountMinor: 1299, taxMinor: 0,
  shippingMinor: 0, feesMinor: 0, expiresAt: '2026-07-15T12:05:00.000Z', verifiedAt: now().toISOString(),
};
const toyQuote = {
  ...quote, quoteId: 'quote_provider_toy_001', productId: 'product_toy_feather_1', productName: 'Interactive feather wand', amountMinor: 899,
};
const transactionHash = `0x${'1'.repeat(64)}` as `0x${string}`;

describe('controlled merchant adapter', () => {
  it('reads an authenticated cached quote and only prepares merchant work after payment', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote(quote);
    const adapter = new ControlledMerchantAdapter({
      repository, now,
      resolvePurchase: () => ({
        requestId: 'request_001', ownerId: 'owner_001', petId: 'pet_001', quoteId: quote.quoteId,
        merchantId: quote.merchantId, productId: quote.productId, merchantRecipient: quote.merchantRecipient,
        amountMinor: quote.amountMinor, paymentTransactionHash: transactionHash,
        petWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });
    expect(adapter.kind).toBe('controlled');
    expect(adapter.getQuote?.(now())).toMatchObject({ quoteId: quote.quoteId, verified: true });
    const result = adapter.confirmOrder('request_001');
    expect(result).toMatchObject({ status: 'pending' });
    const durable = repository.getOrderByRequestId('request_001');
    expect(durable).toMatchObject({ status: 'prepared', providerOrderId: null, internalSettledAt: null });
    expect(adapter.verifyOrder?.('request_001', 'made_up_order')).toBe(false);
    repository.close();
  });

  it('only prepares a refund for a durably confirmed exact order', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote(quote);
    const adapter = new ControlledMerchantAdapter({ repository, now, resolvePurchase: () => ({
      requestId: 'request_001', ownerId: 'owner_001', petId: 'pet_001', quoteId: quote.quoteId,
      merchantId: quote.merchantId, productId: quote.productId, merchantRecipient: quote.merchantRecipient,
      amountMinor: quote.amountMinor, paymentTransactionHash: transactionHash,
      petWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }) });
    expect(adapter.refundOrder?.('request_001')).toMatchObject({ status: 'failed' });
    adapter.confirmOrder('request_001');
    let order = repository.getOrderByRequestId('request_001')!;
    order = repository.markOrderSubmitting(order.orderId, order.version);
    order = repository.markOrderSubmitted(order.orderId, order.version, 'provider_order_001');
    repository.confirmOrder(order.orderId, order.version, 'provider_order_001');
    expect(adapter.verifyOrder?.('request_001', 'provider_order_001')).toBe(true);
    expect(adapter.refundOrder?.('request_001')).toMatchObject({ status: 'pending' });
    expect(repository.getRefundByRequestId('request_001')).toMatchObject({ status: 'prepared', providerRefundId: null });
    repository.close();
  });

  it('returns only authenticated product-specific quotes with their controlled category', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote(quote);
    repository.putQuote(toyQuote);
    const adapter = new ControlledMerchantAdapter({ repository, now, resolvePurchase: () => undefined });
    expect(adapter.getQuoteForProduct?.('product_toy_feather_1', now())).toMatchObject({
      quoteId: toyQuote.quoteId, product: { productId: toyQuote.productId, category: 'TOYS_ENRICHMENT', priceMinor: 899 },
    });
    expect(() => adapter.getQuoteForProduct?.('product_treat_1', now())).toThrow(/quote is unavailable/i);
    expect(() => adapter.getQuoteForProduct?.('product_unreviewed', now())).toThrow(/product is unavailable/i);
    repository.close();
  });
});
