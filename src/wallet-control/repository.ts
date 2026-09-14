import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, policyDigest, type PrivyAgentSignerPolicy } from './policy.js';
import { walletControlMigrations } from './migrations.js';
import type { AgentSignerStatus, OwnerEscapeStatus, WalletControlBinding, WalletControlEvent, WalletControlStatus } from './types.js';
import { EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';

type BindingRow = {
  binding_id: string; owner_id: string; pet_id: string; app_wallet_id: string; privy_user_id: string;
  privy_embedded_wallet_id: string | null; smart_wallet_address: string | null; environment: 'sandbox';
  chain_id: number; usdc_contract: string; smart_wallet_type: 'embedded_hd' | 'safe'; owner_type: 'privy_user';
  agent_signer_id: string; agent_policy_id: string | null; expected_policy_digest: string; expected_policy_json: string;
  status: WalletControlStatus; signer_status: AgentSignerStatus; owner_escape_status: OwnerEscapeStatus;
  provisioning_version: number; last_verified_at: string | null; escape_verified_at: string | null;
  failure_code: string | null; created_at: string; updated_at: string; version: number;
};

type EventRow = {
  event_id: string; binding_id: string; kind: string; from_status: WalletControlStatus | null;
  to_status: WalletControlStatus; detail: string | null; created_at: string;
};

export class WalletControlConflictError extends Error {
  constructor(message = 'Pet already has a different wallet control binding') {
    super(message);
    this.name = 'WalletControlConflictError';
  }
}

function assertIdentifier(value: string, name: string): void {
  if (!value.trim() || value.length > 255) throw new Error(`Invalid ${name}`);
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid policy digest');
}

function normalizeAddress(value: string): string {
  if (!EVM_ADDRESS_PATTERN.test(value)) throw new Error('Invalid smart wallet address');
  return value.toLowerCase();
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp');
}

export class WalletControlRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.#database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS wallet_control_schema_migrations (
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
    const rows = this.#database.prepare('SELECT version FROM wallet_control_schema_migrations ORDER BY version').all() as unknown as Array<{ version: number }>;
    return rows.map((row) => row.version);
  }

  beginProvisioning(input: {
    bindingId: string;
    ownerId: string;
    petId: string;
    appWalletId: string;
    privyUserId: string;
    agentSignerId: string;
    expectedPolicyDigest: string;
    expectedPolicyJson: string;
  }): WalletControlBinding {
    for (const [name, value] of Object.entries({
      bindingId: input.bindingId, ownerId: input.ownerId, petId: input.petId, appWalletId: input.appWalletId,
      privyUserId: input.privyUserId, agentSignerId: input.agentSignerId,
    })) assertIdentifier(value, name);
    assertDigest(input.expectedPolicyDigest);
    let expectedPolicy: unknown;
    try { expectedPolicy = JSON.parse(input.expectedPolicyJson); } catch { throw new Error('Invalid expected policy JSON'); }
    if (!expectedPolicy || typeof expectedPolicy !== 'object' || policyDigest(expectedPolicy as PrivyAgentSignerPolicy) !== input.expectedPolicyDigest) {
      throw new Error('Expected policy JSON does not match its digest');
    }
    return this.#transaction(() => {
      const existing = this.#getByOwnerPet(input.ownerId, input.petId);
      if (existing) {
        const sameIdentity = existing.bindingId === input.bindingId && existing.appWalletId === input.appWalletId &&
          existing.privyUserId === input.privyUserId && existing.agentSignerId === input.agentSignerId;
        const samePolicy = existing.expectedPolicyDigest === input.expectedPolicyDigest &&
          existing.expectedPolicyJson === input.expectedPolicyJson;
        // A failed binding may be handed back with a changed policy so the service can verify the
        // abandoned provider policy is orphaned before adopting the new one (adoptReprovisionPolicy).
        if (!sameIdentity || (!samePolicy && existing.status !== 'failed')) throw new WalletControlConflictError();
        return existing;
      }
      const timestamp = this.#now().toISOString();
      try {
        this.#database.prepare(`
          INSERT INTO wallet_control_bindings (
            binding_id, owner_id, pet_id, app_wallet_id, privy_user_id,
            privy_embedded_wallet_id, smart_wallet_address, environment, chain_id, usdc_contract,
            smart_wallet_type, owner_type, agent_signer_id, agent_policy_id, expected_policy_digest, expected_policy_json,
            status, signer_status, owner_escape_status, provisioning_version,
            last_verified_at, escape_verified_at, failure_code, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'sandbox', ?, ?, 'embedded_hd', 'privy_user', ?, NULL, ?, ?,
            'requested', 'pending', 'unverified', 1, NULL, NULL, NULL, ?, ?, 1)
        `).run(
          input.bindingId, input.ownerId, input.petId, input.appWalletId, input.privyUserId,
          BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, input.agentSignerId, input.expectedPolicyDigest, input.expectedPolicyJson,
          timestamp, timestamp,
        );
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new WalletControlConflictError();
        throw error;
      }
      this.#insertEvent(input.bindingId, 'provisioning_requested', null, 'requested', null, timestamp);
      return this.getBindingById(input.bindingId)!;
    });
  }

  setPolicy(bindingId: string, expectedVersion: number, agentPolicyId: string): WalletControlBinding {
    assertIdentifier(agentPolicyId, 'agent policy ID');
    const current = this.#requireVersion(bindingId, expectedVersion);
    if (current.agentPolicyId) {
      throw new WalletControlConflictError('Wallet control policy is already bound');
    }
    return this.#transition(bindingId, expectedVersion, ['requested', 'failed'], 'provisioning', 'policy_created', agentPolicyId, (timestamp) => ({
      sql: 'agent_policy_id = ?, signer_status = ?, failure_code = NULL, updated_at = ?, version = version + 1',
      values: [agentPolicyId, 'pending', timestamp],
    }));
  }

  adoptReprovisionPolicy(bindingId: string, expectedVersion: number, input: {
    expectedPolicyDigest: string;
    expectedPolicyJson: string;
  }): WalletControlBinding {
    assertDigest(input.expectedPolicyDigest);
    let expectedPolicy: unknown;
    try { expectedPolicy = JSON.parse(input.expectedPolicyJson); } catch { throw new Error('Invalid expected policy JSON'); }
    if (!expectedPolicy || typeof expectedPolicy !== 'object' ||
      policyDigest(expectedPolicy as PrivyAgentSignerPolicy) !== input.expectedPolicyDigest) {
      throw new Error('Expected policy JSON does not match its digest');
    }
    const current = this.#requireVersion(bindingId, expectedVersion);
    return this.#transition(bindingId, expectedVersion, ['failed'], 'requested', 'reprovision_policy_adopted',
      `${current.agentPolicyId ?? ''}:${current.expectedPolicyDigest}:${input.expectedPolicyDigest}`, (timestamp) => ({
        sql: `agent_policy_id = NULL, expected_policy_digest = ?, expected_policy_json = ?,
          signer_status = 'pending', failure_code = NULL, updated_at = ?, version = version + 1`,
        values: [input.expectedPolicyDigest, input.expectedPolicyJson, timestamp],
      }));
  }

  resumeProvisioning(bindingId: string, expectedVersion: number): WalletControlBinding {
    const current = this.#requireVersion(bindingId, expectedVersion);
    if (!current.agentPolicyId) throw new Error('Wallet control policy is missing');
    return this.#transition(bindingId, expectedVersion, ['failed'], 'provisioning', 'provisioning_resumed', null, (timestamp) => ({
      sql: 'failure_code = NULL, updated_at = ?, version = version + 1', values: [timestamp],
    }));
  }

  activate(bindingId: string, expectedVersion: number, input: {
    privyEmbeddedWalletId: string;
    smartWalletAddress: string;
    verifiedAt: string;
  }): WalletControlBinding {
    assertIdentifier(input.privyEmbeddedWalletId, 'Privy embedded wallet ID');
    const smartWalletAddress = normalizeAddress(input.smartWalletAddress);
    assertTimestamp(input.verifiedAt);
    const existing = this.getBindingById(bindingId);
    if (existing?.status === 'active') throw new Error('Wallet control binding is already active');
    if (!existing?.agentPolicyId) throw new Error('Wallet control policy is missing');
    return this.#transition(bindingId, expectedVersion, ['provisioning'], 'active', 'binding_activated', null, (timestamp) => {
      const duplicate = this.#database.prepare(`
        SELECT binding_id FROM wallet_control_bindings
        WHERE lower(smart_wallet_address) = lower(?) AND binding_id <> ?
      `).get(smartWalletAddress, bindingId) as { binding_id: string } | undefined;
      if (duplicate) throw new WalletControlConflictError('External wallet identity is already bound');
      return {
        sql: `privy_embedded_wallet_id = ?, smart_wallet_address = ?, signer_status = 'attached',
          last_verified_at = ?, failure_code = NULL, updated_at = ?, version = version + 1`,
        values: [input.privyEmbeddedWalletId, smartWalletAddress, input.verifiedAt, timestamp],
      };
    });
  }

  recordVerified(bindingId: string, expectedVersion: number, verifiedAt: string): WalletControlBinding {
    assertTimestamp(verifiedAt);
    return this.#transaction(() => {
      const current = this.#requireVersion(bindingId, expectedVersion);
      if (!['active', 'paused', 'recovered'].includes(current.status)) throw new Error(`Cannot verify wallet control binding from ${current.status}`);
      const timestamp = this.#now().toISOString();
      const result = this.#database.prepare(`
        UPDATE wallet_control_bindings SET last_verified_at = ?, failure_code = NULL, updated_at = ?, version = version + 1
        WHERE binding_id = ? AND version = ?
      `).run(verifiedAt, timestamp, bindingId, expectedVersion);
      if (Number(result.changes) !== 1) throw new Error('Wallet control binding transition is stale');
      this.#insertEvent(bindingId, 'binding_verified', current.status, current.status, null, timestamp);
      return this.getBindingById(bindingId)!;
    });
  }

  recordPolicyRotation(bindingId: string, expectedVersion: number, input: {
    agentPolicyId: string;
    expectedPolicyDigest: string;
    expectedPolicyJson: string;
    verifiedAt: string;
  }): WalletControlBinding {
    assertIdentifier(input.agentPolicyId, 'agent policy ID');
    assertDigest(input.expectedPolicyDigest);
    assertTimestamp(input.verifiedAt);
    let expectedPolicy: unknown;
    try { expectedPolicy = JSON.parse(input.expectedPolicyJson); } catch { throw new Error('Invalid expected policy JSON'); }
    if (!expectedPolicy || typeof expectedPolicy !== 'object' ||
      policyDigest(expectedPolicy as PrivyAgentSignerPolicy) !== input.expectedPolicyDigest) {
      throw new Error('Expected policy JSON does not match its digest');
    }
    return this.#transaction(() => {
      const current = this.#requireVersion(bindingId, expectedVersion);
      if (!['active', 'paused', 'recovered'].includes(current.status) || current.signerStatus !== 'attached' || !current.agentPolicyId) {
        throw new Error(`Cannot rotate wallet control policy from ${current.status}`);
      }
      const timestamp = this.#now().toISOString();
      const result = this.#database.prepare(`
        UPDATE wallet_control_bindings SET agent_policy_id = ?, expected_policy_digest = ?, expected_policy_json = ?,
          last_verified_at = ?, failure_code = NULL, updated_at = ?, version = version + 1
        WHERE binding_id = ? AND version = ?
      `).run(
        input.agentPolicyId, input.expectedPolicyDigest, input.expectedPolicyJson,
        input.verifiedAt, timestamp, bindingId, expectedVersion,
      );
      if (Number(result.changes) !== 1) throw new Error('Wallet control binding transition is stale');
      this.#insertEvent(bindingId, 'agent_policy_rotated', current.status, current.status,
        `${current.expectedPolicyDigest}:${input.expectedPolicyDigest}`, timestamp);
      return this.getBindingById(bindingId)!;
    });
  }

  pause(bindingId: string, expectedVersion: number, reason: string): WalletControlBinding {
    assertIdentifier(reason, 'pause reason');
    return this.#transition(bindingId, expectedVersion, ['active', 'recovered'], 'paused', 'binding_paused', reason, (timestamp) => ({
      sql: 'updated_at = ?, version = version + 1', values: [timestamp],
    }));
  }

  /**
   * The exit from `pause`. Nothing used to leave 'paused' except markDrifted and recordAgentRevoked,
   * and both of those only take capability away, so an ordinary owner pause -- disclosed as "Pause
   * all MeowWa spending from <pet>'s wallet", i.e. something undoable -- was permanent, and every
   * route that needs a live binding (verify, provision, policy rotation) answered 409 for that pet
   * forever. Resuming lands on 'active': the event log keeps the provenance a 'recovered' binding
   * had, and nothing downstream distinguishes the two.
   */
  resume(bindingId: string, expectedVersion: number): WalletControlBinding {
    return this.#transition(bindingId, expectedVersion, ['paused'], 'active', 'binding_resumed', null, (timestamp) => ({
      sql: 'updated_at = ?, version = version + 1', values: [timestamp],
    }));
  }

  markDrifted(bindingId: string, expectedVersion: number, reason: string): WalletControlBinding {
    assertIdentifier(reason, 'drift reason');
    return this.#transition(bindingId, expectedVersion, ['requested', 'provisioning', 'active', 'paused', 'recovered', 'failed'], 'drifted', 'binding_drifted', reason, (timestamp) => ({
      sql: `signer_status = 'drifted', failure_code = ?, updated_at = ?, version = version + 1`, values: [reason, timestamp],
    }));
  }

  markFailed(bindingId: string, expectedVersion: number, reason: string): WalletControlBinding {
    assertIdentifier(reason, 'failure reason');
    return this.#transition(bindingId, expectedVersion, ['requested', 'provisioning'], 'failed', 'provisioning_failed', reason, (timestamp) => ({
      sql: 'failure_code = ?, updated_at = ?, version = version + 1', values: [reason, timestamp],
    }));
  }

  /**
   * Releases a binding whose provisioning process died before it could record an outcome.
   * `markFailed` only ever runs in the in-process catch handler, so a crash, an OOM kill or a pod
   * eviction leaves the row in 'requested' or 'provisioning' forever -- and the reprovision escape
   * hatch only relaxes the policy-conflict rule for 'failed'. That combination made the owner's
   * wallet permanently unprovisionable with no route back.
   *
   * The staleness window is what keeps this from rug-pulling a genuinely in-flight attempt: the
   * in-process guard is per-process, so a second replica cannot see it, and only elapsed time can.
   */
  releaseStalledProvisioning(bindingId: string, staleAfterMs: number): WalletControlBinding | undefined {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) throw new Error('Stale provisioning window is invalid');
    const current = this.getBindingById(bindingId);
    if (!current || (current.status !== 'requested' && current.status !== 'provisioning')) return undefined;
    if (this.#now().getTime() - Date.parse(current.updatedAt) < staleAfterMs) return undefined;
    return this.markFailed(current.bindingId, current.version, 'provisioning_abandoned');
  }

  /**
   * The exit from a drift that happened before this binding ever had a wallet to drift from.
   *
   * `markDrifted` is reachable from 'requested' and 'provisioning' -- a provider that answers with a
   * policy it owns itself, or an agent signer Privy has not finished attaching yet -- and the only
   * edge out of 'drifted' is `recordAgentRevoked`, which needs a wallet address the owner's client
   * can sign against. A binding that never activated has none, so every owner route answered 409 or
   * 502 for that pet forever: /provision 409 drifted, /verify 409 drifted, /pause and /resume 409
   * drifted, /revoke-agent 502 incomplete. The pet's app wallet then keeps the never-provisioned
   * sentinel (no address, paused, signerRevoked, agent SUSPENDED) with nothing left that can clear
   * it -- the repair route was itself one provider hiccup away from being permanently unavailable.
   *
   * Landing on 'failed' is what makes this safe rather than a restore: 'failed' is the state the
   * reprovision machinery above already understands, and the only way out of it is a fresh provider
   * inspection that passes every drift check. Nothing is re-enabled on the strength of a local edit.
   *
   * The identity columns are the guard. `activate` is the only writer of `privy_embedded_wallet_id`
   * and `smart_wallet_address`, so a binding carrying either was live once and its drift stays
   * closed behind the owner-authorized revoke/recover pair. The drift reason is kept as the failure
   * code so the panel still says why the last attempt stopped until a new attempt replaces it.
   */
  releaseUnprovisionedDrift(bindingId: string): WalletControlBinding | undefined {
    const current = this.getBindingById(bindingId);
    if (!current || current.status !== 'drifted') return undefined;
    if (current.privyEmbeddedWalletId !== null || current.smartWalletAddress !== null) return undefined;
    return this.#transition(bindingId, current.version, ['drifted'], 'failed', 'drift_released', current.failureCode, (timestamp) => ({
      sql: `signer_status = 'pending', updated_at = ?, version = version + 1`, values: [timestamp],
    }));
  }

  recordAgentRevoked(bindingId: string, expectedVersion: number): WalletControlBinding {
    return this.#transition(bindingId, expectedVersion, ['active', 'paused', 'recovery_pending', 'recovered', 'drifted'], 'revoked', 'agent_signer_revoked', null, (timestamp) => ({
      sql: `signer_status = 'revoked', failure_code = NULL, updated_at = ?, version = version + 1`, values: [timestamp],
    }));
  }

  recordAgentRecovered(bindingId: string, expectedVersion: number, verifiedAt: string): WalletControlBinding {
    assertTimestamp(verifiedAt);
    return this.#transition(bindingId, expectedVersion, ['revoked'], 'recovered', 'agent_signer_recovered', null, (timestamp) => ({
      sql: `signer_status = 'attached', last_verified_at = ?, failure_code = NULL,
        updated_at = ?, version = version + 1`,
      values: [verifiedAt, timestamp],
    }));
  }

  getBinding(ownerId: string, petId: string): WalletControlBinding | undefined {
    return this.#getByOwnerPet(ownerId, petId);
  }

  getBindingById(bindingId: string): WalletControlBinding | undefined {
    const row = this.#database.prepare('SELECT * FROM wallet_control_bindings WHERE binding_id = ?').get(bindingId) as BindingRow | undefined;
    return row ? this.#toBinding(row) : undefined;
  }

  listBindings(ownerId: string): WalletControlBinding[] {
    const rows = this.#database.prepare('SELECT * FROM wallet_control_bindings WHERE owner_id = ? ORDER BY pet_id').all(ownerId) as unknown as BindingRow[];
    return rows.map((row) => this.#toBinding(row));
  }

  listEvents(bindingId: string): WalletControlEvent[] {
    const rows = this.#database.prepare('SELECT * FROM wallet_control_events WHERE binding_id = ? ORDER BY created_at, rowid').all(bindingId) as unknown as EventRow[];
    return rows.map((row) => ({
      eventId: row.event_id, bindingId: row.binding_id, kind: row.kind, fromStatus: row.from_status,
      toStatus: row.to_status, detail: row.detail, createdAt: row.created_at,
    }));
  }

  #getByOwnerPet(ownerId: string, petId: string): WalletControlBinding | undefined {
    const row = this.#database.prepare('SELECT * FROM wallet_control_bindings WHERE owner_id = ? AND pet_id = ?').get(ownerId, petId) as BindingRow | undefined;
    return row ? this.#toBinding(row) : undefined;
  }

  #requireVersion(bindingId: string, expectedVersion: number): WalletControlBinding {
    const current = this.getBindingById(bindingId);
    if (!current) throw new Error('Wallet control binding was not found');
    if (current.version !== expectedVersion) throw new Error('Wallet control binding transition is stale');
    return current;
  }

  #transition(
    bindingId: string,
    expectedVersion: number,
    allowedFrom: WalletControlStatus[],
    toStatus: WalletControlStatus,
    kind: string,
    detail: string | null,
    update: (timestamp: string) => { sql: string; values: Array<string | number | null> },
  ): WalletControlBinding {
    return this.#transaction(() => {
      const current = this.#requireVersion(bindingId, expectedVersion);
      if (!allowedFrom.includes(current.status)) throw new Error(`Cannot transition wallet control binding from ${current.status}`);
      const timestamp = this.#now().toISOString();
      const mutation = update(timestamp);
      let result;
      try {
        result = this.#database.prepare(`
          UPDATE wallet_control_bindings SET status = ?, ${mutation.sql}
          WHERE binding_id = ? AND version = ?
        `).run(toStatus, ...mutation.values, bindingId, expectedVersion);
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new WalletControlConflictError('External wallet identity is already bound');
        throw error;
      }
      if (Number(result.changes) !== 1) throw new Error('Wallet control binding transition is stale');
      this.#insertEvent(bindingId, kind, current.status, toStatus, detail, timestamp);
      return this.getBindingById(bindingId)!;
    });
  }

  #insertEvent(
    bindingId: string,
    kind: string,
    fromStatus: WalletControlStatus | null,
    toStatus: WalletControlStatus,
    detail: string | null,
    createdAt: string,
  ): void {
    this.#database.prepare(`
      INSERT INTO wallet_control_events (event_id, binding_id, kind, from_status, to_status, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), bindingId, kind, fromStatus, toStatus, detail, createdAt);
  }

  #toBinding(row: BindingRow): WalletControlBinding {
    let storedPolicy: unknown;
    try { storedPolicy = JSON.parse(row.expected_policy_json); } catch { throw new Error('Wallet control database contains an invalid policy'); }
    if (row.chain_id !== BASE_SEPOLIA_CHAIN_ID || row.usdc_contract.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase() ||
      row.environment !== 'sandbox' || !['embedded_hd', 'safe'].includes(row.smart_wallet_type) || row.owner_type !== 'privy_user' || row.provisioning_version !== 1 ||
      !storedPolicy || typeof storedPolicy !== 'object' || policyDigest(storedPolicy as PrivyAgentSignerPolicy) !== row.expected_policy_digest) {
      throw new Error('Wallet control database contains an unsafe binding');
    }
    return {
      bindingId: row.binding_id, ownerId: row.owner_id, petId: row.pet_id, appWalletId: row.app_wallet_id,
      privyUserId: row.privy_user_id, privyEmbeddedWalletId: row.privy_embedded_wallet_id,
      smartWalletAddress: row.smart_wallet_address, environment: row.environment, chainId: BASE_SEPOLIA_CHAIN_ID,
      usdcContract: BASE_SEPOLIA_USDC, smartWalletType: row.smart_wallet_type, ownerType: row.owner_type,
      agentSignerId: row.agent_signer_id, agentPolicyId: row.agent_policy_id,
      expectedPolicyDigest: row.expected_policy_digest, expectedPolicyJson: row.expected_policy_json,
      status: row.status, signerStatus: row.signer_status,
      ownerEscapeStatus: row.owner_escape_status, provisioningVersion: 1, lastVerifiedAt: row.last_verified_at,
      escapeVerifiedAt: row.escape_verified_at, failureCode: row.failure_code, createdAt: row.created_at,
      updatedAt: row.updated_at, version: row.version,
    };
  }

  #applyMigrations(): void {
    for (const migration of walletControlMigrations) {
      this.#transaction(() => {
        const checksum = createHash('sha256').update(migration.sql).digest('hex');
        const applied = this.#database.prepare(
          'SELECT checksum FROM wallet_control_schema_migrations WHERE version = ?',
        ).get(migration.version) as { checksum: string } | undefined;
        if (applied) {
          if (applied.checksum !== checksum) throw new Error('Wallet control schema migration checksum does not match source');
          return;
        }
        this.#database.exec(migration.sql);
        this.#database.prepare(
          'INSERT INTO wallet_control_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, checksum, this.#now().toISOString());
      });
    }
  }

  #upgradeMigrationLedger(): void {
    this.#transaction(() => {
      const columns = this.#database.prepare('PRAGMA table_info(wallet_control_schema_migrations)').all() as
        unknown as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === 'checksum')) {
        this.#database.exec('ALTER TABLE wallet_control_schema_migrations ADD COLUMN checksum TEXT');
      }
      const applied = this.#database.prepare(
        'SELECT version, checksum FROM wallet_control_schema_migrations',
      ).all() as unknown as Array<{ version: number; checksum: string | null }>;
      for (const row of applied) {
        const migration = walletControlMigrations.find(({ version }) => version === row.version);
        if (!migration) throw new Error('Wallet control database was created by an unsupported newer schema');
        const checksum = createHash('sha256').update(migration.sql).digest('hex');
        if (row.checksum !== null && row.checksum !== checksum) {
          throw new Error('Wallet control schema migration checksum does not match source');
        }
        if (row.checksum === null) {
          this.#database.prepare('UPDATE wallet_control_schema_migrations SET checksum = ? WHERE version = ?')
            .run(checksum, row.version);
        }
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
}
