interface WalletControlMigration {
  version: number;
  sql: string;
}

export const walletControlMigrations: readonly WalletControlMigration[] = [{
  version: 1,
  sql: `
    CREATE TABLE wallet_control_bindings (
      binding_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      pet_id TEXT NOT NULL,
      app_wallet_id TEXT NOT NULL,
      privy_user_id TEXT NOT NULL,
      privy_embedded_wallet_id TEXT UNIQUE,
      smart_wallet_address TEXT UNIQUE,
      environment TEXT NOT NULL CHECK (environment = 'sandbox'),
      chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
      usdc_contract TEXT NOT NULL,
      smart_wallet_type TEXT NOT NULL CHECK (smart_wallet_type = 'safe'),
      owner_type TEXT NOT NULL CHECK (owner_type = 'privy_user'),
      agent_signer_id TEXT NOT NULL,
      agent_policy_id TEXT,
      expected_policy_digest TEXT NOT NULL,
      expected_policy_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'requested', 'provisioning', 'active', 'paused', 'recovery_pending',
        'recovered', 'revoked', 'drifted', 'failed'
      )),
      signer_status TEXT NOT NULL CHECK (signer_status IN ('pending', 'attached', 'revoked', 'drifted')),
      owner_escape_status TEXT NOT NULL CHECK (owner_escape_status IN ('unverified', 'verified', 'failed')),
      provisioning_version INTEGER NOT NULL CHECK (provisioning_version = 1),
      last_verified_at TEXT,
      escape_verified_at TEXT,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      UNIQUE (owner_id, pet_id),
      UNIQUE (owner_id, app_wallet_id)
    );
    CREATE INDEX wallet_control_bindings_status_idx ON wallet_control_bindings(status, updated_at);

    CREATE TABLE wallet_control_events (
      event_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES wallet_control_bindings(binding_id),
      kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX wallet_control_events_binding_idx ON wallet_control_events(binding_id, created_at, event_id);
  `,
}, {
  version: 2,
  sql: `
    DROP INDEX wallet_control_events_binding_idx;
    DROP INDEX wallet_control_bindings_status_idx;
    ALTER TABLE wallet_control_events RENAME TO wallet_control_events_v1;
    ALTER TABLE wallet_control_bindings RENAME TO wallet_control_bindings_v1;

    CREATE TABLE wallet_control_bindings (
      binding_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      pet_id TEXT NOT NULL,
      app_wallet_id TEXT NOT NULL,
      privy_user_id TEXT NOT NULL,
      privy_embedded_wallet_id TEXT UNIQUE,
      smart_wallet_address TEXT UNIQUE,
      environment TEXT NOT NULL CHECK (environment = 'sandbox'),
      chain_id INTEGER NOT NULL CHECK (chain_id = 84532),
      usdc_contract TEXT NOT NULL,
      smart_wallet_type TEXT NOT NULL CHECK (smart_wallet_type IN ('embedded_hd', 'safe')),
      owner_type TEXT NOT NULL CHECK (owner_type = 'privy_user'),
      agent_signer_id TEXT NOT NULL,
      agent_policy_id TEXT,
      expected_policy_digest TEXT NOT NULL,
      expected_policy_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'requested', 'provisioning', 'active', 'paused', 'recovery_pending',
        'recovered', 'revoked', 'drifted', 'failed'
      )),
      signer_status TEXT NOT NULL CHECK (signer_status IN ('pending', 'attached', 'revoked', 'drifted')),
      owner_escape_status TEXT NOT NULL CHECK (owner_escape_status IN ('unverified', 'verified', 'failed')),
      provisioning_version INTEGER NOT NULL CHECK (provisioning_version = 1),
      last_verified_at TEXT,
      escape_verified_at TEXT,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      UNIQUE (owner_id, pet_id),
      UNIQUE (owner_id, app_wallet_id)
    );
    INSERT INTO wallet_control_bindings SELECT * FROM wallet_control_bindings_v1;

    CREATE TABLE wallet_control_events (
      event_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES wallet_control_bindings(binding_id),
      kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO wallet_control_events SELECT * FROM wallet_control_events_v1;
    DROP TABLE wallet_control_events_v1;
    DROP TABLE wallet_control_bindings_v1;
    CREATE INDEX wallet_control_bindings_status_idx ON wallet_control_bindings(status, updated_at);
    CREATE INDEX wallet_control_events_binding_idx ON wallet_control_events(binding_id, created_at, event_id);
  `,
}];
