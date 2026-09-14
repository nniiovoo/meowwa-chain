import { describe, expect, it } from 'vitest';
import { MerchantIdentityConflictError, MerchantReconciliationRepository } from './repository.js';

const now = () => new Date('2026-07-15T12:00:00.000Z');
const quote = {
  quoteId: 'quote_provider_001', providerRevision: 'rev_001', merchantId: 'merchant_approved_1',
  merchantName: 'MeowWa Controlled Merchant', merchantRecipient: '0x1111111111111111111111111111111111111111',
  productId: 'product_usual_food_1', productName: 'Usual Food', amountMinor: 1299, taxMinor: 0,
  shippingMinor: 0, feesMinor: 0, expiresAt: '2026-07-15T12:05:00.000Z', verifiedAt: '2026-07-15T12:00:00.000Z',
};
const order = {
  orderId: 'mord_0123456789abcdef', requestId: 'request_001', ownerId: 'owner_001', petId: 'pet_001',
  quoteId: quote.quoteId, merchantId: quote.merchantId, productId: quote.productId,
  merchantRecipient: quote.merchantRecipient, petWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  amountMinor: 1299, amountAtomic: '12990000', paymentTransactionHash: `0x${'1'.repeat(64)}` as `0x${string}`,
  providerReference: `mwo_${'a'.repeat(61)}`,
};

describe('merchant reconciliation repository', () => {
  it('applies migrations and caches only immutable quote identities', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    expect(repository.appliedMigrationVersions()).toEqual([1, 2, 3, 4, 5]);
    expect(repository.putQuote(quote)).toMatchObject(quote);
    expect(repository.putQuote(quote)).toMatchObject(quote);
    expect(repository.latestValidQuote(now())).toMatchObject(quote);
    expect(repository.latestValidQuoteForProduct(quote.productId, now())).toMatchObject(quote);
    expect(repository.latestValidQuoteForProduct('product_toy_feather_1', now())).toBeUndefined();
    expect(() => repository.putQuote({ ...quote, amountMinor: 1300 })).toThrow(MerchantIdentityConflictError);
    repository.close();
  });

  it('ignores future quotes while returning the newest quote already valid at the requested time', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote({ ...quote, quoteId: 'quote_current', verifiedAt: '2026-07-15T11:59:00.000Z' });
    repository.putQuote({
      ...quote, quoteId: 'quote_future', providerRevision: 'rev_002',
      verifiedAt: '2026-07-15T12:10:00.000Z', expiresAt: '2026-07-15T12:20:00.000Z',
    });

    expect(repository.latestValidQuote(now())?.quoteId).toBe('quote_current');
    expect(repository.latestValidQuoteForProduct(quote.productId, now())?.quoteId).toBe('quote_current');
    repository.close();
  });

  it('rejects a quote whose expiry is not after verification', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });

    expect(() => repository.putQuote({
      ...quote,
      quoteId: 'quote_equal_window',
      expiresAt: quote.verifiedAt,
    })).toThrow(/quote window/i);
    expect(() => repository.putQuote({
      ...quote,
      quoteId: 'quote_reversed_window',
      expiresAt: '2026-07-15T11:59:59.000Z',
    })).toThrow(/quote window/i);
    repository.close();
  });

  it('rejects order and refund records whose minor and atomic amounts disagree', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote(quote);
    expect(() => repository.prepareOrder({ ...order, amountAtomic: '1' })).toThrow(/atomic amount/i);
    expect(() => repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: '1', providerReference: `mwr_${'b'.repeat(61)}`,
    })).toThrow(/atomic amount/i);
    repository.close();
  });

  it('enforces order identity, transitions, optimistic concurrency, and unique provider IDs', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote(quote);
    const prepared = repository.prepareOrder(order);
    expect(repository.prepareOrder(order)).toEqual(prepared);
    expect(() => repository.prepareOrder({ ...order, amountMinor: 1300, amountAtomic: '13000000' }))
      .toThrow(MerchantIdentityConflictError);
    const submitting = repository.markOrderSubmitting(prepared.orderId, prepared.version);
    expect(() => repository.markOrderSubmitting(prepared.orderId, prepared.version)).toThrow('stale');
    const submitted = repository.markOrderSubmitted(submitting.orderId, submitting.version, 'provider_order_001');
    const confirmed = repository.confirmOrder(submitted.orderId, submitted.version, 'provider_order_001');
    expect(confirmed.status).toBe('confirmed');
    expect(repository.eventsFor('order', prepared.orderId).map((event) => event.kind)).toEqual([
      'order_prepared', 'order_submission_started', 'order_submitted', 'order_confirmed',
    ]);
    repository.close();
  });

  it('keeps provider-confirmed refunds unsettled until unique chain evidence is recorded', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote(quote);
    let durableOrder = repository.prepareOrder(order);
    durableOrder = repository.markOrderSubmitting(durableOrder.orderId, durableOrder.version);
    durableOrder = repository.markOrderSubmitted(durableOrder.orderId, durableOrder.version, 'provider_order_001');
    durableOrder = repository.confirmOrder(durableOrder.orderId, durableOrder.version, 'provider_order_001');
    const refund = repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: durableOrder.orderId, requestId: durableOrder.requestId,
      amountMinor: durableOrder.amountMinor, amountAtomic: durableOrder.amountAtomic,
      providerReference: `mwr_${'b'.repeat(61)}`,
    });
    const submitting = repository.markRefundSubmitting(refund.refundId, refund.version);
    const submitted = repository.markRefundSubmitted(submitting.refundId, submitting.version, 'provider_refund_001');
    const providerConfirmed = repository.confirmRefundProvider(submitted.refundId, submitted.version, {
      providerRefundId: 'provider_refund_001', transactionHash: `0x${'2'.repeat(64)}`,
    });
    expect(providerConfirmed.status).toBe('provider_confirmed');
    expect(providerConfirmed.blockHash).toBeNull();
    const settled = repository.confirmRefundChain(providerConfirmed.refundId, providerConfirmed.version, {
      transactionHash: `0x${'2'.repeat(64)}`, blockHash: `0x${'3'.repeat(64)}`, blockNumber: 42, logIndex: 3,
      confirmedAt: now().toISOString(),
    });
    expect(settled.status).toBe('chain_confirmed');
    expect(() => repository.confirmRefundChain(providerConfirmed.refundId, providerConfirmed.version, {
      transactionHash: `0x${'2'.repeat(64)}`, blockHash: `0x${'4'.repeat(64)}`, blockNumber: 43, logIndex: 4,
      confirmedAt: now().toISOString(),
    })).toThrow('stale');
    repository.close();
  });

  it('deduplicates signed webhook deliveries and rejects delivery identity reuse', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    const delivery = { deliveryId: 'merchant_event_001', eventType: 'order.confirmed', payloadSha256: 'c'.repeat(64) };
    expect(repository.recordWebhookDelivery(delivery)).toBe(true);
    expect(repository.recordWebhookDelivery(delivery)).toBe(false);
    expect(repository.isWebhookProcessed(delivery.deliveryId)).toBe(false);
    expect(repository.markWebhookProcessed(delivery.deliveryId)).toBe(true);
    expect(repository.isWebhookProcessed(delivery.deliveryId)).toBe(true);
    expect(() => repository.recordWebhookDelivery({ ...delivery, payloadSha256: 'd'.repeat(64) })).toThrow(MerchantIdentityConflictError);
    repository.close();
  });

  it('includes crash states and fulfilled-but-unsettled orders in fair reconciliation', () => {
    const repository = new MerchantReconciliationRepository(':memory:', { now });
    repository.putQuote(quote);
    const prepared = repository.prepareOrder(order);
    const submitting = repository.markOrderSubmitting(prepared.orderId, prepared.version);
    expect(repository.listOrderCandidates()).toEqual([
      expect.objectContaining({ orderId: submitting.orderId, status: 'submitting' }),
    ]);
    const submitted = repository.markOrderSubmitted(submitting.orderId, submitting.version, 'provider_order_001');
    const confirmed = repository.confirmOrder(submitted.orderId, submitted.version, 'provider_order_001');
    const fulfilled = repository.fulfillOrder(confirmed.orderId, confirmed.version);
    expect(repository.listOrderCandidates()).toEqual([
      expect.objectContaining({ orderId: fulfilled.orderId, status: 'fulfilled', internalSettledAt: null }),
    ]);
    const refund = repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: fulfilled.orderId, requestId: fulfilled.requestId,
      amountMinor: fulfilled.amountMinor, amountAtomic: fulfilled.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    const submittingRefund = repository.markRefundSubmitting(refund.refundId, refund.version);
    expect(repository.listRefundCandidates()).toEqual([
      expect.objectContaining({ refundId: submittingRefund.refundId, status: 'submitting' }),
    ]);
    repository.markOrderReconcileAttempt(fulfilled.orderId);
    repository.close();
  });
});
