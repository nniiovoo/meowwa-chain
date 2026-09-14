import { describe, expect, it, vi } from 'vitest';
import {
  MerchantReconciliationBatchError,
  reconcileMerchantBatch,
  reconcileMerchantBatchForWorker,
} from './routes.js';
import type { MerchantReconciliationRepository } from './repository.js';
import { MerchantReconciliationWorker, type MerchantReconciler } from './reconciler.js';

describe('merchant reconciliation batch isolation', () => {
  it('continues later orders and refunds after one record fails', async () => {
    const repository = {
      listOrderCandidates: vi.fn(() => [{ orderId: 'order_bad' }, { orderId: 'order_good' }]),
      listRefundCandidates: vi.fn(() => [{ refundId: 'refund_good' }]),
    } as unknown as MerchantReconciliationRepository;
    const reconciler = {
      reconcileOrder: vi.fn(async (orderId: string) => {
        if (orderId === 'order_bad') throw new Error('provider unavailable');
      }),
      reconcileRefund: vi.fn(async () => undefined),
    } as unknown as MerchantReconciler;

    await expect(reconcileMerchantBatch({ repository, reconciler }, 25)).resolves.toEqual({
      ordersAttempted: 2, refundsAttempted: 1, ordersFailed: 1, refundsFailed: 0,
    });
    expect(reconciler.reconcileOrder).toHaveBeenCalledTimes(2);
    expect(reconciler.reconcileRefund).toHaveBeenCalledOnce();
  });

  it('surfaces nonzero failure counts through the scheduled worker error path', async () => {
    const repository = {
      listOrderCandidates: vi.fn(() => [{ orderId: 'order_bad' }]),
      listRefundCandidates: vi.fn(() => []),
    } as unknown as MerchantReconciliationRepository;
    const reconciler = {
      reconcileOrder: vi.fn(async () => { throw new Error('provider unavailable'); }),
      reconcileRefund: vi.fn(async () => undefined),
    } as unknown as MerchantReconciler;
    const onError = vi.fn();
    const worker = new MerchantReconciliationWorker(async () => {
      await reconcileMerchantBatchForWorker({ repository, reconciler }, 25);
    });

    worker.start(1_000, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await worker.stop();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(MerchantReconciliationBatchError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      summary: { ordersAttempted: 1, refundsAttempted: 0, ordersFailed: 1, refundsFailed: 0 },
    });
  });
});
