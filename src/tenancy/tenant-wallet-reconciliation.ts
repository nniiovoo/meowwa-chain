import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAuthToken } from '../auth.js';
import { discardResponseBody } from '../http-response.js';
import {
  ChainConfirmationPendingError,
  ChainEvidenceMismatchError,
  type BaseSepoliaExecutionReader,
} from '../wallet-execution/chain.js';
import type {
  WalletExecutionProvider,
  WalletExecutionProviderTransaction,
  WalletExecutionStatusProvider,
} from '../wallet-execution/provider.js';
import {
  TenantWalletExecutionConflictError,
  type TenantWalletExecutionSubmission,
} from './tenant-wallet-execution.js';
import { EVM_HASH_PATTERN } from '@meowwa/chain-domain';

const eventSchema = z.object({
  type: z.enum([
    'transaction.broadcasted', 'transaction.confirmed', 'transaction.execution_reverted',
    'transaction.failed', 'transaction.provider_error', 'transaction.replaced', 'transaction.still_pending',
  ]),
  wallet_id: z.string().min(3).max(255),
  transaction_id: z.string().min(3).max(255),
  caip2: z.string().min(3).max(64),
  reference_id: z.string().regex(/^mw_[0-9a-f]{61}$/).nullable().optional(),
  transaction_hash: z.string().nullable().optional(),
}).passthrough();

export interface TenantWalletReconciliationRepository {
  resolveExecutionTenant(input: { referenceId: string | null; providerTransactionId: string }): Promise<string | undefined>;
  getExecutionById(tenantId: string, submissionId: string): Promise<TenantWalletExecutionSubmission | undefined>;
  findExecutionByProviderIdentity(input: {
    tenantId: string; referenceId: string | null; providerTransactionId: string;
  }): Promise<TenantWalletExecutionSubmission | undefined>;
  claimExecutionReconciliation(input: {
    workerId: string; leaseSeconds: number;
  }): Promise<TenantWalletExecutionReconciliationClaim | undefined>;
  renewExecutionReconciliationClaim(
    claim: TenantWalletExecutionReconciliationClaim, leaseSeconds: number,
  ): Promise<boolean>;
  releaseExecutionReconciliationClaim(claim: TenantWalletExecutionReconciliationClaim): Promise<boolean>;
  recordExecutionWebhook(input: {
    tenantId: string; deliveryId: string; eventType: string; payloadSha256: string;
  }): Promise<'inserted' | 'duplicate'>;
  executionWebhookProcessed(tenantId: string, deliveryId: string): Promise<boolean>;
  markExecutionWebhookProcessed(tenantId: string, deliveryId: string): Promise<void>;
  markExecutionProviderConfirmed(input: {
    tenantId: string; submissionId: string; expectedVersion: number;
    providerTransactionId: string; transactionHash: `0x${string}`;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }): Promise<TenantWalletExecutionSubmission>;
  markExecutionSubmitted(input: {
    tenantId: string; submissionId: string; expectedVersion: number;
    providerTransactionId: string; userOperationHash: `0x${string}` | null;
    transactionHash: `0x${string}` | null;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }): Promise<TenantWalletExecutionSubmission>;
  markExecutionFailed(
    tenantId: string, submissionId: string, expectedVersion: number, reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission>;
  markExecutionUnknown(
    tenantId: string, submissionId: string, expectedVersion: number, reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission>;
  markExecutionReviewRequired(
    tenantId: string, submissionId: string, expectedVersion: number, reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission>;
  recordBlindSubmitAttempt(tenantId: string, submissionId: string): Promise<number>;
  recordExecutionEvidenceConflict(
    tenantId: string, submissionId: string, expectedVersion: number, reason: string,
  ): Promise<TenantWalletExecutionSubmission>;
  confirmExecutionChain(input: {
    tenantId: string; submissionId: string; expectedVersion: number;
    transactionHash: `0x${string}`; blockHash: `0x${string}`; blockNumber: number; logIndex: number; confirmedAt: string;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }): Promise<TenantWalletExecutionSubmission>;
  markExecutionApplicationSettled(
    tenantId: string, submissionId: string, expectedVersion: number, settledAt: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission>;
}

export interface TenantWalletExecutionReconciliationClaim {
  tenantId: string;
  submissionId: string;
  workerId: string;
  lockedUntil: string;
  fenceToken: number;
}

export interface TenantWalletWebhookVerifier {
  verify(rawBody: string, headers: {
    'svix-id': string;
    'svix-timestamp': string;
    'svix-signature': string;
  }): unknown;
}

export class TenantWalletWebhookVerificationError extends Error {
  constructor() { super('Privy webhook signature verification failed'); this.name = 'TenantWalletWebhookVerificationError'; }
}

export class TenantWalletWebhookEventError extends Error {
  constructor() { super('Privy webhook event is invalid'); this.name = 'TenantWalletWebhookEventError'; }
}

function providerIdentityMatches(
  submission: TenantWalletExecutionSubmission,
  evidence: { providerTransactionId: string; providerWalletId: string; referenceId: string | null; caip2: string },
): boolean {
  const transactionMatches = submission.providerTransactionId === evidence.providerTransactionId ||
    (submission.providerTransactionId === null && ['submitting', 'unknown'].includes(submission.status));
  return transactionMatches && submission.providerWalletId === evidence.providerWalletId &&
    submission.referenceId === evidence.referenceId && evidence.caip2 === 'eip155:84532';
}

function reviewable(submission: TenantWalletExecutionSubmission): boolean {
  return ['submitting', 'submitted', 'provider_confirmed', 'unknown'].includes(submission.status);
}

/** Matches the singleton reconciler: enough to ride out a transient outage, few enough to bound risk. */
const MAX_BLIND_SUBMIT_ATTEMPTS = 3;

export class TenantWalletExecutionReconciler {
  readonly #now: () => Date;
  readonly #workerId: string;
  readonly #leaseSeconds: number;

  constructor(private readonly options: {
    repository: TenantWalletReconciliationRepository;
    provider: WalletExecutionStatusProvider;
    submissionProvider?: WalletExecutionProvider;
    signer?: { sign(payload: Uint8Array): Promise<string> };
    chain: BaseSepoliaExecutionReader;
    confirmations: number;
    settle(submission: TenantWalletExecutionSubmission): Promise<void>;
    now?: () => Date;
    workerId?: string;
    leaseSeconds?: number;
  }) {
    if (!Number.isSafeInteger(options.confirmations) || options.confirmations < 1 || options.confirmations > 100) {
      throw new Error('Tenant wallet execution confirmation depth is invalid');
    }
    if ((options.submissionProvider === undefined) !== (options.signer === undefined)) {
      throw new Error('Tenant wallet execution recovery provider and signer must be configured together');
    }
    this.#workerId = options.workerId ?? `wallet-reconcile-${randomUUID()}`;
    this.#leaseSeconds = options.leaseSeconds ?? 60;
    if (this.#workerId.length < 8 || this.#workerId.length > 128 || this.#workerId.trim() !== this.#workerId ||
      !Number.isSafeInteger(this.#leaseSeconds) || this.#leaseSeconds < 5 || this.#leaseSeconds > 300) {
      throw new Error('Tenant wallet execution reconciliation lease is invalid');
    }
    this.#now = options.now ?? (() => new Date());
  }

  async runBatch(limit = 25): Promise<{ attempted: number; confirmed: number; reviewRequired: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Tenant wallet execution reconciliation limit is invalid');
    }
    let attempted = 0;
    let confirmed = 0;
    let reviewRequired = 0;
    let firstFailure: unknown;
    const seen = new Set<string>();
    while (attempted < limit) {
      const claim = await this.options.repository.claimExecutionReconciliation({
        workerId: this.#workerId,
        leaseSeconds: this.#leaseSeconds,
      });
      if (!claim) break;
      const claimKey = `${claim.tenantId}:${claim.submissionId}`;
      if (seen.has(claimKey)) {
        try {
          if (!await this.options.repository.releaseExecutionReconciliationClaim(claim)) {
            firstFailure ??= new Error('Tenant wallet execution reconciliation duplicate claim was lost');
          }
        } catch (error) {
          firstFailure ??= error;
        }
        break;
      }
      seen.add(claimKey);
      attempted += 1;
      let renewalFailure: unknown;
      let renewalInFlight: Promise<void> | undefined;
      const renew = () => {
        if (renewalInFlight) return;
        renewalInFlight = this.options.repository.renewExecutionReconciliationClaim(claim, this.#leaseSeconds)
          .then((renewed) => {
            if (!renewed) throw new Error('Tenant wallet execution reconciliation claim renewal was lost');
          })
          .catch((error: unknown) => { renewalFailure ??= error; })
          .finally(() => { renewalInFlight = undefined; });
      };
      const renewalTimer = setInterval(renew, Math.max(1_000, Math.floor(this.#leaseSeconds * 1_000 / 3)));
      renewalTimer.unref?.();
      try {
        if (claim.workerId !== this.#workerId) {
          throw new Error('Tenant wallet execution reconciliation claim owner is invalid');
        }
        const result = await this.reconcile(claim.tenantId, claim.submissionId, claim);
        if (renewalFailure) throw renewalFailure;
        if (result.status === 'confirmed' && result.applicationSettledAt !== null) confirmed += 1;
        if (result.status === 'review_required') reviewRequired += 1;
      } catch (error) {
        firstFailure ??= error;
      } finally {
        clearInterval(renewalTimer);
        if (renewalInFlight) await renewalInFlight;
        firstFailure ??= renewalFailure;
        try {
          if (!await this.options.repository.releaseExecutionReconciliationClaim(claim)) {
            firstFailure ??= new Error('Tenant wallet execution reconciliation claim was lost');
          }
        } catch (error) {
          firstFailure ??= error;
        }
      }
    }
    if (firstFailure) throw firstFailure;
    return { attempted, confirmed, reviewRequired };
  }

  async recordProviderConfirmed(input: {
    tenantId: string;
    submission: TenantWalletExecutionSubmission;
    providerTransactionId: string;
    providerWalletId: string;
    referenceId: string;
    caip2: string;
    transactionHash: `0x${string}`;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }): Promise<TenantWalletExecutionSubmission> {
    return this.#recordProviderConfirmed(input, true);
  }

  async #recordProviderConfirmed(input: {
    tenantId: string;
    submission: TenantWalletExecutionSubmission;
    providerTransactionId: string;
    providerWalletId: string;
    referenceId: string;
    caip2: string;
    transactionHash: `0x${string}`;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }, allowReload: boolean): Promise<TenantWalletExecutionSubmission> {
    if (!providerIdentityMatches(input.submission, input)) {
      return this.#review(input.submission, 'provider-evidence-mismatch', input.claim);
    }
    if (input.submission.status === 'failed') {
      return this.#recordTerminalEvidenceConflict(input.submission, 'provider-confirmation-after-failure');
    }
    if (input.submission.status === 'provider_confirmed' || input.submission.status === 'confirmed') {
      return input.submission.transactionHash?.toLowerCase() === input.transactionHash.toLowerCase()
        ? input.submission
        : this.#review(input.submission, 'provider-transaction-hash-conflict', input.claim);
    }
    // Same no-op the singleton reconciler applies for the same reason (wallet-execution/
    // reconciler.ts): markExecutionProviderConfirmed accepts only submitting/submitted/unknown, so
    // a submission already quarantined -- a reorged receipt, a replaced provider transaction, blind
    // submits exhausted -- threw TenantWalletExecutionConflictError out of the signed webhook. That
    // is neither a verification nor an event error, so the route answered 503 'temporarily
    // unavailable', markExecutionWebhookProcessed was never reached, and svix redelivered the same
    // delivery on its full retry schedule forever against a permanent local state. 'failed' is
    // absent here on purpose: it routes to #recordTerminalEvidenceConflict above.
    if (input.submission.status === 'review_required' || input.submission.status === 'prepared') {
      return input.submission;
    }
    try {
      return await this.options.repository.markExecutionProviderConfirmed({
        tenantId: input.tenantId, submissionId: input.submission.submissionId,
        expectedVersion: input.submission.version, providerTransactionId: input.providerTransactionId,
        transactionHash: input.transactionHash, claim: input.claim,
      });
    } catch (error) {
      if (input.claim || !allowReload || !(error instanceof TenantWalletExecutionConflictError)) throw error;
      const current = await this.options.repository.getExecutionById(input.tenantId, input.submission.submissionId);
      if (!current) throw error;
      return this.#recordProviderConfirmed({ ...input, submission: current }, false);
    }
  }

  async reconcile(
    tenantId: string,
    submissionId: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission> {
    let submission = await this.options.repository.getExecutionById(tenantId, submissionId);
    if (!submission) throw new Error('Tenant wallet execution submission was not found');
    if (submission.status === 'confirmed') return this.#settle(submission, claim);
    if (['failed', 'review_required', 'prepared'].includes(submission.status)) return submission;

    if ((submission.status === 'submitting' || submission.status === 'unknown') && !submission.providerTransactionId) {
      if (!this.options.submissionProvider || !this.options.signer) return submission;
      // Every pass here is a blind replay: outcome unknown, no provider transaction id to poll, so
      // the reference id's idempotency window is the only thing preventing a duplicate payment.
      if (submission.blindSubmitAttempts >= MAX_BLIND_SUBMIT_ATTEMPTS) {
        return this.options.repository.markExecutionReviewRequired(
          tenantId, submission.submissionId, submission.version,
          `blind-submit-attempts-exhausted:${submission.blindSubmitAttempts}`, claim,
        );
      }
      await this.options.repository.recordBlindSubmitAttempt(tenantId, submission.submissionId);
      try {
        const result = await this.options.submissionProvider.submit({
          embeddedWalletId: submission.providerWalletId,
          smartWalletAddress: submission.sender,
          caip2: 'eip155:84532',
          contract: submission.contract,
          calldata: submission.calldata,
          referenceId: submission.referenceId,
          sign: this.options.signer.sign,
        });
        submission = await this.options.repository.markExecutionSubmitted({
          tenantId,
          submissionId: submission.submissionId,
          expectedVersion: submission.version,
          providerTransactionId: result.providerTransactionId,
          userOperationHash: result.userOperationHash,
          transactionHash: result.transactionHash,
          claim,
        });
      } catch {
        return submission.status === 'submitting'
          ? this.options.repository.markExecutionUnknown(
            tenantId, submission.submissionId, submission.version, 'provider-outcome-unknown',
            claim,
          )
          : submission;
      }
    }

    if (submission.status === 'submitted' || submission.status === 'unknown') {
      if (!submission.providerTransactionId) return submission;
      let provider: WalletExecutionProviderTransaction;
      try {
        provider = await this.options.provider.getTransaction({
          providerTransactionId: submission.providerTransactionId,
          providerWalletId: submission.providerWalletId,
          referenceId: submission.referenceId,
          recipient: submission.recipient,
          amountAtomic: submission.amountAtomic,
        });
      } catch {
        return submission.status === 'submitted'
          ? this.options.repository.markExecutionUnknown(
            tenantId, submission.submissionId, submission.version, 'provider-status-unavailable', claim,
          )
          : submission;
      }
      if (!providerIdentityMatches(submission, provider)) return this.#review(submission, 'provider-evidence-mismatch', claim);
      if (provider.status === 'pending' || provider.status === 'broadcasted') return submission;
      if (provider.status === 'replaced') return this.#review(submission, 'provider-transaction-replaced', claim);
      if (provider.status === 'failed' || provider.status === 'provider_error' || provider.status === 'execution_reverted') {
        return this.options.repository.markExecutionFailed(
          tenantId, submission.submissionId, submission.version, `provider-${provider.status.replaceAll('_', '-')}`,
          claim,
        );
      }
      if (!provider.transactionHash || !provider.referenceId) {
        return this.#review(submission, 'provider-confirmation-incomplete', claim);
      }
      submission = await this.recordProviderConfirmed({
        tenantId, submission, providerTransactionId: provider.providerTransactionId,
        providerWalletId: provider.providerWalletId, referenceId: provider.referenceId,
        caip2: provider.caip2, transactionHash: provider.transactionHash, claim,
      });
    }
    if (submission.status !== 'provider_confirmed' || !submission.transactionHash) return submission;
    let evidence;
    try {
      evidence = await this.options.chain.verifyTransfer({
        transactionHash: submission.transactionHash, sender: submission.sender,
        recipient: submission.recipient, amountAtomic: submission.amountAtomic,
        confirmations: this.options.confirmations,
      });
    } catch (error) {
      if (error instanceof ChainConfirmationPendingError) return submission;
      if (error instanceof ChainEvidenceMismatchError) return this.#review(submission, 'chain-evidence-mismatch', claim);
      throw error;
    }
    submission = await this.options.repository.confirmExecutionChain({
      tenantId, submissionId: submission.submissionId, expectedVersion: submission.version,
      transactionHash: evidence.transactionHash, blockHash: evidence.blockHash,
      blockNumber: evidence.blockNumber, logIndex: evidence.logIndex, confirmedAt: this.#now().toISOString(),
      claim,
    });
    return this.#settle(submission, claim);
  }

  async #settle(
    submission: TenantWalletExecutionSubmission,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission> {
    if (submission.status !== 'confirmed' || submission.applicationSettledAt !== null) return submission;
    await this.options.settle(submission);
    return this.options.repository.markExecutionApplicationSettled(
      submission.tenantId, submission.submissionId, submission.version, this.#now().toISOString(),
      claim,
    );
  }

  async #review(
    submission: TenantWalletExecutionSubmission,
    reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
    allowReload = true,
  ): Promise<TenantWalletExecutionSubmission> {
    if (submission.status === 'review_required' || submission.status === 'prepared') return submission;
    if (submission.status === 'confirmed' || submission.status === 'failed') {
      return this.#recordTerminalEvidenceConflict(submission, reason);
    }
    try {
      return await this.options.repository.markExecutionReviewRequired(
        submission.tenantId, submission.submissionId, submission.version, reason,
        claim,
      );
    } catch (error) {
      if (claim || !allowReload || !(error instanceof TenantWalletExecutionConflictError)) throw error;
      const current = await this.options.repository.getExecutionById(submission.tenantId, submission.submissionId);
      if (!current) throw error;
      return this.#review(current, reason, undefined, false);
    }
  }

  async #recordTerminalEvidenceConflict(
    submission: TenantWalletExecutionSubmission,
    reason: string,
    allowReload = true,
  ): Promise<TenantWalletExecutionSubmission> {
    if (submission.failureCode === reason) return submission;
    try {
      return await this.options.repository.recordExecutionEvidenceConflict(
        submission.tenantId, submission.submissionId, submission.version, reason,
      );
    } catch (error) {
      if (!allowReload || !(error instanceof TenantWalletExecutionConflictError)) throw error;
      const current = await this.options.repository.getExecutionById(submission.tenantId, submission.submissionId);
      if (!current) throw error;
      if (current.status !== 'confirmed' && current.status !== 'failed') throw error;
      return this.#recordTerminalEvidenceConflict(current, reason, false);
    }
  }
}

export class TenantPrivyWebhookProcessor {
  constructor(private readonly options: {
    verifier: TenantWalletWebhookVerifier;
    repository: TenantWalletReconciliationRepository;
    reconciler: TenantWalletExecutionReconciler;
  }) {}

  async process(rawBody: Buffer, headers: {
    'svix-id': string; 'svix-timestamp': string; 'svix-signature': string;
  }): Promise<{ received: true; duplicate: boolean; handled: boolean }> {
    const raw = rawBody.toString('utf8');
    let verified: unknown;
    try { verified = this.options.verifier.verify(raw, headers); } catch { throw new TenantWalletWebhookVerificationError(); }
    const parsed = eventSchema.safeParse(verified);
    if (!parsed.success) throw new TenantWalletWebhookEventError();
    const event = parsed.data;
    const referenceId = event.reference_id ?? null;
    const tenantId = await this.options.repository.resolveExecutionTenant({
      referenceId, providerTransactionId: event.transaction_id,
    });
    if (!tenantId) return { received: true, duplicate: false, handled: false };
    const delivery = await this.options.repository.recordExecutionWebhook({
      tenantId, deliveryId: headers['svix-id'], eventType: event.type,
      payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
    });
    if (delivery === 'duplicate' && await this.options.repository.executionWebhookProcessed(tenantId, headers['svix-id'])) {
      return { received: true, duplicate: true, handled: true };
    }
    const submission = await this.options.repository.findExecutionByProviderIdentity({
      tenantId, referenceId, providerTransactionId: event.transaction_id,
    });
    if (!submission) throw new Error('Tenant wallet webhook resolved without a submission');
    if (event.type === 'transaction.confirmed') {
      if (referenceId === null || typeof event.transaction_hash !== 'string' ||
        !EVM_HASH_PATTERN.test(event.transaction_hash)) {
        if (reviewable(submission)) {
          await this.options.repository.markExecutionReviewRequired(
            tenantId, submission.submissionId, submission.version, 'signed-webhook-confirmation-incomplete',
          );
        }
      } else {
        const confirmed = await this.options.reconciler.recordProviderConfirmed({
          tenantId, submission, providerTransactionId: event.transaction_id, providerWalletId: event.wallet_id,
          referenceId, caip2: event.caip2, transactionHash: event.transaction_hash.toLowerCase() as `0x${string}`,
        });
        await this.options.reconciler.reconcile(tenantId, confirmed.submissionId);
      }
    } else if (!providerIdentityMatches(submission, {
      providerTransactionId: event.transaction_id, providerWalletId: event.wallet_id,
      referenceId, caip2: event.caip2,
    })) {
      if (reviewable(submission)) {
        await this.options.repository.markExecutionReviewRequired(
          tenantId, submission.submissionId, submission.version, 'signed-webhook-identity-mismatch',
        );
      }
    } else {
      await this.options.reconciler.reconcile(tenantId, submission.submissionId);
    }
    await this.options.repository.markExecutionWebhookProcessed(tenantId, headers['svix-id']);
    return { received: true, duplicate: delivery === 'duplicate', handled: true };
  }
}

function exactOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Internal API URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) throw new Error('Internal API URL must be an exact origin');
  return url.origin;
}

export class TenantWalletSettlementClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: {
    baseUrl: string;
    authSecret: string;
    requestTimeoutMs: number;
    fetch?: typeof fetch;
  }) {
    this.#baseUrl = exactOrigin(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!options.authSecret || options.authSecret.length < 32) throw new Error('Wallet settlement auth secret is invalid');
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 500 || options.requestTimeoutMs > 30_000) {
      throw new Error('Wallet settlement request timeout is invalid');
    }
  }

  async settle(submission: TenantWalletExecutionSubmission): Promise<void> {
    if (submission.status !== 'confirmed' || !submission.transactionHash) throw new Error('Wallet settlement is not confirmed');
    const token = createAuthToken({
      type: 'service', subject: 'wallet_execution_worker', tenantId: submission.tenantId,
      ownerId: submission.ownerSubject, scopes: ['wallet-execution-reconcile'], expiresInSeconds: 60,
    }, this.options.authSecret);
    const response = await this.#fetch(`${this.#baseUrl}/v1/system/wallet-executions/settle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        requestId: submission.requestId, transactionHash: submission.transactionHash,
        submissionId: submission.referenceId,
      }),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    await discardResponseBody(response);
    if (!response.ok) throw new Error(`Wallet settlement API returned ${response.status}`);
  }
}
