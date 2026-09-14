import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainEvidenceMismatchError, type BaseSepoliaExecutionReader } from '../wallet-execution/chain.js';
import { MerchantReconciliationRepository } from './repository.js';
import { MerchantReconciler } from './reconciler.js';
import type { ControlledMerchantProvider } from './provider.js';

const now = () => new Date('2026-07-15T12:00:00.000Z');
const quote = {
  quoteId: 'quote_provider_001', providerRevision: 'rev_001', merchantId: 'merchant_approved_1',
  merchantName: 'MeowWa Controlled Merchant', merchantRecipient: '0x1111111111111111111111111111111111111111',
  productId: 'product_usual_food_1', productName: 'Usual Food', amountMinor: 1299, taxMinor: 0,
  shippingMinor: 0, feesMinor: 0, expiresAt: '2026-07-15T12:05:00.000Z', verifiedAt: now().toISOString(),
};
const transactionHash = `0x${'1'.repeat(64)}` as `0x${string}`;
const refundHash = `0x${'2'.repeat(64)}` as `0x${string}`;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(databasePath = ':memory:') {
  const repository = new MerchantReconciliationRepository(databasePath, { now });
  repository.putQuote(quote);
  const order = repository.prepareOrder({
    orderId: 'mord_0123456789abcdef', requestId: 'request_001', ownerId: 'owner_001', petId: 'pet_001',
    quoteId: quote.quoteId, merchantId: quote.merchantId, productId: quote.productId,
    merchantRecipient: quote.merchantRecipient, petWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    amountMinor: quote.amountMinor, amountAtomic: '12990000', paymentTransactionHash: transactionHash,
    providerReference: `mwo_${'a'.repeat(61)}`,
  });
  const provider: ControlledMerchantProvider = {
    fetchQuotes: vi.fn(async () => [quote]),
    createOrder: vi.fn(async () => ({ providerReference: order.providerReference, providerOrderId: 'provider_order_001', status: 'confirmed' as const })),
    getOrder: vi.fn(async () => undefined),
    createRefund: vi.fn(async (input) => ({ providerReference: input.providerReference, providerRefundId: 'provider_refund_001', status: 'confirmed' as const, transactionHash: refundHash })),
    getRefund: vi.fn(async () => undefined),
  };
  const chain: BaseSepoliaExecutionReader = { verifyTransfer: vi.fn(async () => ({
    transactionHash: refundHash, blockHash: `0x${'3'.repeat(64)}` as `0x${string}`,
    blockNumber: 42, logIndex: 3, confirmedAtBlock: 45,
  })) };
  const settleOrder = vi.fn(async () => undefined);
  const settleRefund = vi.fn(async () => undefined);
  const reconciler = new MerchantReconciler({ repository, provider, chain, confirmations: 3, settleOrder, settleRefund, now });
  return { repository, order, provider, chain, settleOrder, settleRefund, reconciler };
}

function reopenedReconciler(
  repository: MerchantReconciliationRepository,
  harness: ReturnType<typeof setup>,
): MerchantReconciler {
  return new MerchantReconciler({
    repository, provider: harness.provider, chain: harness.chain, confirmations: 3,
    settleOrder: harness.settleOrder, settleRefund: harness.settleRefund, now,
  });
}

describe('merchant reconciler', () => {
  it('settles a provider-confirmed order idempotently', async () => {
    const harness = setup();
    const confirmed = await harness.reconciler.reconcileOrder(harness.order.orderId);
    expect(confirmed).toMatchObject({ status: 'confirmed', providerOrderId: 'provider_order_001' });
    expect(harness.settleOrder).toHaveBeenCalledTimes(1);
    expect(harness.repository.getOrder(harness.order.orderId)?.internalSettledAt).toBe(now().toISOString());
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    expect(harness.settleOrder).toHaveBeenCalledTimes(1);
    harness.repository.close();
  });

  it('treats provider timeouts as unknown rather than success or failure', async () => {
    const harness = setup();
    vi.mocked(harness.provider.createOrder).mockRejectedValueOnce(new Error('timeout'));
    const result = await harness.reconciler.reconcileOrder(harness.order.orderId);
    expect(result.status).toBe('unknown');
    expect(harness.settleOrder).not.toHaveBeenCalled();
    await expect(harness.reconciler.reconcileOrder(harness.order.orderId)).resolves.toMatchObject({
      status: 'confirmed', internalSettledAt: now().toISOString(),
    });
    expect(harness.provider.getOrder).toHaveBeenCalledOnce();
    expect(harness.provider.createOrder).toHaveBeenCalledTimes(2);
    expect(vi.mocked(harness.provider.createOrder).mock.calls[0]?.[0].providerReference)
      .toBe(vi.mocked(harness.provider.createOrder).mock.calls[1]?.[0].providerReference);
    harness.repository.close();
  });

  it('bounds blind order creation and escalates a permanently rejected paid order to review', async () => {
    // The payment already settled on chain, so a permanent createOrder rejection (an expired
    // quoteId, a gateway schema change) used to be retried on every poll forever while the batch
    // reported zero failures: nothing bought, nothing refundable, nothing telling an operator.
    const harness = setup();
    vi.mocked(harness.provider.createOrder).mockRejectedValue(new Error('Merchant gateway returned HTTP 400'));
    for (let pass = 0; pass < 8; pass += 1) await harness.reconciler.reconcileOrder(harness.order.orderId);
    // The first submission plus exactly three bounded blind replays, not one per poll.
    expect(harness.provider.createOrder).toHaveBeenCalledTimes(4);
    expect(harness.repository.getOrder(harness.order.orderId)).toMatchObject({
      status: 'review_required', failureCode: 'blind-create-attempts-exhausted',
    });
    expect(harness.repository.listOrderCandidates().map(({ orderId }) => orderId)).not.toContain(harness.order.orderId);
    harness.repository.close();
  });

  it('recovers a durably persisted submitting order after process restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-merchant-order-crash-')); directories.push(directory);
    const path = join(directory, 'merchant.sqlite');
    const harness = setup(path);
    const submitting = harness.repository.markOrderSubmitting(harness.order.orderId, harness.order.version);
    expect(harness.repository.listOrderCandidates()).toEqual([
      expect.objectContaining({ orderId: submitting.orderId, status: 'submitting' }),
    ]);
    harness.repository.close();

    const reopened = new MerchantReconciliationRepository(path, { now });
    const recovered = await reopenedReconciler(reopened, harness).reconcileOrder(submitting.orderId);

    expect(recovered).toMatchObject({
      status: 'confirmed', providerOrderId: 'provider_order_001', internalSettledAt: now().toISOString(),
    });
    expect(harness.provider.createOrder).toHaveBeenCalledOnce();
    expect(harness.provider.getOrder).not.toHaveBeenCalled();
    reopened.close();
  });

  it('does not settle a refund until exact canonical chain proof succeeds', async () => {
    const harness = setup();
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const refund = harness.repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    vi.mocked(harness.chain.verifyTransfer).mockRejectedValueOnce(new ChainEvidenceMismatchError('wrong transfer'));
    const review = await harness.reconciler.reconcileRefund(refund.refundId);
    expect(review.status).toBe('review_required');
    expect(harness.settleRefund).not.toHaveBeenCalled();
    harness.repository.close();
  });

  it('keeps transient refund RPC failures retryable', async () => {
    const harness = setup();
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const refund = harness.repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    vi.mocked(harness.chain.verifyTransfer).mockRejectedValueOnce(new Error('RPC unavailable'));

    await expect(harness.reconciler.reconcileRefund(refund.refundId)).rejects.toThrow('RPC unavailable');
    expect(harness.repository.getRefund(refund.refundId)).toMatchObject({ status: 'provider_confirmed' });
    expect(harness.repository.listRefundCandidates()).toEqual([
      expect.objectContaining({ refundId: refund.refundId, status: 'provider_confirmed' }),
    ]);
    harness.repository.close();
  });

  it('settles one exact refund only after provider and chain confirmation', async () => {
    const harness = setup();
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const refund = harness.repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    const settled = await harness.reconciler.reconcileRefund(refund.refundId);
    expect(settled.status).toBe('chain_confirmed');
    expect(harness.chain.verifyTransfer).toHaveBeenCalledWith({
      transactionHash: refundHash, sender: quote.merchantRecipient,
      recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amountAtomic: '12990000', confirmations: 3,
    });
    expect(harness.settleRefund).toHaveBeenCalledTimes(1);
    await harness.reconciler.reconcileRefund(refund.refundId);
    expect(harness.settleRefund).toHaveBeenCalledTimes(1);
    harness.repository.close();
  });

  it('bounds blind refund creation and escalates a permanently rejected refund to review', async () => {
    // The refund twin of the order bound above. Each blind replay can issue a SECOND refund for one
    // payment, and a permanent createRefund rejection would otherwise retry on every poll forever
    // while the batch reported zero failures. The bound existed only on the order side; deleting the
    // recordRefundBlindCreateAttempt guard in reconciler.ts fails this test.
    const harness = setup();
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const refund = harness.repository.prepareRefund({
      refundId: 'mref_00000000deadbeef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'c'.repeat(61)}`,
    });
    vi.mocked(harness.provider.createRefund).mockRejectedValue(new Error('Merchant gateway returned HTTP 400'));

    for (let pass = 0; pass < 8; pass += 1) await harness.reconciler.reconcileRefund(refund.refundId);

    // The first submission plus exactly three bounded blind replays, not one per poll.
    expect(harness.provider.createRefund).toHaveBeenCalledTimes(4);
    expect(harness.repository.getRefund(refund.refundId)).toMatchObject({
      status: 'review_required', failureCode: 'blind-create-attempts-exhausted',
    });
    harness.repository.close();
  });

  it('durably reviews a late provider confirmation after a refund already failed', async () => {
    const harness = setup();
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const prepared = harness.repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    const failed = harness.repository.failRefund(prepared.refundId, prepared.version, 'provider-refund-failed');

    expect(harness.reconciler.recordRefundEvidence({
      providerReference: failed.providerReference,
      providerRefundId: 'provider_refund_late_confirmation',
      status: 'confirmed',
      transactionHash: refundHash,
    })).toMatchObject({ status: 'review_required', failureCode: 'provider-refund-terminal-conflict' });
    expect(harness.repository.eventsFor('refund', failed.refundId).at(-1)).toMatchObject({
      kind: 'refund_review_required', fromStatus: 'failed', toStatus: 'review_required',
    });
    harness.repository.close();
  });

  it('recovers a durably persisted submitting refund after process restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-merchant-refund-crash-')); directories.push(directory);
    const path = join(directory, 'merchant.sqlite');
    const harness = setup(path);
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const prepared = harness.repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    const submitting = harness.repository.markRefundSubmitting(prepared.refundId, prepared.version);
    expect(harness.repository.listRefundCandidates()).toEqual([
      expect.objectContaining({ refundId: submitting.refundId, status: 'submitting' }),
    ]);
    harness.repository.close();

    const reopened = new MerchantReconciliationRepository(path, { now });
    const recovered = await reopenedReconciler(reopened, harness).reconcileRefund(submitting.refundId);

    expect(recovered).toMatchObject({
      status: 'chain_confirmed', providerRefundId: 'provider_refund_001', internalSettledAt: now().toISOString(),
    });
    expect(harness.provider.createRefund).toHaveBeenCalledOnce();
    expect(harness.provider.getRefund).not.toHaveBeenCalled();
    reopened.close();
  });

  it('replays an unknown refund with the same idempotency reference after authoritative provider not-found', async () => {
    const harness = setup();
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const refund = harness.repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    vi.mocked(harness.provider.createRefund).mockRejectedValueOnce(new Error('timeout after provider acceptance'));

    await expect(harness.reconciler.reconcileRefund(refund.refundId)).resolves.toMatchObject({ status: 'unknown' });
    await expect(harness.reconciler.reconcileRefund(refund.refundId)).resolves.toMatchObject({
      status: 'chain_confirmed', internalSettledAt: now().toISOString(),
    });
    expect(harness.provider.getRefund).toHaveBeenCalledOnce();
    expect(harness.provider.createRefund).toHaveBeenCalledTimes(2);
    expect(vi.mocked(harness.provider.createRefund).mock.calls[0]?.[0].providerReference)
      .toBe(vi.mocked(harness.provider.createRefund).mock.calls[1]?.[0].providerReference);
    harness.repository.close();
  });

  it('retries idempotent internal refund settlement after a post-chain crash', async () => {
    const harness = setup();
    await harness.reconciler.reconcileOrder(harness.order.orderId);
    const order = harness.repository.getOrder(harness.order.orderId)!;
    const refund = harness.repository.prepareRefund({
      refundId: 'mref_0123456789abcdef', orderId: order.orderId, requestId: order.requestId,
      amountMinor: order.amountMinor, amountAtomic: order.amountAtomic, providerReference: `mwr_${'b'.repeat(61)}`,
    });
    harness.settleRefund.mockRejectedValueOnce(new Error('state persistence unavailable'));
    await expect(harness.reconciler.reconcileRefund(refund.refundId)).rejects.toThrow('state persistence');
    expect(harness.repository.getRefund(refund.refundId)).toMatchObject({ status: 'chain_confirmed', internalSettledAt: null });
    expect(harness.repository.listRefundCandidates()).toHaveLength(1);
    await harness.reconciler.reconcileRefund(refund.refundId);
    expect(harness.settleRefund).toHaveBeenCalledTimes(2);
    expect(harness.repository.getRefund(refund.refundId)?.internalSettledAt).toBe(now().toISOString());
    harness.repository.close();
  });

  it('durably records an over-long provider failure reason instead of stranding a paid order', async () => {
    const harness = setup();
    const reason = `card declined: ${'x'.repeat(285)}`;
    const failure = { providerReference: harness.order.providerReference, providerOrderId: 'provider_order_001', status: 'failed' as const, reason };
    harness.provider.createOrder = vi.fn(async () => failure);
    harness.provider.getOrder = vi.fn(async () => failure);

    const failed = await harness.reconciler.reconcileOrder(harness.order.orderId);
    expect(failed.status).toBe('failed');
    expect(failed.failureCode).toHaveLength(255);

    // Re-delivery of the same over-long reason must compare against the stored truncation,
    // not the raw provider text, or the terminal order is escalated to review_required.
    expect((await harness.reconciler.reconcileOrder(harness.order.orderId)).status).toBe('failed');
    expect(harness.reconciler.recordOrderEvidence(failure)?.status).toBe('failed');
    harness.repository.close();
  });
});
