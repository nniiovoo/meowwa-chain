import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_CONTRACT, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN } from '@meowwa/chain-domain';
import { walletExecutionMigrations } from './migrations.js';
import type {
  PrepareWalletExecutionInput,
  WalletExecutionEvent,
  WalletExecutionStatus,
  WalletExecutionSubmission,
} from './types.js';

type SubmissionRow = {
  submission_id: string; request_id: string; owner_id: string; pet_id: string; binding_id: string; provider_wallet_id: string;
  intent_hash: string; reference_id: string; chain_id: number; contract: string; sender: string;
  recipient: string; amount_atomic: string; value_atomic: string; calldata: string; status: WalletExecutionStatus;
  provider_transaction_id: string | null; user_operation_hash: string | null; transaction_hash: string | null;
  block_hash: string | null; block_number: number | null; log_index: number | null; failure_code: string | null;
  confirmed_at: string | null; application_settled_at: string | null; last_reconciled_at: string | null;
  review_required_at: string | null; review_reason: string | null;
  blind_submit_attempts?: number;
  created_at: string; updated_at: string; version: number;
};

type EventRow = {
  event_id: string; submission_id: string; kind: string; from_status: WalletExecutionStatus | null;
  to_status: WalletExecutionStatus; detail: string | null; created_at: string;
};

const addressPattern = EVM_ADDRESS_PATTERN;
const hashPattern = EVM_HASH_PATTERN;
const digestPattern = /^[a-f0-9]{64}$/;
const referencePattern = /^mw_[a-f0-9]{61}$/;
const amountPattern = /^[1-9][0-9]*$/;
const calldataPattern = /^0x[a-fA-F0-9]{136}$/;

export class SubmissionConflictError extends Error {
  constructor(message = 'Wallet execution identity conflicts with an existing submission') {
    super(message);
    this.name = 'SubmissionConflictError';
  }
}

export interface WalletExecutionReconciliationClaim {
  submissionId: string;
  workerId: string;
  lockedUntil: number;
  fenceToken: number;
}

function assertIdentifier(value: string, name: string): void {
  if (!value.trim() || value.length > 255) throw new Error(`Invalid ${name}`);
}

function assertTimestamp(value: string, name = 'timestamp'): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${name}`);
}

function assertHash(value: string | null, name: string): void {
  if (value !== null && !hashPattern.test(value)) throw new Error(`Invalid ${name}`);
}

function assertPrepareInput(input: PrepareWalletExecutionInput): void {
  for (const [name, value] of Object.entries({
    submissionId: input.submissionId, requestId: input.requestId, ownerId: input.ownerId,
    petId: input.petId, bindingId: input.bindingId, providerWalletId: input.providerWalletId,
  })) assertIdentifier(value, name);
  if (!digestPattern.test(input.intentHash)) throw new Error('Invalid intent hash');
  if (!referencePattern.test(input.referenceId)) throw new Error('Invalid reference ID');
  if (input.chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error('Invalid execution chain');
  if (input.contract.toLowerCase() !== BASE_SEPOLIA_USDC_CONTRACT.toLowerCase()) throw new Error('Invalid execution token');
  if (!addressPattern.test(input.sender) || !addressPattern.test(input.recipient)) throw new Error('Invalid execution address');
  if (!amountPattern.test(input.amountAtomic)) throw new Error('Invalid execution amount');
  if (input.valueAtomic !== '0') throw new Error('Native value is not allowed');
  if (!calldataPattern.test(input.calldata)) throw new Error('Invalid execution calldata');
}

function immutableIdentity(input: PrepareWalletExecutionInput | WalletExecutionSubmission): string {
  return JSON.stringify({
    submissionId: input.submissionId, requestId: input.requestId, ownerId: input.ownerId, petId: input.petId,
    bindingId: input.bindingId, providerWalletId: input.providerWalletId,
    intentHash: input.intentHash, referenceId: input.referenceId,
    chainId: input.chainId, contract: input.contract.toLowerCase(), sender: input.sender.toLowerCase(),
    recipient: input.recipient.toLowerCase(), amountAtomic: input.amountAtomic, valueAtomic: input.valueAtomic,
    calldata: input.calldata.toLowerCase(),
  });
}

export class WalletExecutionRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.#database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS wallet_execution_schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    this.#upgradeMigrationLedger();
    this.#applyMigrations();
  }

  close(): void {
    this.#database.close();
  }

  appliedMigrationVersions(): number[] {
    const rows = this.#database.prepare('SELECT version FROM wallet_execution_schema_migrations ORDER BY version').all() as unknown as Array<{ version: number }>;
    return rows.map((row) => row.version);
  }

  prepare(input: PrepareWalletExecutionInput): WalletExecutionSubmission {
    assertPrepareInput(input);
    return this.#transaction(() => {
      const existing = this.getByRequestId(input.requestId);
      if (existing) {
        if (immutableIdentity(existing) === immutableIdentity(input)) return existing;
        throw new SubmissionConflictError();
      }
      const timestamp = this.#now().toISOString();
      try {
        this.#database.prepare(`
          INSERT INTO wallet_execution_submissions (
            submission_id, request_id, owner_id, pet_id, binding_id, provider_wallet_id, intent_hash, reference_id,
            chain_id, contract, sender, recipient, amount_atomic, value_atomic, calldata, status,
            provider_transaction_id, user_operation_hash, transaction_hash, block_hash, block_number,
            log_index, failure_code, confirmed_at, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1)
        `).run(
          input.submissionId, input.requestId, input.ownerId, input.petId, input.bindingId, input.providerWalletId,
          input.intentHash, input.referenceId, input.chainId, input.contract.toLowerCase(), input.sender.toLowerCase(),
          input.recipient.toLowerCase(), input.amountAtomic, input.valueAtomic, input.calldata.toLowerCase(),
          timestamp, timestamp,
        );
      } catch (error) {
        if (this.#isUniqueConstraint(error)) throw new SubmissionConflictError();
        throw error;
      }
      this.#insertEvent(input.submissionId, 'submission_prepared', null, 'prepared', null, timestamp);
      return this.getById(input.submissionId)!;
    });
  }

  markSubmitting(submissionId: string, expectedVersion: number): WalletExecutionSubmission {
    return this.#transition(submissionId, expectedVersion, ['prepared'], 'submitting', 'provider_submission_started', null, () => ({
      sql: 'failure_code = NULL', values: [],
    }));
  }

  markSubmitted(submissionId: string, expectedVersion: number, input: {
    providerTransactionId: string;
    userOperationHash: string | null;
    transactionHash: string | null;
  }): WalletExecutionSubmission {
    assertIdentifier(input.providerTransactionId, 'provider transaction ID');
    assertHash(input.userOperationHash, 'user operation hash');
    assertHash(input.transactionHash, 'transaction hash');
    const current = this.#requireVersion(submissionId, expectedVersion);
    if (current.providerTransactionId && current.providerTransactionId !== input.providerTransactionId) {
      throw new SubmissionConflictError('Provider transaction ID does not match the submission');
    }
    if (current.userOperationHash && current.userOperationHash.toLowerCase() !== input.userOperationHash?.toLowerCase()) {
      throw new SubmissionConflictError('User operation hash does not match the submission');
    }
    if (current.transactionHash && current.transactionHash.toLowerCase() !== input.transactionHash?.toLowerCase()) {
      throw new SubmissionConflictError('Provider transaction hash does not match the submission');
    }
    return this.#transition(submissionId, expectedVersion, ['submitting', 'unknown'], 'submitted', 'provider_submission_accepted', null, () => ({
      sql: 'provider_transaction_id = ?, user_operation_hash = ?, transaction_hash = ?, failure_code = NULL',
      values: [input.providerTransactionId, input.userOperationHash?.toLowerCase() ?? null, input.transactionHash?.toLowerCase() ?? null],
    }));
  }

  markProviderConfirmed(submissionId: string, expectedVersion: number, input: {
    providerTransactionId: string;
    transactionHash: string;
  }): WalletExecutionSubmission {
    assertIdentifier(input.providerTransactionId, 'provider transaction ID');
    assertHash(input.transactionHash, 'transaction hash');
    const current = this.#requireVersion(submissionId, expectedVersion);
    if (current.providerTransactionId && current.providerTransactionId !== input.providerTransactionId) {
      throw new SubmissionConflictError('Provider transaction ID does not match the submission');
    }
    if (current.transactionHash && current.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) {
      throw new SubmissionConflictError('Provider transaction hash does not match the submission');
    }
    return this.#transition(submissionId, expectedVersion, ['submitting', 'submitted', 'unknown'], 'provider_confirmed', 'provider_transaction_confirmed', null, () => ({
      sql: 'provider_transaction_id = ?, transaction_hash = ?, failure_code = NULL',
      values: [input.providerTransactionId, input.transactionHash.toLowerCase()],
    }));
  }

  confirmChain(submissionId: string, expectedVersion: number, input: {
    transactionHash: string;
    blockHash: string;
    blockNumber: number;
    logIndex: number;
    confirmedAt: string;
  }): WalletExecutionSubmission {
    assertHash(input.transactionHash, 'transaction hash');
    assertHash(input.blockHash, 'block hash');
    if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) throw new Error('Invalid block number');
    if (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0) throw new Error('Invalid log index');
    assertTimestamp(input.confirmedAt, 'confirmation timestamp');
    const current = this.#requireVersion(submissionId, expectedVersion);
    if (current.transactionHash?.toLowerCase() !== input.transactionHash.toLowerCase()) {
      throw new SubmissionConflictError('Chain transaction hash does not match provider evidence');
    }
    return this.#transition(submissionId, expectedVersion, ['provider_confirmed'], 'confirmed', 'chain_transfer_confirmed', null, () => ({
      sql: 'block_hash = ?, block_number = ?, log_index = ?, confirmed_at = ?, failure_code = NULL',
      values: [input.blockHash.toLowerCase(), input.blockNumber, input.logIndex, input.confirmedAt],
    }));
  }

  markApplicationSettled(submissionId: string, expectedVersion: number): WalletExecutionSubmission {
    const current = this.#requireVersion(submissionId, expectedVersion);
    if (current.status !== 'confirmed') throw new Error('Wallet execution is not chain-confirmed');
    if (current.applicationSettledAt !== null) return current;
    return this.#transition(
      submissionId, expectedVersion, ['confirmed'], 'confirmed',
      'application_settlement_committed', null,
      () => ({ sql: 'application_settled_at = ?', values: [this.#now().toISOString()] }),
    );
  }

  markReconcileAttempt(submissionId: string): void {
    assertIdentifier(submissionId, 'submission ID');
    const result = this.#database.prepare(`
      UPDATE wallet_execution_submissions SET last_reconciled_at = ? WHERE submission_id = ?
    `).run(this.#now().toISOString(), submissionId);
    if (Number(result.changes) !== 1) throw new Error('Wallet execution submission was not found');
  }

  claimReconciliation(
    submissionId: string,
    workerId: string,
    leaseMs = 30_000,
    now = this.#now().getTime(),
  ): WalletExecutionReconciliationClaim | undefined {
    assertIdentifier(submissionId, 'submission ID');
    assertIdentifier(workerId, 'reconciliation worker ID');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000 ||
      !Number.isSafeInteger(now) || now < 0 || now + leaseMs > Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid wallet execution reconciliation lease');
    }
    return this.#transaction(() => {
      const lockedUntil = now + leaseMs;
      const result = this.#database.prepare(`
        UPDATE wallet_execution_submissions
        SET reconcile_locked_until = ?, reconcile_locked_by = ?, reconcile_fence_token = reconcile_fence_token + 1,
            last_reconciled_at = ?
        WHERE submission_id = ?
          AND (reconcile_locked_until IS NULL OR reconcile_locked_until <= ?)
          AND (status IN ('submitting', 'submitted', 'provider_confirmed', 'unknown')
            OR (status = 'confirmed' AND application_settled_at IS NULL))
      `).run(lockedUntil, workerId, this.#now().toISOString(), submissionId, now);
      if (Number(result.changes) !== 1) return undefined;
      const row = this.#database.prepare(`
        SELECT reconcile_fence_token FROM wallet_execution_submissions WHERE submission_id = ?
      `).get(submissionId) as { reconcile_fence_token: number };
      return { submissionId, workerId, lockedUntil, fenceToken: row.reconcile_fence_token };
    });
  }

  renewReconciliationClaim(
    claim: WalletExecutionReconciliationClaim,
    leaseMs = 30_000,
    now = this.#now().getTime(),
  ): WalletExecutionReconciliationClaim | undefined {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000 ||
      !Number.isSafeInteger(now) || now < 0 || now + leaseMs > Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid wallet execution reconciliation lease');
    }
    const lockedUntil = now + leaseMs;
    const result = this.#database.prepare(`
      UPDATE wallet_execution_submissions SET reconcile_locked_until = ?
      WHERE submission_id = ? AND reconcile_locked_by = ? AND reconcile_fence_token = ?
        AND reconcile_locked_until = ? AND reconcile_locked_until > ?
    `).run(lockedUntil, claim.submissionId, claim.workerId, claim.fenceToken, claim.lockedUntil, now);
    return Number(result.changes) === 1 ? { ...claim, lockedUntil } : undefined;
  }

  releaseReconciliationClaim(claim: WalletExecutionReconciliationClaim): boolean {
    const result = this.#database.prepare(`
      UPDATE wallet_execution_submissions SET reconcile_locked_until = NULL, reconcile_locked_by = NULL
      WHERE submission_id = ? AND reconcile_locked_by = ? AND reconcile_fence_token = ?
        AND reconcile_locked_until = ?
    `).run(claim.submissionId, claim.workerId, claim.fenceToken, claim.lockedUntil);
    return Number(result.changes) === 1;
  }

  recordConfirmedEvidenceConflict(submissionId: string, detail: string): WalletExecutionSubmission {
    assertIdentifier(detail, 'confirmed evidence conflict');
    return this.#transaction(() => {
      const current = this.getById(submissionId);
      if (!current || current.status !== 'confirmed') throw new Error('Wallet execution is not confirmed');
      const timestamp = this.#now().toISOString();
      const result = this.#database.prepare(`
        UPDATE wallet_execution_submissions
        SET review_required_at = COALESCE(review_required_at, ?), review_reason = ?, updated_at = ?, version = version + 1
        WHERE submission_id = ? AND version = ? AND status = 'confirmed'
      `).run(timestamp, detail, timestamp, submissionId, current.version);
      if (Number(result.changes) !== 1) throw new Error('Wallet execution evidence review update was stale');
      this.#insertEvent(
        submissionId, 'confirmed_evidence_conflict', 'confirmed', 'confirmed', detail, timestamp,
      );
      return this.getById(submissionId)!;
    });
  }

  markUnknown(submissionId: string, expectedVersion: number, reason: string): WalletExecutionSubmission {
    assertIdentifier(reason, 'unknown reason');
    return this.#transition(submissionId, expectedVersion, ['submitting', 'submitted'], 'unknown', 'submission_outcome_unknown', reason, () => ({
      sql: 'failure_code = ?', values: [reason],
    }));
  }

  markFailed(submissionId: string, expectedVersion: number, reason: string): WalletExecutionSubmission {
    assertIdentifier(reason, 'failure reason');
    return this.#transition(submissionId, expectedVersion, ['prepared', 'submitting', 'submitted', 'provider_confirmed', 'unknown'], 'failed', 'submission_failed', reason, () => ({
      sql: 'failure_code = ?', values: [reason],
    }));
  }

  /** Records one blind re-submission before it is attempted, so a crash mid-attempt still counts. */
  recordBlindSubmitAttempt(submissionId: string): number {
    this.#database.prepare(`
      UPDATE wallet_execution_submissions
      SET blind_submit_attempts = blind_submit_attempts + 1
      WHERE submission_id = ?
    `).run(submissionId);
    const row = this.#database.prepare(
      'SELECT blind_submit_attempts FROM wallet_execution_submissions WHERE submission_id = ?',
    ).get(submissionId) as { blind_submit_attempts: number } | undefined;
    return row?.blind_submit_attempts ?? 0;
  }

  markReviewRequired(submissionId: string, expectedVersion: number, reason: string): WalletExecutionSubmission {
    assertIdentifier(reason, 'review reason');
    return this.#transition(submissionId, expectedVersion, ['submitting', 'submitted', 'provider_confirmed', 'unknown'], 'review_required', 'manual_review_required', reason, () => ({
      sql: 'failure_code = ?', values: [reason],
    }));
  }

  reopenCorrectedChainReview(submissionId: string, expectedVersion: number): WalletExecutionSubmission {
    const current = this.#requireVersion(submissionId, expectedVersion);
    if (current.status !== 'review_required' || current.failureCode !== 'chain-evidence-mismatch' ||
        !current.providerTransactionId || !current.transactionHash) {
      throw new Error('Wallet execution is not eligible for corrected chain review');
    }
    return this.#transition(submissionId, expectedVersion, ['review_required'], 'provider_confirmed', 'chain_review_reopened', 'corrected-chain-verifier', () => ({
      sql: 'failure_code = NULL', values: [],
    }));
  }

  getById(submissionId: string): WalletExecutionSubmission | undefined {
    const row = this.#database.prepare('SELECT * FROM wallet_execution_submissions WHERE submission_id = ?').get(submissionId) as SubmissionRow | undefined;
    return row ? this.#toSubmission(row) : undefined;
  }

  getByRequestId(requestId: string): WalletExecutionSubmission | undefined {
    const row = this.#database.prepare('SELECT * FROM wallet_execution_submissions WHERE request_id = ?').get(requestId) as SubmissionRow | undefined;
    return row ? this.#toSubmission(row) : undefined;
  }

  getByReferenceId(referenceId: string): WalletExecutionSubmission | undefined {
    const row = this.#database.prepare('SELECT * FROM wallet_execution_submissions WHERE reference_id = ?').get(referenceId) as SubmissionRow | undefined;
    return row ? this.#toSubmission(row) : undefined;
  }

  getByProviderTransactionId(providerTransactionId: string): WalletExecutionSubmission | undefined {
    const row = this.#database.prepare('SELECT * FROM wallet_execution_submissions WHERE provider_transaction_id = ?').get(providerTransactionId) as SubmissionRow | undefined;
    return row ? this.#toSubmission(row) : undefined;
  }

  listByOwner(ownerId: string): WalletExecutionSubmission[] {
    assertIdentifier(ownerId, 'owner ID');
    const rows = this.#database.prepare(`
      SELECT * FROM wallet_execution_submissions WHERE owner_id = ? ORDER BY created_at DESC, submission_id DESC
    `).all(ownerId) as unknown as SubmissionRow[];
    return rows.map((row) => this.#toSubmission(row));
  }

  listReconcileCandidates(limit = 25): WalletExecutionSubmission[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid wallet reconciliation limit');
    const rows = this.#database.prepare(`
      SELECT * FROM wallet_execution_submissions
      WHERE status IN ('submitting', 'submitted', 'provider_confirmed', 'unknown')
         OR (status = 'confirmed' AND application_settled_at IS NULL)
      ORDER BY CASE WHEN last_reconciled_at IS NULL THEN 0 ELSE 1 END,
               last_reconciled_at, updated_at, submission_id LIMIT ?
    `).all(limit) as unknown as SubmissionRow[];
    return rows.map((row) => this.#toSubmission(row));
  }

  listReviewCandidates(limit = 25): WalletExecutionSubmission[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid wallet review limit');
    const rows = this.#database.prepare(`
      SELECT * FROM wallet_execution_submissions
      WHERE status = 'review_required' OR review_required_at IS NOT NULL
      ORDER BY COALESCE(review_required_at, updated_at), submission_id LIMIT ?
    `).all(limit) as unknown as SubmissionRow[];
    return rows.map((row) => this.#toSubmission(row));
  }

  listEvents(submissionId: string): WalletExecutionEvent[] {
    const rows = this.#database.prepare(`
      SELECT * FROM wallet_execution_events WHERE submission_id = ? ORDER BY created_at, rowid
    `).all(submissionId) as unknown as EventRow[];
    return rows.map((row) => ({
      eventId: row.event_id, submissionId: row.submission_id, kind: row.kind,
      fromStatus: row.from_status, toStatus: row.to_status, detail: row.detail, createdAt: row.created_at,
    }));
  }

  recordWebhookDelivery(input: { deliveryId: string; eventType: string; payloadSha256: string }): boolean {
    assertIdentifier(input.deliveryId, 'webhook delivery ID');
    assertIdentifier(input.eventType, 'webhook event type');
    if (!digestPattern.test(input.payloadSha256)) throw new Error('Invalid webhook payload digest');
    const result = this.#database.prepare(`
      INSERT INTO wallet_execution_webhook_deliveries (delivery_id, event_type, payload_sha256, received_at, processed_at)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(delivery_id) DO NOTHING
    `).run(input.deliveryId, input.eventType, input.payloadSha256, this.#now().toISOString());
    if (Number(result.changes) === 1) return true;
    const prior = this.#database.prepare(`
      SELECT event_type, payload_sha256 FROM wallet_execution_webhook_deliveries WHERE delivery_id = ?
    `).get(input.deliveryId) as { event_type: string; payload_sha256: string };
    if (prior.event_type !== input.eventType || prior.payload_sha256 !== input.payloadSha256) {
      throw new SubmissionConflictError('Webhook delivery identity conflict');
    }
    return false;
  }

  markWebhookProcessed(deliveryId: string): boolean {
    const result = this.#database.prepare(`
      UPDATE wallet_execution_webhook_deliveries SET processed_at = ?
      WHERE delivery_id = ? AND processed_at IS NULL
    `).run(this.#now().toISOString(), deliveryId);
    return Number(result.changes) === 1;
  }

  isWebhookProcessed(deliveryId: string): boolean {
    assertIdentifier(deliveryId, 'webhook delivery ID');
    const row = this.#database.prepare(`
      SELECT processed_at FROM wallet_execution_webhook_deliveries WHERE delivery_id = ?
    `).get(deliveryId) as { processed_at: string | null } | undefined;
    return row?.processed_at !== null && row?.processed_at !== undefined;
  }

  getReceiveScanCursor(chainId: 84532, contractAddress: string, defaultNextBlock: bigint): {
    nextBlock: bigint;
    checkpoint: { blockNumber: bigint; blockHash: `0x${string}` } | null;
  } {
    if (chainId !== 84532 || contractAddress.toLowerCase() !== BASE_SEPOLIA_USDC_CONTRACT.toLowerCase() ||
        defaultNextBlock < 0n || defaultNextBlock > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Invalid receive scan cursor request');
    }
    const row = this.#database.prepare(`
      SELECT next_block, checkpoint_block, checkpoint_hash
      FROM wallet_receive_scan_cursors WHERE chain_id = ? AND lower(contract_address) = lower(?)
    `).get(chainId, contractAddress) as { next_block: number; checkpoint_block: number | null; checkpoint_hash: string | null } | undefined;
    if (!row) return { nextBlock: defaultNextBlock, checkpoint: null };
    if (!Number.isSafeInteger(row.next_block) || row.next_block < 0 ||
        (row.checkpoint_block === null) !== (row.checkpoint_hash === null) ||
        (row.checkpoint_block !== null && (!Number.isSafeInteger(row.checkpoint_block) || row.checkpoint_block < 0 || !hashPattern.test(row.checkpoint_hash!)))) {
      throw new Error('Stored receive scan cursor is invalid');
    }
    return {
      nextBlock: BigInt(row.next_block),
      checkpoint: row.checkpoint_block === null ? null : { blockNumber: BigInt(row.checkpoint_block), blockHash: row.checkpoint_hash!.toLowerCase() as `0x${string}` },
    };
  }

  advanceReceiveScanCursor(input: {
    chainId: 84532; contractAddress: string; expectedNextBlock: bigint; nextBlock: bigint;
    checkpointBlock: bigint; checkpointHash: string;
  }): boolean {
    if (input.chainId !== 84532 || input.contractAddress.toLowerCase() !== BASE_SEPOLIA_USDC_CONTRACT.toLowerCase() ||
        input.expectedNextBlock < 0n || input.nextBlock < input.expectedNextBlock ||
        input.nextBlock > BigInt(Number.MAX_SAFE_INTEGER) || input.checkpointBlock < 0n ||
        input.checkpointBlock >= input.nextBlock || !hashPattern.test(input.checkpointHash)) {
      throw new Error('Invalid receive scan cursor update');
    }
    const expected = Number(input.expectedNextBlock);
    const next = Number(input.nextBlock);
    const checkpoint = Number(input.checkpointBlock);
    return this.#transaction(() => {
      const row = this.#database.prepare(`
        SELECT next_block FROM wallet_receive_scan_cursors
        WHERE chain_id = ? AND lower(contract_address) = lower(?)
      `).get(input.chainId, input.contractAddress) as { next_block: number } | undefined;
      if (!row) {
        const result = this.#database.prepare(`
          INSERT INTO wallet_receive_scan_cursors
            (chain_id, contract_address, next_block, checkpoint_block, checkpoint_hash, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(input.chainId, input.contractAddress.toLowerCase(), next, checkpoint, input.checkpointHash.toLowerCase(), this.#now().toISOString());
        return Number(result.changes) === 1;
      }
      if (row.next_block !== expected) return false;
      const result = this.#database.prepare(`
        UPDATE wallet_receive_scan_cursors
        SET next_block = ?, checkpoint_block = ?, checkpoint_hash = ?, updated_at = ?
        WHERE chain_id = ? AND lower(contract_address) = lower(?) AND next_block = ?
      `).run(next, checkpoint, input.checkpointHash.toLowerCase(), this.#now().toISOString(), input.chainId, input.contractAddress, expected);
      return Number(result.changes) === 1;
    });
  }

  rewindReceiveScanCursor(input: {
    chainId: 84532; contractAddress: string; expectedNextBlock: bigint; nextBlock: bigint;
  }): boolean {
    if (input.chainId !== 84532 || input.contractAddress.toLowerCase() !== BASE_SEPOLIA_USDC_CONTRACT.toLowerCase() ||
        input.expectedNextBlock < 0n || input.expectedNextBlock > BigInt(Number.MAX_SAFE_INTEGER) ||
        input.nextBlock < 0n || input.nextBlock > input.expectedNextBlock) {
      throw new Error('Invalid receive scan cursor rewind');
    }
    const expected = Number(input.expectedNextBlock);
    const next = Number(input.nextBlock);
    const result = this.#database.prepare(`
      UPDATE wallet_receive_scan_cursors
      SET next_block = ?, checkpoint_block = NULL, checkpoint_hash = NULL, updated_at = ?
      WHERE chain_id = ? AND lower(contract_address) = lower(?) AND next_block = ?
    `).run(next, this.#now().toISOString(), input.chainId, input.contractAddress, expected);
    return Number(result.changes) === 1;
  }

  #requireVersion(submissionId: string, expectedVersion: number): WalletExecutionSubmission {
    const current = this.getById(submissionId);
    if (!current) throw new Error('Wallet execution submission was not found');
    if (current.version !== expectedVersion) throw new Error('Wallet execution transition is stale');
    return current;
  }

  #transition(
    submissionId: string,
    expectedVersion: number,
    allowedFrom: WalletExecutionStatus[],
    toStatus: WalletExecutionStatus,
    kind: string,
    detail: string | null,
    update: () => { sql: string; values: Array<string | number | null> },
  ): WalletExecutionSubmission {
    return this.#transaction(() => {
      const current = this.#requireVersion(submissionId, expectedVersion);
      if (!allowedFrom.includes(current.status)) throw new Error(`Cannot transition wallet execution from ${current.status}`);
      const timestamp = this.#now().toISOString();
      const mutation = update();
      let result;
      try {
        result = this.#database.prepare(`
          UPDATE wallet_execution_submissions
          SET status = ?, ${mutation.sql}, updated_at = ?, version = version + 1
          WHERE submission_id = ? AND version = ?
        `).run(toStatus, ...mutation.values, timestamp, submissionId, expectedVersion);
      } catch (error) {
        if (this.#isUniqueConstraint(error)) throw new SubmissionConflictError();
        throw error;
      }
      if (Number(result.changes) !== 1) throw new Error('Wallet execution transition is stale');
      this.#insertEvent(submissionId, kind, current.status, toStatus, detail, timestamp);
      return this.getById(submissionId)!;
    });
  }

  #insertEvent(
    submissionId: string,
    kind: string,
    fromStatus: WalletExecutionStatus | null,
    toStatus: WalletExecutionStatus,
    detail: string | null,
    createdAt: string,
  ): void {
    this.#database.prepare(`
      INSERT INTO wallet_execution_events (event_id, submission_id, kind, from_status, to_status, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), submissionId, kind, fromStatus, toStatus, detail, createdAt);
  }

  #toSubmission(row: SubmissionRow): WalletExecutionSubmission {
    const candidate: PrepareWalletExecutionInput = {
      submissionId: row.submission_id, requestId: row.request_id, ownerId: row.owner_id, petId: row.pet_id,
      bindingId: row.binding_id, providerWalletId: row.provider_wallet_id,
      intentHash: row.intent_hash, referenceId: row.reference_id,
      chainId: row.chain_id as 84532, contract: row.contract, sender: row.sender, recipient: row.recipient,
      amountAtomic: row.amount_atomic, valueAtomic: row.value_atomic as '0', calldata: row.calldata as `0x${string}`,
    };
    assertPrepareInput(candidate);
    assertHash(row.user_operation_hash, 'stored user operation hash');
    assertHash(row.transaction_hash, 'stored transaction hash');
    assertHash(row.block_hash, 'stored block hash');
    assertTimestamp(row.created_at, 'stored creation timestamp');
    assertTimestamp(row.updated_at, 'stored update timestamp');
    if (row.confirmed_at !== null) assertTimestamp(row.confirmed_at, 'stored confirmation timestamp');
    if (row.application_settled_at !== null) assertTimestamp(row.application_settled_at, 'stored application settlement timestamp');
    if (row.review_required_at !== null) assertTimestamp(row.review_required_at, 'stored review timestamp');
    return {
      ...candidate,
      status: row.status,
      providerTransactionId: row.provider_transaction_id,
      userOperationHash: row.user_operation_hash === null ? null : row.user_operation_hash.toLowerCase() as `0x${string}`,
      transactionHash: row.transaction_hash === null ? null : row.transaction_hash.toLowerCase() as `0x${string}`,
      blockHash: row.block_hash === null ? null : row.block_hash.toLowerCase() as `0x${string}`,
      blockNumber: row.block_number,
      logIndex: row.log_index,
      failureCode: row.failure_code,
      confirmedAt: row.confirmed_at,
      applicationSettledAt: row.application_settled_at,
      reviewRequiredAt: row.review_required_at,
      reviewReason: row.review_reason,
      blindSubmitAttempts: row.blind_submit_attempts ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  #applyMigrations(): void {
    for (const migration of walletExecutionMigrations) {
      this.#transaction(() => {
        const checksum = createHash('sha256').update(migration.sql).digest('hex');
        const applied = this.#database.prepare('SELECT checksum FROM wallet_execution_schema_migrations WHERE version = ?').get(migration.version) as { checksum: string } | undefined;
        if (applied) {
          if (applied.checksum !== checksum) throw new Error('Wallet execution schema migration checksum does not match source');
          return;
        }
        this.#database.exec(migration.sql);
        this.#database.prepare(`
          INSERT INTO wallet_execution_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)
        `).run(migration.version, checksum, this.#now().toISOString());
      });
    }
  }

  #upgradeMigrationLedger(): void {
    this.#transaction(() => {
      const columns = this.#database.prepare('PRAGMA table_info(wallet_execution_schema_migrations)').all() as unknown as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === 'checksum')) {
        this.#database.exec('ALTER TABLE wallet_execution_schema_migrations ADD COLUMN checksum TEXT');
      }
      const applied = this.#database.prepare('SELECT version, checksum FROM wallet_execution_schema_migrations').all() as unknown as Array<{ version: number; checksum: string | null }>;
      for (const row of applied) {
        const migration = walletExecutionMigrations.find(({ version }) => version === row.version);
        if (!migration) throw new Error('Wallet execution database was created by an unsupported newer schema');
        const checksum = createHash('sha256').update(migration.sql).digest('hex');
        if (row.checksum !== null && row.checksum !== checksum) throw new Error('Wallet execution schema migration checksum does not match source');
        if (row.checksum === null) this.#database.prepare('UPDATE wallet_execution_schema_migrations SET checksum = ? WHERE version = ?').run(checksum, row.version);
      }
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #isUniqueConstraint(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
  }
}
