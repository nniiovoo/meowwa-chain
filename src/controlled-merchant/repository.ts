import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MerchantIdentityConflictError } from '../merchant-reconciliation/repository.js';
import type {
  ControlledMerchantOrderRecord,
  ControlledMerchantQuote,
  ControlledMerchantRefundRecord,
} from './types.js';
import { EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';

type QuoteRow = {
  quote_id: string; provider_revision: string; merchant_id: string; merchant_name: string; merchant_recipient: string;
  product_id: string; product_name: string; amount_minor: number; tax_minor: number; shipping_minor: number; fees_minor: number;
  expires_at: string; verified_at: string; identity_sha256: string;
};

type OrderRow = {
  provider_reference: string; provider_order_id: string; quote_id: string; request_id: string; amount_minor: number;
  payment_transaction_hash: string; pet_wallet_address: string; status: 'confirmed'; identity_sha256: string; created_at: string;
  payment_block_hash: string; payment_block_number: number; payment_log_index: number;
};

type RefundRow = {
  provider_reference: string; provider_refund_id: string; provider_order_id: string; request_id: string; amount_minor: number;
  recipient: string; amount_atomic: string; transaction_hash: string | null; serialized_transaction: string | null;
  status: 'pending' | 'confirmed' | 'failed'; reason: string | null; identity_sha256: string; created_at: string; updated_at: string;
};

function canonical(value: unknown): string { return JSON.stringify(value); }
export function controlledMerchantDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function quoteIdentity(input: ControlledMerchantQuote): Record<string, unknown> {
  return {
    quoteId: input.quoteId,
    providerRevision: input.providerRevision,
    merchantId: input.merchantId,
    merchantName: input.merchantName,
    merchantRecipient: input.merchantRecipient.toLowerCase(),
    productId: input.productId,
    productName: input.productName,
    amountMinor: input.amountMinor,
    taxMinor: input.taxMinor,
    shippingMinor: input.shippingMinor,
    feesMinor: input.feesMinor,
    expiresAt: input.expiresAt,
    verifiedAt: input.verifiedAt,
  };
}

function validateQuote(input: ControlledMerchantQuote): void {
  for (const value of [
    input.quoteId, input.providerRevision, input.merchantId, input.merchantName, input.productId, input.productName,
  ]) {
    if (!value.trim() || value.length > 255) throw new Error('Invalid controlled merchant quote identity');
  }
  if (!EVM_ADDRESS_PATTERN.test(input.merchantRecipient)) {
    throw new Error('Invalid controlled merchant quote recipient');
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
    ![input.taxMinor, input.shippingMinor, input.feesMinor].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid controlled merchant quote amount');
  }
  const verifiedAt = Date.parse(input.verifiedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
    throw new Error('Invalid controlled merchant quote timestamp');
  }
}

export function orderIdentity(input: {
  providerReference: string; quoteId: string; requestId: string; amountMinor: number; paymentTransactionHash: string;
}): Record<string, unknown> {
  return {
    providerReference: input.providerReference,
    quoteId: input.quoteId,
    requestId: input.requestId,
    amountMinor: input.amountMinor,
    paymentTransactionHash: input.paymentTransactionHash.toLowerCase(),
  };
}

export function refundIdentity(input: {
  providerReference: string; providerOrderId: string; requestId: string; amountMinor: number;
}): Record<string, unknown> {
  return {
    providerReference: input.providerReference,
    providerOrderId: input.providerOrderId,
    requestId: input.requestId,
    amountMinor: input.amountMinor,
  };
}

const controlledMerchantSchema = `
  CREATE TABLE IF NOT EXISTS controlled_merchant_quotes (
    quote_id TEXT PRIMARY KEY, provider_revision TEXT NOT NULL, merchant_id TEXT NOT NULL, merchant_name TEXT NOT NULL,
    merchant_recipient TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL, amount_minor INTEGER NOT NULL,
    tax_minor INTEGER NOT NULL, shipping_minor INTEGER NOT NULL, fees_minor INTEGER NOT NULL, expires_at TEXT NOT NULL,
    verified_at TEXT NOT NULL, identity_sha256 TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS controlled_merchant_quotes_product_expiry
    ON controlled_merchant_quotes(product_id, expires_at);
  CREATE TABLE IF NOT EXISTS controlled_merchant_orders (
    provider_reference TEXT PRIMARY KEY, provider_order_id TEXT NOT NULL UNIQUE, quote_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, amount_minor INTEGER NOT NULL, payment_transaction_hash TEXT NOT NULL UNIQUE,
    pet_wallet_address TEXT NOT NULL, payment_block_hash TEXT NOT NULL, payment_block_number INTEGER NOT NULL,
    payment_log_index INTEGER NOT NULL, status TEXT NOT NULL CHECK (status = 'confirmed'), identity_sha256 TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, FOREIGN KEY (quote_id) REFERENCES controlled_merchant_quotes(quote_id)
  );
  CREATE TABLE IF NOT EXISTS controlled_merchant_refunds (
    provider_reference TEXT PRIMARY KEY, provider_refund_id TEXT NOT NULL UNIQUE, provider_order_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE, amount_minor INTEGER NOT NULL, recipient TEXT NOT NULL, amount_atomic TEXT NOT NULL,
    transaction_hash TEXT UNIQUE, serialized_transaction TEXT, status TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed')),
    reason TEXT, identity_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (provider_order_id) REFERENCES controlled_merchant_orders(provider_order_id),
    CHECK ((transaction_hash IS NULL AND serialized_transaction IS NULL) OR
      (transaction_hash IS NOT NULL AND serialized_transaction IS NOT NULL))
  );
`;
const controlledMerchantSchemaChecksum = createHash('sha256').update(controlledMerchantSchema).digest('hex');

export class ControlledMerchantRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.#database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS controlled_merchant_schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    this.#applySchema();
  }

  close(): void { this.#database.close(); }

  appliedMigrationVersions(): number[] {
    return (this.#database.prepare('SELECT version FROM controlled_merchant_schema_migrations ORDER BY version').all() as unknown as Array<{ version: number }>)
      .map(({ version }) => version);
  }

  putQuote(input: ControlledMerchantQuote): ControlledMerchantQuote {
    validateQuote(input);
    const identitySha256 = controlledMerchantDigest(quoteIdentity(input));
    const existing = this.getQuote(input.quoteId);
    if (existing) {
      if (controlledMerchantDigest(quoteIdentity(existing)) !== identitySha256) throw new MerchantIdentityConflictError('Controlled merchant quote identity conflicts');
      return existing;
    }
    try {
      this.#database.prepare(`
        INSERT INTO controlled_merchant_quotes (
          quote_id, provider_revision, merchant_id, merchant_name, merchant_recipient, product_id, product_name,
          amount_minor, tax_minor, shipping_minor, fees_minor, expires_at, verified_at, identity_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.quoteId, input.providerRevision, input.merchantId, input.merchantName, input.merchantRecipient.toLowerCase(),
        input.productId, input.productName, input.amountMinor, input.taxMinor, input.shippingMinor, input.feesMinor,
        input.expiresAt, input.verifiedAt, identitySha256,
      );
    } catch (error) { this.#translateConstraint(error); }
    return this.getQuote(input.quoteId)!;
  }

  getQuote(quoteId: string): ControlledMerchantQuote | undefined {
    const row = this.#database.prepare('SELECT * FROM controlled_merchant_quotes WHERE quote_id = ?').get(quoteId) as QuoteRow | undefined;
    return row ? this.#quote(row) : undefined;
  }

  putOrder(input: Omit<ControlledMerchantOrderRecord, 'status' | 'identitySha256'>): ControlledMerchantOrderRecord {
    const identitySha256 = controlledMerchantDigest(orderIdentity(input));
    const existing = this.getOrder(input.providerReference);
    if (existing) {
      if (existing.identitySha256 !== identitySha256) throw new MerchantIdentityConflictError('Controlled merchant order identity conflicts');
      return existing;
    }
    try {
      this.#database.prepare(`
        INSERT INTO controlled_merchant_orders (
          provider_reference, provider_order_id, quote_id, request_id, amount_minor, payment_transaction_hash,
          pet_wallet_address, payment_block_hash, payment_block_number, payment_log_index, status, identity_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
      `).run(
        input.providerReference, input.providerOrderId, input.quoteId, input.requestId, input.amountMinor,
        input.paymentTransactionHash.toLowerCase(), input.petWalletAddress.toLowerCase(), input.paymentBlockHash.toLowerCase(),
        input.paymentBlockNumber, input.paymentLogIndex, identitySha256,
        this.#now().toISOString(),
      );
    } catch (error) { this.#translateConstraint(error); }
    return this.getOrder(input.providerReference)!;
  }

  getOrder(providerReference: string): ControlledMerchantOrderRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM controlled_merchant_orders WHERE provider_reference = ?').get(providerReference) as OrderRow | undefined;
    return row ? this.#order(row) : undefined;
  }

  getOrderByProviderId(providerOrderId: string): ControlledMerchantOrderRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM controlled_merchant_orders WHERE provider_order_id = ?').get(providerOrderId) as OrderRow | undefined;
    return row ? this.#order(row) : undefined;
  }

  prepareRefund(input: Omit<ControlledMerchantRefundRecord,
    'status' | 'reason' | 'transactionHash' | 'serializedTransaction' | 'identitySha256'>): ControlledMerchantRefundRecord {
    const identitySha256 = controlledMerchantDigest(refundIdentity(input));
    const existing = this.getRefund(input.providerReference);
    if (existing) {
      if (existing.identitySha256 !== identitySha256) throw new MerchantIdentityConflictError('Controlled merchant refund identity conflicts');
      return existing;
    }
    const now = this.#now().toISOString();
    try {
      this.#database.prepare(`
        INSERT INTO controlled_merchant_refunds (
          provider_reference, provider_refund_id, provider_order_id, request_id, amount_minor, recipient, amount_atomic,
          transaction_hash, serialized_transaction, status, reason, identity_sha256, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?, ?)
      `).run(
        input.providerReference, input.providerRefundId, input.providerOrderId, input.requestId, input.amountMinor,
        input.recipient.toLowerCase(), input.amountAtomic, identitySha256, now, now,
      );
    } catch (error) { this.#translateConstraint(error); }
    return this.getRefund(input.providerReference)!;
  }

  getRefund(providerReference: string): ControlledMerchantRefundRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM controlled_merchant_refunds WHERE provider_reference = ?').get(providerReference) as RefundRow | undefined;
    return row ? this.#refund(row) : undefined;
  }

  listSignedPendingRefunds(): ControlledMerchantRefundRecord[] {
    const rows = this.#database.prepare(`
      SELECT * FROM controlled_merchant_refunds
      WHERE status = 'pending' AND transaction_hash IS NOT NULL AND serialized_transaction IS NOT NULL
      ORDER BY created_at, provider_reference
    `).all() as unknown as RefundRow[];
    return rows.map((row) => this.#refund(row));
  }

  attachSignedRefund(input: {
    providerReference: string; transactionHash: `0x${string}`; serializedTransaction: `0x${string}`;
  }): ControlledMerchantRefundRecord {
    return this.#transaction(() => {
      const current = this.getRefund(input.providerReference);
      if (!current) throw new Error('Controlled merchant refund was not found');
      if (current.transactionHash || current.serializedTransaction) {
        if (current.transactionHash !== input.transactionHash.toLowerCase() || current.serializedTransaction !== input.serializedTransaction.toLowerCase()) {
          throw new MerchantIdentityConflictError('Controlled merchant signed refund identity conflicts');
        }
        return current;
      }
      this.#database.prepare(`
        UPDATE controlled_merchant_refunds SET transaction_hash = ?, serialized_transaction = ?, updated_at = ?
        WHERE provider_reference = ? AND transaction_hash IS NULL AND serialized_transaction IS NULL
      `).run(input.transactionHash.toLowerCase(), input.serializedTransaction.toLowerCase(), this.#now().toISOString(), input.providerReference);
      return this.getRefund(input.providerReference)!;
    });
  }

  finishRefund(providerReference: string, status: 'confirmed' | 'failed', reason?: string): ControlledMerchantRefundRecord {
    return this.#transaction(() => {
      const current = this.getRefund(providerReference);
      if (!current) throw new Error('Controlled merchant refund was not found');
      if (!current.transactionHash || !current.serializedTransaction) throw new Error('Unsigned controlled merchant refund cannot finish');
      if (current.status === status && (current.reason ?? null) === (reason ?? null)) return current;
      if (current.status !== 'pending') throw new MerchantIdentityConflictError('Controlled merchant refund terminal status conflicts');
      const updated = this.#database.prepare(`
        UPDATE controlled_merchant_refunds SET status = ?, reason = ?, updated_at = ?
        WHERE provider_reference = ? AND status = 'pending'
      `).run(status, reason ?? null, this.#now().toISOString(), providerReference);
      if (Number(updated.changes) !== 1) {
        throw new MerchantIdentityConflictError('Controlled merchant refund terminal status conflicts');
      }
      return this.getRefund(providerReference)!;
    });
  }

  #quote(row: QuoteRow): ControlledMerchantQuote {
    return {
      quoteId: row.quote_id, providerRevision: row.provider_revision, merchantId: row.merchant_id,
      merchantName: row.merchant_name, merchantRecipient: row.merchant_recipient, productId: row.product_id,
      productName: row.product_name, amountMinor: row.amount_minor, taxMinor: row.tax_minor,
      shippingMinor: row.shipping_minor, feesMinor: row.fees_minor, expiresAt: row.expires_at, verifiedAt: row.verified_at,
    };
  }

  #order(row: OrderRow): ControlledMerchantOrderRecord {
    return {
      providerReference: row.provider_reference, providerOrderId: row.provider_order_id, quoteId: row.quote_id,
      requestId: row.request_id, amountMinor: row.amount_minor,
      paymentTransactionHash: row.payment_transaction_hash as `0x${string}`,
      petWalletAddress: row.pet_wallet_address as `0x${string}`, status: row.status,
      paymentBlockHash: row.payment_block_hash as `0x${string}`,
      paymentBlockNumber: row.payment_block_number,
      paymentLogIndex: row.payment_log_index,
      identitySha256: row.identity_sha256,
    };
  }

  #refund(row: RefundRow): ControlledMerchantRefundRecord {
    return {
      providerReference: row.provider_reference, providerRefundId: row.provider_refund_id,
      providerOrderId: row.provider_order_id, requestId: row.request_id, amountMinor: row.amount_minor,
      recipient: row.recipient as `0x${string}`, amountAtomic: row.amount_atomic,
      ...(row.transaction_hash ? { transactionHash: row.transaction_hash as `0x${string}` } : {}),
      ...(row.serialized_transaction ? { serializedTransaction: row.serialized_transaction as `0x${string}` } : {}),
      status: row.status, ...(row.reason ? { reason: row.reason } : {}), identitySha256: row.identity_sha256,
    };
  }

  #applySchema(): void {
    this.#transaction(() => {
      const applied = this.#database.prepare(
        'SELECT version, checksum FROM controlled_merchant_schema_migrations ORDER BY version',
      ).all() as unknown as Array<{ version: number; checksum: string }>;
      if (applied.some(({ version }) => version !== 1)) {
        throw new Error('Controlled merchant database was created by an unsupported newer schema');
      }
      const existing = this.#database.prepare(
        'SELECT checksum FROM controlled_merchant_schema_migrations WHERE version = 1',
      ).get() as { checksum: string } | undefined;
      if (existing) {
        if (existing.checksum !== controlledMerchantSchemaChecksum) {
          throw new Error('Controlled merchant schema migration checksum does not match source');
        }
        return;
      }
      this.#database.exec(controlledMerchantSchema);
      this.#database.prepare(`
        INSERT INTO controlled_merchant_schema_migrations (version, checksum, applied_at) VALUES (1, ?, ?)
      `).run(controlledMerchantSchemaChecksum, this.#now().toISOString());
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#database.exec('COMMIT'); return result; }
    catch (error) { this.#database.exec('ROLLBACK'); throw error; }
  }

  #translateConstraint(error: unknown): never {
    if (error instanceof Error && /constraint|unique/i.test(error.message)) {
      throw new MerchantIdentityConflictError('Controlled merchant durable identity conflicts');
    }
    throw error;
  }
}
