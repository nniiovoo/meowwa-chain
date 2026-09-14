import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import { SubmissionConflictError, WalletExecutionRepository } from './repository.js';
import type { PrepareWalletExecutionInput } from './types.js';

const directories: string[] = [];
const now = new Date('2026-07-14T23:00:00.000Z');

function prepared(overrides: Partial<PrepareWalletExecutionInput> = {}): PrepareWalletExecutionInput {
  return {
    submissionId: 'wex_123', requestId: 'request_123', ownerId: 'owner_1', petId: 'pet_mochi',
    bindingId: 'wcb_123', providerWalletId: 'embedded_123', intentHash: 'a'.repeat(64), referenceId: `mw_${'b'.repeat(61)}`,
    chainId: 84532 as const, contract: BASE_SEPOLIA_USDC.toLowerCase(),
    sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    recipient: '0x1111111111111111111111111111111111111111', amountAtomic: '12990000',
    valueAtomic: '0' as const, calldata: `0x${'c'.repeat(136)}` as `0x${string}`,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('wallet execution repository', () => {
  it('persists the immutable submission identity and optimistic lifecycle', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    expect(repository.appliedMigrationVersions()).toEqual([1, 2, 3, 4, 5, 6]);

    const initial = repository.prepare(prepared());
    expect(initial).toMatchObject({ status: 'prepared', version: 1, providerTransactionId: null, transactionHash: null });
    const submitting = repository.markSubmitting(initial.submissionId, initial.version);
    expect(submitting).toMatchObject({ status: 'submitting', version: 2 });
    const submitted = repository.markSubmitted(submitting.submissionId, submitting.version, {
      providerTransactionId: 'privy_tx_123', userOperationHash: `0x${'d'.repeat(64)}`, transactionHash: null,
    });
    expect(submitted).toMatchObject({ status: 'submitted', providerTransactionId: 'privy_tx_123', version: 3 });
    const providerConfirmed = repository.markProviderConfirmed(submitted.submissionId, submitted.version, {
      providerTransactionId: 'privy_tx_123', transactionHash: `0x${'e'.repeat(64)}`,
    });
    expect(providerConfirmed).toMatchObject({ status: 'provider_confirmed', transactionHash: `0x${'e'.repeat(64)}`, version: 4 });
    const confirmed = repository.confirmChain(providerConfirmed.submissionId, providerConfirmed.version, {
      transactionHash: `0x${'e'.repeat(64)}`, blockHash: `0x${'f'.repeat(64)}`,
      blockNumber: 1234, logIndex: 7, confirmedAt: '2026-07-14T23:02:00.000Z',
    });
    expect(confirmed).toMatchObject({
      status: 'confirmed', blockNumber: 1234, logIndex: 7, confirmedAt: '2026-07-14T23:02:00.000Z', version: 5,
    });
    expect(repository.getByRequestId('request_123')).toEqual(confirmed);
    expect(repository.getByReferenceId(`mw_${'b'.repeat(61)}`)).toEqual(confirmed);
    expect(repository.listEvents('wex_123').map((event) => event.toStatus)).toEqual([
      'prepared', 'submitting', 'submitted', 'provider_confirmed', 'confirmed',
    ]);
    repository.close();
  });

  it('rotates unchanged reconciliation candidates so work beyond the first page is not starved', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    for (let index = 0; index < 26; index += 1) {
      const suffix = index.toString(16).padStart(2, '0');
      const initial = repository.prepare(prepared({
        submissionId: `wex_${suffix}`, requestId: `request_${suffix}`,
        intentHash: suffix.repeat(32), referenceId: `mw_${index.toString(16).padStart(61, '0')}`,
      }));
      const submitting = repository.markSubmitting(initial.submissionId, initial.version);
      repository.markSubmitted(submitting.submissionId, submitting.version, {
        providerTransactionId: `privy_tx_${suffix}`, userOperationHash: null, transactionHash: null,
      });
    }
    const first = repository.listReconcileCandidates(25);
    expect(first).toHaveLength(25);
    for (const submission of first) repository.markReconcileAttempt(submission.submissionId);
    expect(repository.listReconcileCandidates(25).map((item) => item.submissionId)).toContain('wex_19');
    repository.close();
  });

  it('persists receive scan cursors monotonically with a reorg checkpoint', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    const contract = BASE_SEPOLIA_USDC.toLowerCase() as `0x${string}`;
    expect(repository.getReceiveScanCursor(84532, contract, 100n)).toEqual({ nextBlock: 100n, checkpoint: null });
    expect(repository.advanceReceiveScanCursor({
      chainId: 84532, contractAddress: contract, expectedNextBlock: 100n, nextBlock: 101n,
      checkpointBlock: 100n, checkpointHash: `0x${'a'.repeat(64)}`,
    })).toBe(true);
    expect(repository.getReceiveScanCursor(84532, contract, 1n)).toEqual({ nextBlock: 101n, checkpoint: { blockNumber: 100n, blockHash: `0x${'a'.repeat(64)}` } });
    expect(repository.advanceReceiveScanCursor({
      chainId: 84532, contractAddress: contract, expectedNextBlock: 100n, nextBlock: 102n,
      checkpointBlock: 101n, checkpointHash: `0x${'b'.repeat(64)}`,
    })).toBe(false);
    expect(repository.rewindReceiveScanCursor({
      chainId: 84532, contractAddress: contract, expectedNextBlock: 101n, nextBlock: 100n,
    })).toBe(true);
    expect(repository.getReceiveScanCursor(84532, contract, 1n)).toEqual({ nextBlock: 100n, checkpoint: null });
    repository.close();
  });

  it('is idempotent for the exact request and refuses every immutable identity conflict', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    const first = repository.prepare(prepared());
    expect(repository.prepare(prepared())).toEqual(first);
    expect(() => repository.prepare(prepared({ intentHash: '9'.repeat(64) }))).toThrow(SubmissionConflictError);
    expect(() => repository.prepare(prepared({ submissionId: 'wex_456', requestId: 'request_456' }))).toThrow(SubmissionConflictError);
    expect(() => repository.markSubmitting(first.submissionId, 99)).toThrow('stale');
    repository.close();
  });

  it('does not permit a second provider transaction or chain identity', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    const first = repository.markSubmitting('wex_123', repository.prepare(prepared()).version);
    const submitted = repository.markSubmitted(first.submissionId, first.version, {
      providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null,
    });
    expect(() => repository.markSubmitted(submitted.submissionId, submitted.version, {
      providerTransactionId: 'privy_tx_attacker', userOperationHash: null, transactionHash: null,
    })).toThrow();

    const second = repository.markSubmitting('wex_456', repository.prepare(prepared({
      submissionId: 'wex_456', requestId: 'request_456', intentHash: '2'.repeat(64), referenceId: `mw_${'3'.repeat(61)}`,
    })).version);
    expect(() => repository.markSubmitted(second.submissionId, second.version, {
      providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null,
    })).toThrow(SubmissionConflictError);
    repository.close();
  });

  it('does not replace provider or chain identities when an unknown submission is recovered', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    const submitting = repository.markSubmitting('wex_123', repository.prepare(prepared()).version);
    const submitted = repository.markSubmitted(submitting.submissionId, submitting.version, {
      providerTransactionId: 'privy_tx_original',
      userOperationHash: `0x${'d'.repeat(64)}`,
      transactionHash: `0x${'e'.repeat(64)}`,
    });
    const unknown = repository.markUnknown(submitted.submissionId, submitted.version, 'provider-status-unavailable');

    expect(() => repository.markSubmitted(unknown.submissionId, unknown.version, {
      providerTransactionId: 'privy_tx_attacker',
      userOperationHash: `0x${'1'.repeat(64)}`,
      transactionHash: `0x${'2'.repeat(64)}`,
    })).toThrow(SubmissionConflictError);
    expect(repository.getById(unknown.submissionId)).toMatchObject({
      providerTransactionId: 'privy_tx_original',
      userOperationHash: `0x${'d'.repeat(64)}`,
      transactionHash: `0x${'e'.repeat(64)}`,
    });
    repository.close();
  });

  it('records ambiguous and manual-review exits without allowing unsafe retries', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    const submitting = repository.markSubmitting('wex_123', repository.prepare(prepared()).version);
    const unknown = repository.markUnknown(submitting.submissionId, submitting.version, 'provider-timeout');
    expect(unknown).toMatchObject({ status: 'unknown', failureCode: 'provider-timeout' });
    expect(() => repository.markSubmitting(unknown.submissionId, unknown.version)).toThrow('unknown');
    const review = repository.markReviewRequired(unknown.submissionId, unknown.version, 'ambiguous-provider-result');
    expect(review).toMatchObject({ status: 'review_required', failureCode: 'ambiguous-provider-result' });
    expect(() => repository.markFailed(review.submissionId, review.version, 'late-failure')).toThrow('review_required');
    repository.close();
  });

  it('reopens only a chain-mismatch review for the corrected verifier', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    const submitting = repository.markSubmitting('wex_123', repository.prepare(prepared()).version);
    const submitted = repository.markSubmitted(submitting.submissionId, submitting.version, {
      providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null,
    });
    const providerConfirmed = repository.markProviderConfirmed(submitted.submissionId, submitted.version, {
      providerTransactionId: 'privy_tx_123', transactionHash: `0x${'e'.repeat(64)}`,
    });
    const review = repository.markReviewRequired(providerConfirmed.submissionId, providerConfirmed.version, 'chain-evidence-mismatch');
    expect(repository.reopenCorrectedChainReview(review.submissionId, review.version)).toMatchObject({
      status: 'provider_confirmed', failureCode: null, transactionHash: `0x${'e'.repeat(64)}`,
    });
    repository.close();
  });

  it('deduplicates signed webhook deliveries and detects identity reuse', () => {
    const repository = new WalletExecutionRepository(':memory:', { now: () => now });
    const delivery = { deliveryId: 'msg_123', eventType: 'transaction.confirmed', payloadSha256: 'a'.repeat(64) };
    expect(repository.recordWebhookDelivery(delivery)).toBe(true);
    expect(repository.recordWebhookDelivery(delivery)).toBe(false);
    expect(() => repository.recordWebhookDelivery({ ...delivery, payloadSha256: 'b'.repeat(64) })).toThrow('conflict');
    expect(repository.markWebhookProcessed('msg_123')).toBe(true);
    expect(repository.markWebhookProcessed('msg_123')).toBe(false);
    repository.close();
  });

  it('reopens durable state with a mode-0600 database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-wallet-execution-')); directories.push(directory);
    const path = join(directory, 'execution.sqlite');
    const first = new WalletExecutionRepository(path, { now: () => now });
    first.prepare(prepared());
    first.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = new WalletExecutionRepository(path, { now: () => now });
    expect(second.getByRequestId('request_123')).toMatchObject({ submissionId: 'wex_123', status: 'prepared' });
    second.close();
  });

  it('converges concurrent repository processes on one durable request identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-wallet-execution-race-')); directories.push(directory);
    const path = join(directory, 'execution.sqlite');
    const first = new WalletExecutionRepository(path, { now: () => now });
    const second = new WalletExecutionRepository(path, { now: () => now });
    expect(first.prepare(prepared())).toEqual(second.prepare(prepared()));
    expect(() => second.prepare(prepared({
      submissionId: 'wex_attacker', intentHash: '8'.repeat(64), referenceId: `mw_${'7'.repeat(61)}`,
    }))).toThrow(SubmissionConflictError);
    first.close();
    second.close();
  });
});
