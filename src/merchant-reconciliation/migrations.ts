export const merchantReconciliationMigrations = [{
  version: 1,
  sql: `
    CREATE TABLE merchant_quotes (
      quote_id TEXT PRIMARY KEY,
      provider_revision TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      merchant_name TEXT NOT NULL,
      merchant_recipient TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      tax_minor INTEGER NOT NULL CHECK (tax_minor >= 0),
      shipping_minor INTEGER NOT NULL CHECK (shipping_minor >= 0),
      fees_minor INTEGER NOT NULL CHECK (fees_minor >= 0),
      expires_at TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      identity_sha256 TEXT NOT NULL
    );

    CREATE TABLE merchant_orders (
      order_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      pet_id TEXT NOT NULL,
      quote_id TEXT NOT NULL REFERENCES merchant_quotes(quote_id),
      merchant_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      merchant_recipient TEXT NOT NULL,
      pet_wallet_address TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      amount_atomic TEXT NOT NULL,
      payment_transaction_hash TEXT NOT NULL UNIQUE,
      provider_reference TEXT NOT NULL UNIQUE,
      provider_order_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('prepared','submitting','submitted','confirmed','fulfilled','unknown','cancel_pending','cancelled','failed','review_required')),
      failure_code TEXT,
      internal_settled_at TEXT,
      identity_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );

    CREATE TABLE merchant_refunds (
      refund_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES merchant_orders(order_id),
      request_id TEXT NOT NULL UNIQUE,
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      amount_atomic TEXT NOT NULL,
      provider_reference TEXT NOT NULL UNIQUE,
      provider_refund_id TEXT UNIQUE,
      transaction_hash TEXT UNIQUE,
      block_hash TEXT,
      block_number INTEGER,
      log_index INTEGER,
      status TEXT NOT NULL CHECK (status IN ('prepared','submitting','submitted','provider_confirmed','chain_confirmed','unknown','failed','review_required')),
      failure_code TEXT,
      confirmed_at TEXT,
      internal_settled_at TEXT,
      identity_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );

    CREATE TABLE merchant_reconciliation_events (
      event_id TEXT PRIMARY KEY,
      aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('order','refund')),
      aggregate_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX merchant_reconciliation_events_aggregate
      ON merchant_reconciliation_events(aggregate_type, aggregate_id, created_at);

    CREATE TABLE merchant_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT
    );
  `,
}, {
  version: 2,
  sql: `
    ALTER TABLE merchant_orders ADD COLUMN last_reconciled_at TEXT;
    ALTER TABLE merchant_refunds ADD COLUMN last_reconciled_at TEXT;
    CREATE INDEX merchant_orders_reconcile_fair_idx
      ON merchant_orders(last_reconciled_at, updated_at, order_id);
    CREATE INDEX merchant_refunds_reconcile_fair_idx
      ON merchant_refunds(last_reconciled_at, updated_at, refund_id);
  `,
}, {
  version: 3,
  sql: `
    CREATE TRIGGER merchant_quotes_valid_window_insert
    BEFORE INSERT ON merchant_quotes
    WHEN unixepoch(NEW.verified_at) IS NULL
      OR unixepoch(NEW.expires_at) IS NULL
      OR julianday(NEW.expires_at) <= julianday(NEW.verified_at)
    BEGIN
      SELECT RAISE(ABORT, 'invalid merchant quote window');
    END;

    CREATE TRIGGER merchant_quotes_valid_window_update
    BEFORE UPDATE OF verified_at, expires_at ON merchant_quotes
    WHEN unixepoch(NEW.verified_at) IS NULL
      OR unixepoch(NEW.expires_at) IS NULL
      OR julianday(NEW.expires_at) <= julianday(NEW.verified_at)
    BEGIN
      SELECT RAISE(ABORT, 'invalid merchant quote window');
    END;

    UPDATE merchant_quotes SET expires_at = expires_at;
  `,
}, {
  version: 4,
  sql: `
    -- Counts blind order creations: a create replayed against a provider that has no record of the
    -- reference, for a payment that already settled on chain. Each one can double-charge the pet,
    -- and a permanent rejection would otherwise repeat on every poll forever, so the reconciler
    -- bounds them and escalates to review instead.
    ALTER TABLE merchant_orders ADD COLUMN blind_create_attempts INTEGER NOT NULL DEFAULT 0
      CHECK (blind_create_attempts >= 0);
  `,
}, {
  version: 5,
  sql: `
    -- The refund twin of version 4. A blind refund create replays against a provider with no record
    -- of the reference, and each replay can issue a second refund for one payment, so it needs the
    -- same bound the order path has had. Without it the refund branch retried on every poll forever
    -- while the batch reported no failures.
    ALTER TABLE merchant_refunds ADD COLUMN blind_create_attempts INTEGER NOT NULL DEFAULT 0
      CHECK (blind_create_attempts >= 0);
  `,
}] as const;
