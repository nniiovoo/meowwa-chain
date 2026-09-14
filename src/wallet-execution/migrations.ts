interface WalletExecutionMigration {
  version: number;
  sql: string;
}

export const walletExecutionMigrations: readonly WalletExecutionMigration[] = [{
  version: 1,
  sql: `
    CREATE TABLE wallet_execution_submissions (
      submission_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      pet_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      provider_wallet_id TEXT NOT NULL,
      intent_hash TEXT NOT NULL UNIQUE,
      reference_id TEXT NOT NULL UNIQUE,
      chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
      contract TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      value_atomic TEXT NOT NULL CHECK (value_atomic = '0'),
      calldata TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'prepared', 'submitting', 'submitted', 'provider_confirmed', 'confirmed',
        'unknown', 'failed', 'review_required'
      )),
      provider_transaction_id TEXT UNIQUE,
      user_operation_hash TEXT UNIQUE,
      transaction_hash TEXT UNIQUE,
      block_hash TEXT,
      block_number INTEGER CHECK (block_number IS NULL OR block_number >= 0),
      log_index INTEGER CHECK (log_index IS NULL OR log_index >= 0),
      failure_code TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      UNIQUE (chain_id, transaction_hash, log_index)
    );
    CREATE INDEX wallet_execution_status_idx ON wallet_execution_submissions(status, updated_at);
    CREATE INDEX wallet_execution_owner_idx ON wallet_execution_submissions(owner_id, created_at);

    CREATE TABLE wallet_execution_events (
      event_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES wallet_execution_submissions(submission_id),
      kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX wallet_execution_events_submission_idx
      ON wallet_execution_events(submission_id, created_at, event_id);

    CREATE TABLE wallet_execution_webhook_deliveries (
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
    CREATE TABLE wallet_receive_scan_cursors (
      chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
      contract_address TEXT NOT NULL,
      next_block INTEGER NOT NULL CHECK (next_block >= 0),
      checkpoint_block INTEGER,
      checkpoint_hash TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, contract_address),
      CHECK ((checkpoint_block IS NULL AND checkpoint_hash IS NULL) OR
        (checkpoint_block IS NOT NULL AND checkpoint_block >= 0 AND checkpoint_hash IS NOT NULL))
    );
  `,
}, {
  version: 3,
  sql: `
    ALTER TABLE wallet_execution_submissions ADD COLUMN application_settled_at TEXT;
    ALTER TABLE wallet_execution_submissions ADD COLUMN last_reconciled_at TEXT;
    CREATE INDEX wallet_execution_reconcile_fair_idx
      ON wallet_execution_submissions(last_reconciled_at, updated_at, submission_id);
  `,
}, {
  version: 4,
  sql: `
    ALTER TABLE wallet_execution_submissions ADD COLUMN review_required_at TEXT;
    ALTER TABLE wallet_execution_submissions ADD COLUMN review_reason TEXT;
    CREATE INDEX wallet_execution_review_idx
      ON wallet_execution_submissions(review_required_at, updated_at, submission_id);
  `,
}, {
  version: 5,
  sql: `
    ALTER TABLE wallet_execution_submissions ADD COLUMN reconcile_locked_until INTEGER;
    ALTER TABLE wallet_execution_submissions ADD COLUMN reconcile_locked_by TEXT;
    ALTER TABLE wallet_execution_submissions ADD COLUMN reconcile_fence_token INTEGER NOT NULL DEFAULT 0
      CHECK (reconcile_fence_token >= 0);
    CREATE INDEX wallet_execution_reconcile_claim_idx
      ON wallet_execution_submissions(reconcile_locked_until, last_reconciled_at, updated_at, submission_id);
  `,
}, {
  version: 6,
  sql: `
    -- Counts blind re-submissions: a replay of a transfer whose provider outcome is unknown and
    -- which therefore has no provider transaction id to poll. Each one risks a duplicate payment,
    -- so the reconciler bounds them instead of retrying forever.
    ALTER TABLE wallet_execution_submissions ADD COLUMN blind_submit_attempts INTEGER NOT NULL DEFAULT 0
      CHECK (blind_submit_attempts >= 0);
  `,
}];
