import { randomUUID } from 'node:crypto';
import { ChainConfirmationPendingError, ChainEvidenceMismatchError, type BaseSepoliaExecutionReader } from './chain.js';
import type {
  WalletExecutionProvider,
  WalletExecutionProviderTransaction,
  WalletExecutionStatusProvider,
} from './provider.js';
import {
  SubmissionConflictError,
  WalletExecutionRepository,
  type WalletExecutionReconciliationClaim,
} from './repository.js';
import type { WalletExecutionSubmission } from './types.js';

export interface ProviderConfirmedEvidence {
  providerTransactionId: string;
  providerWalletId: string;
  referenceId: string;
  caip2: string;
  transactionHash: `0x${string}`;
}

export interface InternalSettlementInput {
  requestId: string;
  transactionHash: `0x${string}`;
  submissionId: string;
}

/**
 * A blind replay can duplicate a payment if the provider has forgotten the reference id. Three
 * attempts is enough to ride out a transient provider outage and few enough to bound the exposure.
 */
const MAX_BLIND_SUBMIT_ATTEMPTS = 3;

export class WalletExecutionReconciliationWorker {
  readonly #runner: { runBatch(): Promise<unknown> };
  #active: Promise<unknown> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(runner: { runBatch(): Promise<unknown> }) {
    this.#runner = runner;
  }

  async runOnce(): Promise<void> {
    if (this.#active) return;
    const active = this.#runner.runBatch();
    this.#active = active;
    try {
      await active;
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  start(pollMs: number, onError: (error: unknown) => void = () => undefined): void {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 3_600_000) {
      throw new Error('Invalid wallet execution reconciliation interval');
    }
    if (this.#timer) return;
    const run = () => { void this.runOnce().catch(onError); };
    run();
    this.#timer = setInterval(run, pollMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    try {
      await this.#active;
    } catch {
      // The scheduled caller already reports the error. Shutdown must still drain it.
    }
  }
}

export class WalletExecutionReconciler {
  readonly #repository: WalletExecutionRepository;
  readonly #provider: WalletExecutionStatusProvider;
  readonly #submissionProvider: WalletExecutionProvider | undefined;
  readonly #signer: { sign(payload: Uint8Array): Promise<string> } | undefined;
  readonly #chain: BaseSepoliaExecutionReader;
  readonly #confirmations: number;
  readonly #settle: (input: InternalSettlementInput) => Promise<void> | void;
  readonly #now: () => Date;

  constructor(options: {
    repository: WalletExecutionRepository;
    provider: WalletExecutionStatusProvider;
    submissionProvider?: WalletExecutionProvider;
    signer?: { sign(payload: Uint8Array): Promise<string> };
    chain: BaseSepoliaExecutionReader;
    confirmations: number;
    settle(input: InternalSettlementInput): Promise<void> | void;
    now?: () => Date;
  }) {
    if (!Number.isSafeInteger(options.confirmations) || options.confirmations < 1 || options.confirmations > 100) {
      throw new Error('Invalid wallet execution confirmation depth');
    }
    this.#repository = options.repository;
    this.#provider = options.provider;
    if ((options.submissionProvider === undefined) !== (options.signer === undefined)) {
      throw new Error('Wallet execution recovery provider and signer must be configured together');
    }
    this.#submissionProvider = options.submissionProvider;
    this.#signer = options.signer;
    this.#chain = options.chain;
    this.#confirmations = options.confirmations;
    this.#settle = options.settle;
    this.#now = options.now ?? (() => new Date());
  }

  recordProviderConfirmed(evidence: ProviderConfirmedEvidence): WalletExecutionSubmission {
    const submission = this.#repository.getByReferenceId(evidence.referenceId) ??
      this.#repository.getByProviderTransactionId(evidence.providerTransactionId);
    if (!submission) throw new Error('Wallet execution submission was not found');
    if (!this.#providerIdentityMatches(submission, evidence)) {
      if (submission.status === 'confirmed') {
        return this.#repository.recordConfirmedEvidenceConflict(submission.submissionId, 'provider-evidence-mismatch');
      }
      return this.#review(submission, 'provider-evidence-mismatch');
    }
    if (submission.status === 'provider_confirmed' || submission.status === 'confirmed') {
      if (submission.transactionHash?.toLowerCase() !== evidence.transactionHash.toLowerCase()) {
        if (submission.status === 'confirmed') {
          return this.#repository.recordConfirmedEvidenceConflict(
            submission.submissionId, 'provider-transaction-hash-conflict',
          );
        }
        return this.#review(submission, 'provider-transaction-hash-conflict');
      }
      return submission;
    }
    // markProviderConfirmed only accepts submitting/submitted/unknown. A submission already in
    // a terminal or pre-submission state would throw out of the signed webhook, which is never
    // acked and is redelivered forever. Mirror the no-op the review and reconcile paths apply.
    if (submission.status === 'review_required' || submission.status === 'failed' || submission.status === 'prepared') {
      return submission;
    }
    try {
      return this.#repository.markProviderConfirmed(submission.submissionId, submission.version, {
        providerTransactionId: evidence.providerTransactionId, transactionHash: evidence.transactionHash,
      });
    } catch (error) {
      if (error instanceof SubmissionConflictError) return this.#review(this.#repository.getById(submission.submissionId)!, 'provider-evidence-conflict');
      throw error;
    }
  }

  async reconcile(submissionId: string): Promise<WalletExecutionSubmission> {
    const leaseMs = 30_000;
    let claim: WalletExecutionReconciliationClaim | undefined = this.#repository.claimReconciliation(
      submissionId,
      `wallet-reconcile-${randomUUID()}`,
      leaseMs,
      this.#now().getTime(),
    );
    if (!claim) {
      const current = this.#repository.getById(submissionId);
      if (!current) throw new Error('Wallet execution submission was not found');
      return current;
    }
    let leaseLost = false;
    const ensureClaim = () => {
      if (leaseLost || !claim) throw new Error('Wallet execution reconciliation lease was lost');
      const renewed = this.#repository.renewReconciliationClaim(claim, leaseMs, this.#now().getTime());
      if (!renewed) {
        leaseLost = true;
        throw new Error('Wallet execution reconciliation lease was lost');
      }
      claim = renewed;
    };
    const renewal = setInterval(() => {
      try { ensureClaim(); } catch { leaseLost = true; }
    }, Math.floor(leaseMs / 3));
    renewal.unref?.();
    try {
      return await this.#reconcileClaimed(submissionId, ensureClaim);
    } finally {
      clearInterval(renewal);
      if (claim) this.#repository.releaseReconciliationClaim(claim);
    }
  }

  async #reconcileClaimed(submissionId: string, ensureClaim: () => void): Promise<WalletExecutionSubmission> {
    let submission = this.#repository.getById(submissionId);
    if (!submission) throw new Error('Wallet execution submission was not found');
    if (submission.status === 'confirmed') {
      return this.#settleConfirmed(submission, ensureClaim);
    }
    if (submission.status === 'failed' || submission.status === 'review_required' || submission.status === 'prepared') {
      return submission;
    }
    if ((submission.status === 'submitting' || submission.status === 'unknown') && !submission.providerTransactionId) {
      if (!this.#submissionProvider || !this.#signer) return submission;
      // Every pass through here is a blind replay: the provider outcome is unknown and there is no
      // provider transaction id to poll, so the only safety net is the reference id's idempotency
      // window. Bound the replays and hand the submission to a human rather than retrying forever.
      if (submission.blindSubmitAttempts >= MAX_BLIND_SUBMIT_ATTEMPTS) {
        ensureClaim();
        return this.#repository.markReviewRequired(
          submission.submissionId,
          submission.version,
          `blind-submit-attempts-exhausted:${submission.blindSubmitAttempts}`,
        );
      }
      // Counted before the attempt, so a crash mid-attempt still consumes one.
      this.#repository.recordBlindSubmitAttempt(submission.submissionId);
      try {
        const result = await this.#submissionProvider.submit({
          embeddedWalletId: submission.providerWalletId,
          smartWalletAddress: submission.sender,
          caip2: 'eip155:84532',
          contract: submission.contract,
          calldata: submission.calldata,
          referenceId: submission.referenceId,
          sign: this.#signer.sign,
        });
        ensureClaim();
        submission = this.#repository.markSubmitted(submission.submissionId, submission.version, result);
      } catch {
        ensureClaim();
        if (submission.status === 'submitting') {
          return this.#repository.markUnknown(submission.submissionId, submission.version, 'provider-outcome-unknown');
        }
        return submission;
      }
    }
    if (submission.status === 'submitted' || submission.status === 'unknown') {
      if (!submission.providerTransactionId) return submission;
      let providerTransaction: WalletExecutionProviderTransaction;
      try {
        providerTransaction = await this.#provider.getTransaction({
          providerTransactionId: submission.providerTransactionId,
          providerWalletId: submission.providerWalletId,
          referenceId: submission.referenceId,
          recipient: submission.recipient,
          amountAtomic: submission.amountAtomic,
        });
        ensureClaim();
      } catch {
        ensureClaim();
        if (submission.status === 'submitted') {
          return this.#repository.markUnknown(submission.submissionId, submission.version, 'provider-status-unavailable');
        }
        return submission;
      }
      if (!this.#providerIdentityMatches(submission, providerTransaction)) return this.#review(submission, 'provider-evidence-mismatch');
      if (providerTransaction.status === 'pending' || providerTransaction.status === 'broadcasted') return submission;
      if (providerTransaction.status === 'replaced') return this.#review(submission, 'provider-transaction-replaced');
      if (providerTransaction.status === 'failed' || providerTransaction.status === 'provider_error' || providerTransaction.status === 'execution_reverted') {
        return this.#repository.markFailed(submission.submissionId, submission.version, `provider-${providerTransaction.status.replaceAll('_', '-')}`);
      }
      if (!providerTransaction.transactionHash) return this.#review(submission, 'provider-confirmation-missing-hash');
      submission = this.recordProviderConfirmed({
        providerTransactionId: providerTransaction.providerTransactionId,
        providerWalletId: providerTransaction.providerWalletId,
        referenceId: providerTransaction.referenceId!, caip2: providerTransaction.caip2,
        transactionHash: providerTransaction.transactionHash,
      });
    }
    if (submission.status !== 'provider_confirmed' || !submission.transactionHash) return submission;
    let evidence;
    try {
      evidence = await this.#chain.verifyTransfer({
        transactionHash: submission.transactionHash,
        sender: submission.sender,
        recipient: submission.recipient,
        amountAtomic: submission.amountAtomic,
        confirmations: this.#confirmations,
      });
      ensureClaim();
    } catch (error) {
      ensureClaim();
      if (error instanceof ChainConfirmationPendingError) return submission;
      if (error instanceof ChainEvidenceMismatchError) return this.#review(submission, 'chain-evidence-mismatch');
      throw error;
    }
    submission = this.#repository.confirmChain(submission.submissionId, submission.version, {
      transactionHash: evidence.transactionHash,
      blockHash: evidence.blockHash,
      blockNumber: evidence.blockNumber,
      logIndex: evidence.logIndex,
      confirmedAt: this.#now().toISOString(),
    });
    return this.#settleConfirmed(submission, ensureClaim);
  }

  async #settleConfirmed(submission: WalletExecutionSubmission, ensureClaim: () => void): Promise<WalletExecutionSubmission> {
    if (submission.status !== 'confirmed' || !submission.transactionHash || submission.applicationSettledAt !== null) {
      return submission;
    }
    await this.#settle({
      requestId: submission.requestId,
      transactionHash: submission.transactionHash,
      submissionId: submission.referenceId,
    });
    ensureClaim();
    return this.#repository.markApplicationSettled(submission.submissionId, submission.version);
  }

  #providerIdentityMatches(
    submission: WalletExecutionSubmission,
    evidence: {
      providerTransactionId: string;
      providerWalletId: string;
      referenceId: string | null;
      caip2: string;
    },
  ): boolean {
    const providerTransactionMatches = submission.providerTransactionId === evidence.providerTransactionId ||
      (submission.providerTransactionId === null && ['submitting', 'unknown'].includes(submission.status));
    return providerTransactionMatches && submission.providerWalletId === evidence.providerWalletId &&
      submission.referenceId === evidence.referenceId &&
      evidence.caip2 === 'eip155:84532';
  }

  #review(submission: WalletExecutionSubmission, reason: string): WalletExecutionSubmission {
    if (submission.status === 'review_required') return submission;
    if (submission.status === 'confirmed' || submission.status === 'failed' || submission.status === 'prepared') return submission;
    try {
      return this.#repository.markReviewRequired(submission.submissionId, submission.version, reason);
    } catch {
      return this.#repository.getById(submission.submissionId)!;
    }
  }
}
