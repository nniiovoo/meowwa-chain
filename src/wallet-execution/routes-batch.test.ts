import { describe, expect, it, vi } from 'vitest';
import type { WalletExecutionReconciler } from './reconciler.js';
import type { WalletExecutionRepository } from './repository.js';
import {
  WalletExecutionBatchError,
  reconcileWalletExecutionBatch,
  requireSuccessfulWalletExecutionBatch,
} from './routes.js';

describe('wallet execution batch isolation', () => {
  function harness() {
    const repository = {
      listReconcileCandidates: vi.fn(() => [
        { submissionId: 'wex_bad' }, { submissionId: 'wex_confirmed' }, { submissionId: 'wex_review' },
      ]),
    } as unknown as WalletExecutionRepository;
    const reconciler = {
      reconcile: vi.fn(async (submissionId: string) => {
        if (submissionId === 'wex_bad') throw new Error('RPC unavailable');
        return { status: submissionId === 'wex_confirmed' ? 'confirmed' : 'review_required' };
      }),
    } as unknown as WalletExecutionReconciler;
    return { repository, reconciler };
  }

  it('continues after one record fails and returns an observable failure count', async () => {
    const value = harness();

    await expect(reconcileWalletExecutionBatch(value, 25)).resolves.toEqual({
      attempted: 3, confirmed: 1, reviewRequired: 1, failed: 1,
    });
    expect(value.reconciler.reconcile).toHaveBeenCalledTimes(3);
  });

  it('turns a nonzero failure count into a scheduled-worker error', async () => {
    const value = harness();
    const summary = await reconcileWalletExecutionBatch(value, 25);

    expect(() => requireSuccessfulWalletExecutionBatch(summary)).toThrow(expect.objectContaining({
      summary: { attempted: 3, confirmed: 1, reviewRequired: 1, failed: 1 },
    }));
    expect(() => requireSuccessfulWalletExecutionBatch(summary)).toThrow(WalletExecutionBatchError);
  });
});
