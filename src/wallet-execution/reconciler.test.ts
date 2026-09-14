import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import { ChainConfirmationPendingError, ChainEvidenceMismatchError, type BaseSepoliaExecutionReader } from './chain.js';
import type { WalletExecutionStatusProvider } from './provider.js';
import { WalletExecutionReconciler, WalletExecutionReconciliationWorker } from './reconciler.js';
import { WalletExecutionRepository } from './repository.js';

const now = () => new Date('2026-07-14T23:05:00.000Z');
const referenceId = `mw_${'b'.repeat(61)}`;
const transactionHash = `0x${'e'.repeat(64)}` as `0x${string}`;
const blockHash = `0x${'f'.repeat(64)}` as `0x${string}`;

function repository(): WalletExecutionRepository {
  const value = new WalletExecutionRepository(':memory:', { now });
  const prepared = value.prepare({
    submissionId: 'wex_123', requestId: 'request_123', ownerId: 'owner_1', petId: 'pet_mochi',
    bindingId: 'wcb_123', providerWalletId: 'embedded_123', intentHash: 'a'.repeat(64), referenceId,
    chainId: 84532, contract: BASE_SEPOLIA_USDC, sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    recipient: '0x1111111111111111111111111111111111111111', amountAtomic: '12990000', valueAtomic: '0',
    calldata: `0x${'c'.repeat(136)}`,
  });
  const submitting = value.markSubmitting(prepared.submissionId, prepared.version);
  value.markSubmitted(submitting.submissionId, submitting.version, {
    providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null,
  });
  return value;
}

function ambiguousRepository(): WalletExecutionRepository {
  const value = new WalletExecutionRepository(':memory:', { now });
  const prepared = value.prepare({
    submissionId: 'wex_ambiguous', requestId: 'request_ambiguous', ownerId: 'owner_1', petId: 'pet_mochi',
    bindingId: 'wcb_123', providerWalletId: 'embedded_123', intentHash: '9'.repeat(64), referenceId,
    chainId: 84532, contract: BASE_SEPOLIA_USDC, sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    recipient: '0x1111111111111111111111111111111111111111', amountAtomic: '12990000', valueAtomic: '0',
    calldata: `0x${'c'.repeat(136)}`,
  });
  const submitting = value.markSubmitting(prepared.submissionId, prepared.version);
  value.markUnknown(submitting.submissionId, submitting.version, 'provider-outcome-unknown');
  return value;
}

function provider(overrides: Record<string, unknown> = {}): WalletExecutionStatusProvider {
  return { getTransaction: vi.fn(async () => ({
    providerTransactionId: 'privy_tx_123', status: 'confirmed' as const, caip2: 'eip155:84532',
    providerWalletId: 'embedded_123', referenceId, transactionHash, ...overrides,
  })) };
}

function chain(): BaseSepoliaExecutionReader {
  return { verifyTransfer: vi.fn(async () => ({ transactionHash, blockHash, blockNumber: 1000, logIndex: 7, confirmedAtBlock: 1012 })) };
}

describe('wallet execution reconciliation', () => {
  it('settles internally only after exact provider and independent chain evidence', async () => {
    const store = repository();
    const status = provider();
    const base = chain();
    const settle = vi.fn(async () => undefined);
    const reconciler = new WalletExecutionReconciler({ repository: store, provider: status, chain: base, confirmations: 12, settle, now });
    await expect(reconciler.reconcile('wex_123')).resolves.toMatchObject({ status: 'confirmed', blockNumber: 1000, logIndex: 7 });
    expect(base.verifyTransfer).toHaveBeenCalledWith({
      transactionHash, sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      recipient: '0x1111111111111111111111111111111111111111', amountAtomic: '12990000', confirmations: 12,
    });
    expect(settle).toHaveBeenCalledWith({ requestId: 'request_123', transactionHash, submissionId: referenceId });
    await reconciler.reconcile('wex_123');
    expect(status.getTransaction).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(store.getById('wex_123')).toMatchObject({ applicationSettledAt: now().toISOString() });
    store.close();
  });

  it('retries application settlement after a confirmed-chain callback failure', async () => {
    const store = repository();
    const settle = vi.fn()
      .mockRejectedValueOnce(new Error('snapshot save failed'))
      .mockResolvedValueOnce(undefined);
    const reconciler = new WalletExecutionReconciler({
      repository: store, provider: provider(), chain: chain(), confirmations: 12, settle, now,
    });

    await expect(reconciler.reconcile('wex_123')).rejects.toThrow('snapshot save failed');
    expect(store.listReconcileCandidates()).toEqual([
      expect.objectContaining({ submissionId: 'wex_123', status: 'confirmed', applicationSettledAt: null }),
    ]);
    await expect(reconciler.reconcile('wex_123')).resolves.toMatchObject({
      status: 'confirmed', applicationSettledAt: now().toISOString(),
    });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(store.listReconcileCandidates()).toEqual([]);
    store.close();
  });

  it('leases reconciliation so concurrent workers invoke application settlement only once', async () => {
    const store = repository();
    const submitted = store.getById('wex_123')!;
    const providerConfirmed = store.markProviderConfirmed(submitted.submissionId, submitted.version, {
      providerTransactionId: 'privy_tx_123', transactionHash,
    });
    store.confirmChain(providerConfirmed.submissionId, providerConfirmed.version, {
      transactionHash, blockHash, blockNumber: 1000, logIndex: 7, confirmedAt: now().toISOString(),
    });
    let finishSettlement!: () => void;
    const settlementBlocked = new Promise<void>((resolve) => { finishSettlement = resolve; });
    const settle = vi.fn(() => settlementBlocked);
    const firstWorker = new WalletExecutionReconciler({
      repository: store, provider: provider(), chain: chain(), confirmations: 12, settle, now,
    });
    const secondWorker = new WalletExecutionReconciler({
      repository: store, provider: provider(), chain: chain(), confirmations: 12, settle, now,
    });

    const first = firstWorker.reconcile('wex_123');
    await vi.waitFor(() => { expect(settle).toHaveBeenCalledOnce(); });
    await expect(secondWorker.reconcile('wex_123')).resolves.toMatchObject({
      status: 'confirmed', applicationSettledAt: null,
    });
    finishSettlement();
    await expect(first).resolves.toMatchObject({ status: 'confirmed', applicationSettledAt: now().toISOString() });
    expect(settle).toHaveBeenCalledOnce();
    store.close();
  });

  it('leaves a provider-pending submission unsettled', async () => {
    const store = repository();
    const settle = vi.fn();
    const reconciler = new WalletExecutionReconciler({ repository: store, provider: provider({ status: 'pending', transactionHash: null }), chain: chain(), confirmations: 12, settle, now });
    await expect(reconciler.reconcile('wex_123')).resolves.toMatchObject({ status: 'submitted' });
    expect(settle).not.toHaveBeenCalled();
    store.close();
  });

  it.each([
    ['wrong provider transaction', { providerTransactionId: 'privy_tx_attacker' }],
    ['wrong wallet', { providerWalletId: 'embedded_attacker' }],
    ['wrong reference', { referenceId: `mw_${'9'.repeat(61)}` }],
    ['wrong chain', { caip2: 'eip155:8453' }],
  ])('routes %s evidence to review without settlement', async (_label, overrides) => {
    const store = repository();
    const settle = vi.fn();
    const reconciler = new WalletExecutionReconciler({ repository: store, provider: provider(overrides), chain: chain(), confirmations: 12, settle, now });
    await expect(reconciler.reconcile('wex_123')).resolves.toMatchObject({ status: 'review_required' });
    expect(settle).not.toHaveBeenCalled();
    store.close();
  });

  it('maps replacement and failed provider outcomes without fabricating settlement', async () => {
    const replacedStore = repository();
    const replaced = new WalletExecutionReconciler({ repository: replacedStore, provider: provider({ status: 'replaced' }), chain: chain(), confirmations: 12, settle: vi.fn(), now });
    await expect(replaced.reconcile('wex_123')).resolves.toMatchObject({ status: 'review_required', failureCode: 'provider-transaction-replaced' });
    replacedStore.close();

    const failedStore = repository();
    const failed = new WalletExecutionReconciler({ repository: failedStore, provider: provider({ status: 'execution_reverted', transactionHash: null }), chain: chain(), confirmations: 12, settle: vi.fn(), now });
    await expect(failed.reconcile('wex_123')).resolves.toMatchObject({ status: 'failed', failureCode: 'provider-execution-reverted' });
    failedStore.close();
  });

  it('routes mismatched or unavailable chain evidence to review', async () => {
    const store = repository();
    const base: BaseSepoliaExecutionReader = { verifyTransfer: vi.fn(async () => { throw new ChainEvidenceMismatchError('wrong amount'); }) };
    const settle = vi.fn();
    const reconciler = new WalletExecutionReconciler({ repository: store, provider: provider(), chain: base, confirmations: 12, settle, now });
    await expect(reconciler.reconcile('wex_123')).resolves.toMatchObject({ status: 'review_required', failureCode: 'chain-evidence-mismatch' });
    expect(settle).not.toHaveBeenCalled();
    store.close();
  });

  it('keeps valid provider evidence pending while confirmation depth grows', async () => {
    const store = repository();
    const base: BaseSepoliaExecutionReader = {
      verifyTransfer: vi.fn(async () => { throw new ChainConfirmationPendingError(); }),
    };
    const settle = vi.fn();
    const reconciler = new WalletExecutionReconciler({ repository: store, provider: provider(), chain: base, confirmations: 12, settle, now });
    await expect(reconciler.reconcile('wex_123')).resolves.toMatchObject({ status: 'provider_confirmed' });
    expect(settle).not.toHaveBeenCalled();
    store.close();
  });

  it('accepts a signed confirmed event before polling and deduplicates it', async () => {
    const store = repository();
    const settle = vi.fn();
    const status = provider({ status: 'pending' });
    const reconciler = new WalletExecutionReconciler({ repository: store, provider: status, chain: chain(), confirmations: 12, settle, now });
    const evidence = { providerTransactionId: 'privy_tx_123', providerWalletId: 'embedded_123', referenceId, caip2: 'eip155:84532', transactionHash };
    expect(reconciler.recordProviderConfirmed(evidence)).toMatchObject({ status: 'provider_confirmed' });
    expect(reconciler.recordProviderConfirmed(evidence)).toMatchObject({ status: 'provider_confirmed' });
    await expect(reconciler.reconcile('wex_123')).resolves.toMatchObject({ status: 'confirmed' });
    expect(status.getTransaction).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
    store.close();
  });

  it('recovers an ambiguous submission only from signed evidence with the committed reference and wallet', async () => {
    const store = ambiguousRepository();
    const settle = vi.fn();
    const status = provider({ status: 'pending' });
    const reconciler = new WalletExecutionReconciler({ repository: store, provider: status, chain: chain(), confirmations: 12, settle, now });
    const evidence = { providerTransactionId: 'privy_tx_recovered', providerWalletId: 'embedded_123', referenceId, caip2: 'eip155:84532', transactionHash };
    expect(reconciler.recordProviderConfirmed(evidence)).toMatchObject({
      status: 'provider_confirmed', providerTransactionId: 'privy_tx_recovered', transactionHash,
    });
    await expect(reconciler.reconcile('wex_ambiguous')).resolves.toMatchObject({ status: 'confirmed' });
    expect(status.getTransaction).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({ requestId: 'request_ambiguous', transactionHash, submissionId: referenceId });
    store.close();
  });

  it('replays a persisted ambiguous submission through the provider idempotency reference', async () => {
    const store = ambiguousRepository();
    const submissionProvider = { submit: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null,
    })) };
    const reconciler = new WalletExecutionReconciler({
      repository: store, provider: provider(), submissionProvider,
      signer: { sign: vi.fn(async () => 'signed') }, chain: chain(), confirmations: 12,
      settle: vi.fn(), now,
    });

    await expect(reconciler.reconcile('wex_ambiguous')).resolves.toMatchObject({ status: 'confirmed' });
    expect(submissionProvider.submit).toHaveBeenCalledWith(expect.objectContaining({
      referenceId, embeddedWalletId: 'embedded_123', smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }));
    store.close();
  });

  it('stops replaying an ambiguous submission and routes it to review once attempts are exhausted', async () => {
    const store = ambiguousRepository();
    // Each replay is a duplicate-payment risk, so the reconciler must give up rather than loop.
    const submissionProvider = { submit: vi.fn(async () => { throw new Error('provider outcome unknown'); }) };
    const reconciler = new WalletExecutionReconciler({
      repository: store, provider: provider(), submissionProvider,
      signer: { sign: vi.fn(async () => 'signed') }, chain: chain(), confirmations: 12,
      settle: vi.fn(), now,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reconciler.reconcile('wex_ambiguous');
    }
    expect(submissionProvider.submit).toHaveBeenCalledTimes(3);

    const exhausted = await reconciler.reconcile('wex_ambiguous');
    expect(exhausted).toMatchObject({ status: 'review_required' });
    expect(exhausted.failureCode).toBe('blind-submit-attempts-exhausted:3');
    // The bound holds: no fourth submission, and further passes do not resurrect it.
    expect(submissionProvider.submit).toHaveBeenCalledTimes(3);
    await reconciler.reconcile('wex_ambiguous');
    expect(submissionProvider.submit).toHaveBeenCalledTimes(3);
    store.close();
  });

  it('records contradictory signed evidence even after chain confirmation', async () => {
    const store = repository();
    const reconciler = new WalletExecutionReconciler({
      repository: store, provider: provider(), chain: chain(), confirmations: 12, settle: vi.fn(), now,
    });
    await reconciler.reconcile('wex_123');
    const before = store.listEvents('wex_123').length;
    expect(reconciler.recordProviderConfirmed({
      providerTransactionId: 'privy_tx_123', providerWalletId: 'embedded_123', referenceId,
      caip2: 'eip155:84532', transactionHash: `0x${'1'.repeat(64)}`,
    })).toMatchObject({
      status: 'confirmed', reviewRequiredAt: now().toISOString(),
      reviewReason: 'provider-transaction-hash-conflict',
    });
    expect(store.listEvents('wex_123').slice(before)).toEqual([
      expect.objectContaining({ kind: 'confirmed_evidence_conflict', detail: 'provider-transaction-hash-conflict' }),
    ]);
    expect(store.listReviewCandidates()).toEqual([
      expect.objectContaining({ submissionId: 'wex_123', status: 'confirmed' }),
    ]);
    store.close();
  });
});

describe('wallet execution reconciliation worker', () => {
  it('never overlaps runs and waits for the active run while stopping', async () => {
    let complete!: () => void;
    const runBatch = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const worker = new WalletExecutionReconciliationWorker({ runBatch });
    const first = worker.runOnce();
    await expect(worker.runOnce()).resolves.toBeUndefined();
    const stopping = worker.stop();
    expect(runBatch).toHaveBeenCalledOnce();
    complete();
    await first;
    await stopping;
  });
});
