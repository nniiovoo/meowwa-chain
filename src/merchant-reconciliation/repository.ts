import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { merchantReconciliationMigrations } from './migrations.js';
import type {
  ControlledMerchantQuote,
  MerchantOrder,
  MerchantOrderStatus,
  MerchantReconciliationEvent,
  MerchantRefund,
  MerchantRefundStatus,
  PrepareMerchantOrderInput,
  PrepareMerchantRefundInput,
} from './types.js';
import { EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN } from '@meowwa/chain-domain';

type QuoteRow = {
  quote_id: string; provider_revision: string; merchant_id: string; merchant_name: string; merchant_recipient: string;
  product_id: string; product_name: string; amount_minor: number; tax_minor: number; shipping_minor: number; fees_minor: number;
  expires_at: string; verified_at: string; identity_sha256: string;
};
type OrderRow = {
  order_id: string; request_id: string; owner_id: string; pet_id: string; quote_id: string; merchant_id: string; product_id: string;
  merchant_recipient: string; pet_wallet_address: string; amount_minor: number; amount_atomic: string;
  payment_transaction_hash: string; provider_reference: string; provider_order_id: string | null; status: MerchantOrderStatus;
  failure_code: string | null; identity_sha256: string; created_at: string; updated_at: string; version: number;
  internal_settled_at: string | null;
  last_reconciled_at: string | null;
};
type RefundRow = {
  refund_id: string; order_id: string; request_id: string; amount_minor: number; amount_atomic: string; provider_reference: string;
  provider_refund_id: string | null; transaction_hash: string | null; block_hash: string | null; block_number: number | null;
  log_index: number | null; status: MerchantRefundStatus; failure_code: string | null; confirmed_at: string | null;
  identity_sha256: string; created_at: string; updated_at: string; version: number;
  internal_settled_at: string | null;
  last_reconciled_at: string | null;
};
type EventRow = {
  event_id: string; aggregate_type: 'order' | 'refund'; aggregate_id: string; kind: string; from_status: MerchantOrderStatus | MerchantRefundStatus | null;
  to_status: MerchantOrderStatus | MerchantRefundStatus; detail: string | null; created_at: string;
};

const addressPattern = EVM_ADDRESS_PATTERN;
const hashPattern = EVM_HASH_PATTERN;
const amountPattern = /^[1-9][0-9]*$/;
const digestPattern = /^[a-f0-9]{64}$/;
const orderReferencePattern = /^mwo_[a-f0-9]{61}$/;
const refundReferencePattern = /^mwr_[a-f0-9]{61}$/;

export class MerchantIdentityConflictError extends Error {
  constructor(message = 'Merchant reconciliation identity conflicts with a durable record') {
    super(message);
    this.name = 'MerchantIdentityConflictError';
  }
}

function identifier(value: string, label: string): void {
  if (!value.trim() || value.length > 255) throw new Error(`Invalid ${label}`);
}

function timestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}`);
}

function minor(value: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(`Invalid ${label}`);
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function quoteIdentity(input: ControlledMerchantQuote): Record<string, unknown> {
  return {
    quoteId: input.quoteId, providerRevision: input.providerRevision, merchantId: input.merchantId,
    merchantName: input.merchantName, merchantRecipient: input.merchantRecipient.toLowerCase(),
    productId: input.productId, productName: input.productName, amountMinor: input.amountMinor,
    taxMinor: input.taxMinor, shippingMinor: input.shippingMinor, feesMinor: input.feesMinor,
    expiresAt: input.expiresAt, verifiedAt: input.verifiedAt,
  };
}

function orderIdentity(input: PrepareMerchantOrderInput | MerchantOrder): Record<string, unknown> {
  return {
    orderId: input.orderId, requestId: input.requestId, ownerId: input.ownerId, petId: input.petId,
    quoteId: input.quoteId, merchantId: input.merchantId, productId: input.productId,
    merchantRecipient: input.merchantRecipient.toLowerCase(), petWalletAddress: input.petWalletAddress.toLowerCase(),
    amountMinor: input.amountMinor, amountAtomic: input.amountAtomic,
    paymentTransactionHash: input.paymentTransactionHash.toLowerCase(), providerReference: input.providerReference,
  };
}

function refundIdentity(input: PrepareMerchantRefundInput | MerchantRefund): Record<string, unknown> {
  return {
    refundId: input.refundId, orderId: input.orderId, requestId: input.requestId,
    amountMinor: input.amountMinor, amountAtomic: input.amountAtomic, providerReference: input.providerReference,
  };
}

function validateQuote(input: ControlledMerchantQuote): void {
  for (const [label, value] of Object.entries({
    'quote ID': input.quoteId, 'provider revision': input.providerRevision, 'merchant ID': input.merchantId,
    'merchant name': input.merchantName, 'product ID': input.productId, 'product name': input.productName,
  })) identifier(value, label);
  if (!addressPattern.test(input.merchantRecipient)) throw new Error('Invalid merchant recipient');
  minor(input.amountMinor, 'quote amount', true);
  minor(input.taxMinor, 'quote tax'); minor(input.shippingMinor, 'quote shipping'); minor(input.feesMinor, 'quote fees');
  timestamp(input.expiresAt, 'quote expiry'); timestamp(input.verifiedAt, 'quote verification');
  if (Date.parse(input.expiresAt) <= Date.parse(input.verifiedAt)) throw new Error('Invalid merchant quote window');
}

function validateOrder(input: PrepareMerchantOrderInput): void {
  for (const [label, value] of Object.entries({
    'order ID': input.orderId, 'request ID': input.requestId, 'owner ID': input.ownerId, 'pet ID': input.petId,
    'quote ID': input.quoteId, 'merchant ID': input.merchantId, 'product ID': input.productId,
  })) identifier(value, label);
  if (!addressPattern.test(input.merchantRecipient) || !addressPattern.test(input.petWalletAddress)) throw new Error('Invalid order address');
  minor(input.amountMinor, 'order amount', true);
  if (!amountPattern.test(input.amountAtomic) || BigInt(input.amountAtomic) !== BigInt(input.amountMinor) * 10_000n) {
    throw new Error('Invalid order atomic amount');
  }
  if (!hashPattern.test(input.paymentTransactionHash)) throw new Error('Invalid payment transaction hash');
  if (!orderReferencePattern.test(input.providerReference)) throw new Error('Invalid order provider reference');
}

function validateRefund(input: PrepareMerchantRefundInput): void {
  for (const [label, value] of Object.entries({ 'refund ID': input.refundId, 'order ID': input.orderId, 'request ID': input.requestId })) identifier(value, label);
  minor(input.amountMinor, 'refund amount', true);
  if (!amountPattern.test(input.amountAtomic) || BigInt(input.amountAtomic) !== BigInt(input.amountMinor) * 10_000n) {
    throw new Error('Invalid refund atomic amount');
  }
  if (!refundReferencePattern.test(input.providerReference)) throw new Error('Invalid refund provider reference');
}

export class MerchantReconciliationRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.#database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.#database.exec(`CREATE TABLE IF NOT EXISTS merchant_reconciliation_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    this.#upgradeMigrationLedger();
    this.#applyMigrations();
  }

  close(): void { this.#database.close(); }

  appliedMigrationVersions(): number[] {
    const rows = this.#database.prepare('SELECT version FROM merchant_reconciliation_schema_migrations ORDER BY version').all() as unknown as Array<{ version: number }>;
    return rows.map((row) => row.version);
  }

  putQuote(input: ControlledMerchantQuote): ControlledMerchantQuote {
    validateQuote(input);
    const identitySha256 = digest(quoteIdentity(input));
    const existing = this.#database.prepare('SELECT * FROM merchant_quotes WHERE quote_id = ?').get(input.quoteId) as QuoteRow | undefined;
    if (existing) {
      if (existing.identity_sha256 !== identitySha256) throw new MerchantIdentityConflictError('Merchant quote identity conflicts');
      return this.#quote(existing);
    }
    try {
      this.#database.prepare(`
        INSERT INTO merchant_quotes (
          quote_id, provider_revision, merchant_id, merchant_name, merchant_recipient, product_id, product_name,
          amount_minor, tax_minor, shipping_minor, fees_minor, expires_at, verified_at, identity_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.quoteId, input.providerRevision, input.merchantId, input.merchantName, input.merchantRecipient.toLowerCase(),
        input.productId, input.productName, input.amountMinor, input.taxMinor, input.shippingMinor, input.feesMinor,
        input.expiresAt, input.verifiedAt, identitySha256,
      );
    } catch (error) { this.#translateUnique(error); }
    return this.getQuote(input.quoteId)!;
  }

  getQuote(quoteId: string): ControlledMerchantQuote | undefined {
    const row = this.#database.prepare('SELECT * FROM merchant_quotes WHERE quote_id = ?').get(quoteId) as QuoteRow | undefined;
    return row ? this.#quote(row) : undefined;
  }

  latestValidQuote(now = this.#now()): ControlledMerchantQuote | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM merchant_quotes
      WHERE julianday(verified_at) <= julianday(?) AND julianday(expires_at) > julianday(?)
      ORDER BY julianday(verified_at) DESC, quote_id DESC LIMIT 1
    `).get(now.toISOString(), now.toISOString()) as QuoteRow | undefined;
    return row ? this.#quote(row) : undefined;
  }

  latestValidQuoteForProduct(productId: string, now = this.#now()): ControlledMerchantQuote | undefined {
    identifier(productId, 'product ID');
    const row = this.#database.prepare(`
      SELECT * FROM merchant_quotes
      WHERE product_id = ? AND julianday(verified_at) <= julianday(?) AND julianday(expires_at) > julianday(?)
      ORDER BY julianday(verified_at) DESC, quote_id DESC LIMIT 1
    `).get(productId, now.toISOString(), now.toISOString()) as QuoteRow | undefined;
    return row ? this.#quote(row) : undefined;
  }

  prepareOrder(input: PrepareMerchantOrderInput): MerchantOrder {
    validateOrder(input);
    return this.#transaction(() => {
      const existing = this.getOrderByRequestId(input.requestId);
      const identitySha256 = digest(orderIdentity(input));
      if (existing) {
        if (digest(orderIdentity(existing)) !== identitySha256) throw new MerchantIdentityConflictError('Merchant order identity conflicts');
        return existing;
      }
      const quote = this.getQuote(input.quoteId);
      if (!quote || quote.merchantId !== input.merchantId || quote.productId !== input.productId ||
          quote.merchantRecipient.toLowerCase() !== input.merchantRecipient.toLowerCase() || quote.amountMinor !== input.amountMinor) {
        throw new MerchantIdentityConflictError('Merchant order does not match its authenticated quote');
      }
      const createdAt = this.#now().toISOString();
      try {
        this.#database.prepare(`
          INSERT INTO merchant_orders (
            order_id, request_id, owner_id, pet_id, quote_id, merchant_id, product_id, merchant_recipient,
            pet_wallet_address, amount_minor, amount_atomic, payment_transaction_hash, provider_reference,
            provider_order_id, status, failure_code, internal_settled_at, identity_sha256, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', NULL, NULL, ?, ?, ?, 1)
        `).run(
          input.orderId, input.requestId, input.ownerId, input.petId, input.quoteId, input.merchantId, input.productId,
          input.merchantRecipient.toLowerCase(), input.petWalletAddress.toLowerCase(), input.amountMinor, input.amountAtomic,
          input.paymentTransactionHash.toLowerCase(), input.providerReference, identitySha256, createdAt, createdAt,
        );
      } catch (error) { this.#translateUnique(error); }
      this.#event('order', input.orderId, 'order_prepared', null, 'prepared', null, createdAt);
      return this.getOrder(input.orderId)!;
    });
  }

  getOrder(orderId: string): MerchantOrder | undefined {
    const row = this.#database.prepare('SELECT * FROM merchant_orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
    return row ? this.#order(row) : undefined;
  }

  getOrderByRequestId(requestId: string): MerchantOrder | undefined {
    const row = this.#database.prepare('SELECT * FROM merchant_orders WHERE request_id = ?').get(requestId) as OrderRow | undefined;
    return row ? this.#order(row) : undefined;
  }

  getOrderByReference(reference: string): MerchantOrder | undefined {
    const row = this.#database.prepare('SELECT * FROM merchant_orders WHERE provider_reference = ?').get(reference) as OrderRow | undefined;
    return row ? this.#order(row) : undefined;
  }

  listOrdersByOwner(ownerId: string): MerchantOrder[] {
    identifier(ownerId, 'owner ID');
    const rows = this.#database.prepare('SELECT * FROM merchant_orders WHERE owner_id = ? ORDER BY created_at DESC, order_id DESC').all(ownerId) as unknown as OrderRow[];
    return rows.map((row) => this.#order(row));
  }

  listOrderCandidates(limit = 25): MerchantOrder[] {
    this.#limit(limit);
    const rows = this.#database.prepare(`
      SELECT * FROM merchant_orders
      WHERE status IN ('prepared','submitting','submitted','unknown','cancel_pending')
         OR (status IN ('confirmed','fulfilled') AND internal_settled_at IS NULL)
      ORDER BY CASE WHEN last_reconciled_at IS NULL THEN 0 ELSE 1 END,
               last_reconciled_at, updated_at, order_id LIMIT ?
    `).all(limit) as unknown as OrderRow[];
    return rows.map((row) => this.#order(row));
  }

  markOrderReconcileAttempt(orderId: string): void {
    identifier(orderId, 'order ID');
    const result = this.#database.prepare('UPDATE merchant_orders SET last_reconciled_at = ? WHERE order_id = ?')
      .run(this.#now().toISOString(), orderId);
    if (Number(result.changes) !== 1) throw new Error('Merchant order was not found');
  }

  /** Records one blind order creation before it is attempted, so a crash mid-attempt still counts. */
  recordBlindCreateAttempt(orderId: string): number {
    identifier(orderId, 'order ID');
    this.#database.prepare('UPDATE merchant_orders SET blind_create_attempts = blind_create_attempts + 1 WHERE order_id = ?')
      .run(orderId);
    const row = this.#database.prepare('SELECT blind_create_attempts FROM merchant_orders WHERE order_id = ?')
      .get(orderId) as { blind_create_attempts: number } | undefined;
    return row?.blind_create_attempts ?? 0;
  }

  /** The refund twin of recordBlindCreateAttempt: same pre-increment, so a crash mid-attempt counts. */
  recordRefundBlindCreateAttempt(refundId: string): number {
    identifier(refundId, 'refund ID');
    this.#database.prepare('UPDATE merchant_refunds SET blind_create_attempts = blind_create_attempts + 1 WHERE refund_id = ?')
      .run(refundId);
    const row = this.#database.prepare('SELECT blind_create_attempts FROM merchant_refunds WHERE refund_id = ?')
      .get(refundId) as { blind_create_attempts: number } | undefined;
    return row?.blind_create_attempts ?? 0;
  }

  markOrderSubmitting(orderId: string, version: number): MerchantOrder {
    return this.#orderTransition(orderId, version, ['prepared'], 'submitting', 'order_submission_started', null, 'failure_code = NULL', []);
  }

  markOrderSubmitted(orderId: string, version: number, providerOrderId: string): MerchantOrder {
    identifier(providerOrderId, 'provider order ID');
    const current = this.#requireOrder(orderId, version);
    if (current.providerOrderId && current.providerOrderId !== providerOrderId) throw new MerchantIdentityConflictError('Provider order ID conflicts');
    return this.#orderTransition(orderId, version, ['submitting','unknown'], 'submitted', 'order_submitted', null, 'provider_order_id = ?, failure_code = NULL', [providerOrderId]);
  }

  confirmOrder(orderId: string, version: number, providerOrderId: string): MerchantOrder {
    identifier(providerOrderId, 'provider order ID');
    const current = this.#requireOrder(orderId, version);
    if (current.providerOrderId && current.providerOrderId !== providerOrderId) throw new MerchantIdentityConflictError('Provider order ID conflicts');
    return this.#orderTransition(orderId, version, ['submitting','submitted','unknown'], 'confirmed', 'order_confirmed', null, 'provider_order_id = ?, failure_code = NULL', [providerOrderId]);
  }

  fulfillOrder(orderId: string, version: number): MerchantOrder {
    return this.#orderTransition(orderId, version, ['confirmed'], 'fulfilled', 'order_fulfilled', null, 'failure_code = NULL', []);
  }

  markOrderUnknown(orderId: string, version: number, reason: string): MerchantOrder {
    identifier(reason, 'order unknown reason');
    return this.#orderTransition(orderId, version, ['submitting','submitted'], 'unknown', 'order_outcome_unknown', reason, 'failure_code = ?', [reason]);
  }

  failOrder(orderId: string, version: number, reason: string): MerchantOrder {
    identifier(reason, 'order failure reason');
    return this.#orderTransition(orderId, version, ['prepared','submitting','submitted','unknown'], 'failed', 'order_failed', reason, 'failure_code = ?', [reason]);
  }

  reviewOrder(orderId: string, version: number, reason: string): MerchantOrder {
    identifier(reason, 'order review reason');
    return this.#orderTransition(orderId, version, ['prepared','submitting','submitted','confirmed','fulfilled','failed','cancelled','unknown','cancel_pending'], 'review_required', 'order_review_required', reason, 'failure_code = ?', [reason]);
  }

  markOrderInternalSettled(orderId: string, version: number, settledAt: string): MerchantOrder {
    timestamp(settledAt, 'order internal settlement');
    const current = this.#requireOrder(orderId, version);
    if (!['confirmed', 'fulfilled'].includes(current.status)) throw new Error(`Cannot settle merchant order from ${current.status}`);
    if (current.internalSettledAt) return current;
    return this.#orderTransition(orderId, version, [current.status], current.status, 'order_internal_settled', null, 'internal_settled_at = ?, failure_code = NULL', [settledAt]);
  }

  prepareRefund(input: PrepareMerchantRefundInput): MerchantRefund {
    validateRefund(input);
    return this.#transaction(() => {
      const existing = this.getRefundByRequestId(input.requestId);
      const identitySha256 = digest(refundIdentity(input));
      if (existing) {
        if (digest(refundIdentity(existing)) !== identitySha256) throw new MerchantIdentityConflictError('Merchant refund identity conflicts');
        return existing;
      }
      const order = this.getOrder(input.orderId);
      if (!order || order.requestId !== input.requestId || !['confirmed', 'fulfilled'].includes(order.status) ||
          order.amountMinor !== input.amountMinor || order.amountAtomic !== input.amountAtomic) {
        throw new MerchantIdentityConflictError('Merchant refund does not match a confirmed order');
      }
      const createdAt = this.#now().toISOString();
      try {
        this.#database.prepare(`
          INSERT INTO merchant_refunds (
            refund_id, order_id, request_id, amount_minor, amount_atomic, provider_reference, provider_refund_id,
            transaction_hash, block_hash, block_number, log_index, status, failure_code, confirmed_at, internal_settled_at,
            identity_sha256, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'prepared', NULL, NULL, NULL, ?, ?, ?, 1)
        `).run(input.refundId, input.orderId, input.requestId, input.amountMinor, input.amountAtomic, input.providerReference, identitySha256, createdAt, createdAt);
      } catch (error) { this.#translateUnique(error); }
      this.#event('refund', input.refundId, 'refund_prepared', null, 'prepared', null, createdAt);
      return this.getRefund(input.refundId)!;
    });
  }

  getRefund(refundId: string): MerchantRefund | undefined {
    const row = this.#database.prepare('SELECT * FROM merchant_refunds WHERE refund_id = ?').get(refundId) as RefundRow | undefined;
    return row ? this.#refund(row) : undefined;
  }

  getRefundByRequestId(requestId: string): MerchantRefund | undefined {
    const row = this.#database.prepare('SELECT * FROM merchant_refunds WHERE request_id = ?').get(requestId) as RefundRow | undefined;
    return row ? this.#refund(row) : undefined;
  }

  getRefundByReference(reference: string): MerchantRefund | undefined {
    const row = this.#database.prepare('SELECT * FROM merchant_refunds WHERE provider_reference = ?').get(reference) as RefundRow | undefined;
    return row ? this.#refund(row) : undefined;
  }

  listRefundCandidates(limit = 25): MerchantRefund[] {
    this.#limit(limit);
    const rows = this.#database.prepare(`
      SELECT * FROM merchant_refunds
      WHERE status IN ('prepared','submitting','submitted','provider_confirmed','unknown')
         OR (status = 'chain_confirmed' AND internal_settled_at IS NULL)
      ORDER BY CASE WHEN last_reconciled_at IS NULL THEN 0 ELSE 1 END,
               last_reconciled_at, updated_at, refund_id LIMIT ?
    `).all(limit) as unknown as RefundRow[];
    return rows.map((row) => this.#refund(row));
  }

  markRefundReconcileAttempt(refundId: string): void {
    identifier(refundId, 'refund ID');
    const result = this.#database.prepare('UPDATE merchant_refunds SET last_reconciled_at = ? WHERE refund_id = ?')
      .run(this.#now().toISOString(), refundId);
    if (Number(result.changes) !== 1) throw new Error('Merchant refund was not found');
  }

  markRefundSubmitting(refundId: string, version: number): MerchantRefund {
    return this.#refundTransition(refundId, version, ['prepared'], 'submitting', 'refund_submission_started', null, 'failure_code = NULL', []);
  }

  markRefundSubmitted(refundId: string, version: number, providerRefundId: string): MerchantRefund {
    identifier(providerRefundId, 'provider refund ID');
    const current = this.#requireRefund(refundId, version);
    if (current.providerRefundId && current.providerRefundId !== providerRefundId) throw new MerchantIdentityConflictError('Provider refund ID conflicts');
    return this.#refundTransition(refundId, version, ['submitting','unknown'], 'submitted', 'refund_submitted', null, 'provider_refund_id = ?, failure_code = NULL', [providerRefundId]);
  }

  confirmRefundProvider(refundId: string, version: number, input: { providerRefundId: string; transactionHash: string }): MerchantRefund {
    identifier(input.providerRefundId, 'provider refund ID');
    if (!hashPattern.test(input.transactionHash)) throw new Error('Invalid refund transaction hash');
    const current = this.#requireRefund(refundId, version);
    if ((current.providerRefundId && current.providerRefundId !== input.providerRefundId) ||
        (current.transactionHash && current.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase())) {
      throw new MerchantIdentityConflictError('Provider refund evidence conflicts');
    }
    return this.#refundTransition(refundId, version, ['submitting','submitted','unknown'], 'provider_confirmed', 'refund_provider_confirmed', null,
      'provider_refund_id = ?, transaction_hash = ?, failure_code = NULL', [input.providerRefundId, input.transactionHash.toLowerCase()]);
  }

  confirmRefundChain(refundId: string, version: number, input: {
    transactionHash: string; blockHash: string; blockNumber: number; logIndex: number; confirmedAt: string;
  }): MerchantRefund {
    if (!hashPattern.test(input.transactionHash) || !hashPattern.test(input.blockHash)) throw new Error('Invalid refund chain hash');
    if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 || !Number.isSafeInteger(input.logIndex) || input.logIndex < 0) throw new Error('Invalid refund chain position');
    timestamp(input.confirmedAt, 'refund confirmation');
    const current = this.#requireRefund(refundId, version);
    if (current.transactionHash?.toLowerCase() !== input.transactionHash.toLowerCase()) throw new MerchantIdentityConflictError('Refund transaction hash conflicts');
    return this.#refundTransition(refundId, version, ['provider_confirmed'], 'chain_confirmed', 'refund_chain_confirmed', null,
      'block_hash = ?, block_number = ?, log_index = ?, confirmed_at = ?, failure_code = NULL',
      [input.blockHash.toLowerCase(), input.blockNumber, input.logIndex, input.confirmedAt]);
  }

  markRefundUnknown(refundId: string, version: number, reason: string): MerchantRefund {
    identifier(reason, 'refund unknown reason');
    return this.#refundTransition(refundId, version, ['submitting','submitted'], 'unknown', 'refund_outcome_unknown', reason, 'failure_code = ?', [reason]);
  }

  failRefund(refundId: string, version: number, reason: string): MerchantRefund {
    identifier(reason, 'refund failure reason');
    return this.#refundTransition(refundId, version, ['prepared','submitting','submitted','provider_confirmed','unknown'], 'failed', 'refund_failed', reason, 'failure_code = ?', [reason]);
  }

  reviewRefund(refundId: string, version: number, reason: string): MerchantRefund {
    identifier(reason, 'refund review reason');
    return this.#refundTransition(refundId, version, ['prepared','submitting','submitted','provider_confirmed','chain_confirmed','failed','unknown'], 'review_required', 'refund_review_required', reason, 'failure_code = ?', [reason]);
  }

  markRefundInternalSettled(refundId: string, version: number, settledAt: string): MerchantRefund {
    timestamp(settledAt, 'refund internal settlement');
    const current = this.#requireRefund(refundId, version);
    if (current.status !== 'chain_confirmed') throw new Error(`Cannot settle merchant refund from ${current.status}`);
    if (current.internalSettledAt) return current;
    return this.#refundTransition(refundId, version, ['chain_confirmed'], 'chain_confirmed', 'refund_internal_settled', null, 'internal_settled_at = ?, failure_code = NULL', [settledAt]);
  }

  eventsFor(aggregateType: 'order' | 'refund', aggregateId: string): MerchantReconciliationEvent[] {
    const rows = this.#database.prepare(`
      SELECT * FROM merchant_reconciliation_events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY created_at, rowid
    `).all(aggregateType, aggregateId) as unknown as EventRow[];
    return rows.map((row) => ({
      eventId: row.event_id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, kind: row.kind,
      fromStatus: row.from_status, toStatus: row.to_status, detail: row.detail, createdAt: row.created_at,
    }));
  }

  recordWebhookDelivery(input: { deliveryId: string; eventType: string; payloadSha256: string }): boolean {
    identifier(input.deliveryId, 'webhook delivery ID'); identifier(input.eventType, 'webhook event type');
    if (!digestPattern.test(input.payloadSha256)) throw new Error('Invalid webhook payload digest');
    const result = this.#database.prepare(`
      INSERT INTO merchant_webhook_deliveries (delivery_id, event_type, payload_sha256, received_at, processed_at)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(delivery_id) DO NOTHING
    `).run(input.deliveryId, input.eventType, input.payloadSha256, this.#now().toISOString());
    if (Number(result.changes) === 1) return true;
    const prior = this.#database.prepare('SELECT event_type, payload_sha256 FROM merchant_webhook_deliveries WHERE delivery_id = ?').get(input.deliveryId) as { event_type: string; payload_sha256: string };
    if (prior.event_type !== input.eventType || prior.payload_sha256 !== input.payloadSha256) throw new MerchantIdentityConflictError('Merchant webhook delivery identity conflicts');
    return false;
  }

  markWebhookProcessed(deliveryId: string): boolean {
    identifier(deliveryId, 'webhook delivery ID');
    const result = this.#database.prepare(`UPDATE merchant_webhook_deliveries SET processed_at = ? WHERE delivery_id = ? AND processed_at IS NULL`).run(this.#now().toISOString(), deliveryId);
    return Number(result.changes) === 1;
  }

  isWebhookProcessed(deliveryId: string): boolean {
    identifier(deliveryId, 'webhook delivery ID');
    const row = this.#database.prepare('SELECT processed_at FROM merchant_webhook_deliveries WHERE delivery_id = ?').get(deliveryId) as { processed_at: string | null } | undefined;
    return row?.processed_at !== null && row?.processed_at !== undefined;
  }

  #orderTransition(orderId: string, version: number, allowed: MerchantOrderStatus[], status: MerchantOrderStatus, kind: string, detail: string | null, mutation: string, values: Array<string | number | null>): MerchantOrder {
    return this.#transaction(() => {
      const current = this.#requireOrder(orderId, version);
      if (!allowed.includes(current.status)) throw new Error(`Cannot transition merchant order from ${current.status}`);
      const updatedAt = this.#now().toISOString();
      let result;
      try { result = this.#database.prepare(`UPDATE merchant_orders SET status = ?, ${mutation}, updated_at = ?, version = version + 1 WHERE order_id = ? AND version = ?`).run(status, ...values, updatedAt, orderId, version); }
      catch (error) { this.#translateUnique(error); }
      if (Number(result.changes) !== 1) throw new Error('Merchant order transition is stale');
      this.#event('order', orderId, kind, current.status, status, detail, updatedAt);
      return this.getOrder(orderId)!;
    });
  }

  #refundTransition(refundId: string, version: number, allowed: MerchantRefundStatus[], status: MerchantRefundStatus, kind: string, detail: string | null, mutation: string, values: Array<string | number | null>): MerchantRefund {
    return this.#transaction(() => {
      const current = this.#requireRefund(refundId, version);
      if (!allowed.includes(current.status)) throw new Error(`Cannot transition merchant refund from ${current.status}`);
      const updatedAt = this.#now().toISOString();
      let result;
      try { result = this.#database.prepare(`UPDATE merchant_refunds SET status = ?, ${mutation}, updated_at = ?, version = version + 1 WHERE refund_id = ? AND version = ?`).run(status, ...values, updatedAt, refundId, version); }
      catch (error) { this.#translateUnique(error); }
      if (Number(result.changes) !== 1) throw new Error('Merchant refund transition is stale');
      this.#event('refund', refundId, kind, current.status, status, detail, updatedAt);
      return this.getRefund(refundId)!;
    });
  }

  #requireOrder(orderId: string, version: number): MerchantOrder {
    const current = this.getOrder(orderId);
    if (!current) throw new Error('Merchant order was not found');
    if (current.version !== version) throw new Error('Merchant order transition is stale');
    return current;
  }

  #requireRefund(refundId: string, version: number): MerchantRefund {
    const current = this.getRefund(refundId);
    if (!current) throw new Error('Merchant refund was not found');
    if (current.version !== version) throw new Error('Merchant refund transition is stale');
    return current;
  }

  #event(aggregateType: 'order' | 'refund', aggregateId: string, kind: string, fromStatus: string | null, toStatus: string, detail: string | null, createdAt: string): void {
    this.#database.prepare(`
      INSERT INTO merchant_reconciliation_events (event_id, aggregate_type, aggregate_id, kind, from_status, to_status, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), aggregateType, aggregateId, kind, fromStatus, toStatus, detail, createdAt);
  }

  #quote(row: QuoteRow): ControlledMerchantQuote {
    return {
      quoteId: row.quote_id, providerRevision: row.provider_revision, merchantId: row.merchant_id,
      merchantName: row.merchant_name, merchantRecipient: row.merchant_recipient, productId: row.product_id,
      productName: row.product_name, amountMinor: row.amount_minor, taxMinor: row.tax_minor,
      shippingMinor: row.shipping_minor, feesMinor: row.fees_minor, expiresAt: row.expires_at, verifiedAt: row.verified_at,
    };
  }

  #order(row: OrderRow): MerchantOrder {
    return {
      orderId: row.order_id, requestId: row.request_id, ownerId: row.owner_id, petId: row.pet_id, quoteId: row.quote_id,
      merchantId: row.merchant_id, productId: row.product_id, merchantRecipient: row.merchant_recipient,
      petWalletAddress: row.pet_wallet_address, amountMinor: row.amount_minor, amountAtomic: row.amount_atomic,
      paymentTransactionHash: row.payment_transaction_hash as `0x${string}`, providerReference: row.provider_reference,
      providerOrderId: row.provider_order_id, status: row.status, failureCode: row.failure_code,
      internalSettledAt: row.internal_settled_at,
      createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
    };
  }

  #refund(row: RefundRow): MerchantRefund {
    return {
      refundId: row.refund_id, orderId: row.order_id, requestId: row.request_id, amountMinor: row.amount_minor,
      amountAtomic: row.amount_atomic, providerReference: row.provider_reference, providerRefundId: row.provider_refund_id,
      transactionHash: row.transaction_hash as `0x${string}` | null, blockHash: row.block_hash as `0x${string}` | null,
      blockNumber: row.block_number, logIndex: row.log_index, status: row.status, failureCode: row.failure_code,
      confirmedAt: row.confirmed_at, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
      internalSettledAt: row.internal_settled_at,
    };
  }

  #applyMigrations(): void {
    for (const migration of merchantReconciliationMigrations) {
      this.#transaction(() => {
        const checksum = createHash('sha256').update(migration.sql).digest('hex');
        const applied = this.#database.prepare('SELECT checksum FROM merchant_reconciliation_schema_migrations WHERE version = ?').get(migration.version) as { checksum: string } | undefined;
        if (applied) {
          if (applied.checksum !== checksum) throw new Error('Merchant reconciliation schema migration checksum does not match source');
          return;
        }
        this.#database.exec(migration.sql);
        this.#database.prepare('INSERT INTO merchant_reconciliation_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, checksum, this.#now().toISOString());
      });
    }
  }

  #upgradeMigrationLedger(): void {
    this.#transaction(() => {
      const columns = this.#database.prepare('PRAGMA table_info(merchant_reconciliation_schema_migrations)').all() as unknown as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === 'checksum')) {
        this.#database.exec('ALTER TABLE merchant_reconciliation_schema_migrations ADD COLUMN checksum TEXT');
      }
      const applied = this.#database.prepare('SELECT version, checksum FROM merchant_reconciliation_schema_migrations').all() as unknown as Array<{ version: number; checksum: string | null }>;
      for (const row of applied) {
        const migration = merchantReconciliationMigrations.find(({ version }) => version === row.version);
        if (!migration) throw new Error('Merchant reconciliation database was created by an unsupported newer schema');
        const checksum = createHash('sha256').update(migration.sql).digest('hex');
        if (row.checksum !== null && row.checksum !== checksum) throw new Error('Merchant reconciliation schema migration checksum does not match source');
        if (row.checksum === null) this.#database.prepare('UPDATE merchant_reconciliation_schema_migrations SET checksum = ? WHERE version = ?').run(checksum, row.version);
      }
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#database.exec('COMMIT'); return result; }
    catch (error) { this.#database.exec('ROLLBACK'); throw error; }
  }

  #translateUnique(error: unknown): never {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new MerchantIdentityConflictError();
    throw error;
  }

  #limit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid merchant reconciliation limit');
  }
}
