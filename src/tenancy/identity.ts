import { createHmac } from 'node:crypto';
import { isCanonicalTenantId } from '../auth.js';
import type { PgPoolLike } from './postgres-repository.js';
import { householdInviteTokenHash } from './household-invites.js';
import { betaInviteTokenHash } from './beta-invites.js';

export type IdentityProvider = 'privy';

export interface TenantIdentityBinding {
  tenantId: string;
  ownerSubject: string;
  memberId?: string;
}

export interface BetaInviteRedemption extends TenantIdentityBinding {
  newlyAccepted: boolean;
}

export interface TenantIdentityResolver {
  resolve(provider: IdentityProvider, providerSubject: string): Promise<TenantIdentityBinding | undefined>;
  acceptHouseholdInvite?(token: string, provider: IdentityProvider, providerSubject: string): Promise<TenantIdentityBinding | undefined>;
  redeemBetaInvite?(token: string, provider: IdentityProvider, providerSubject: string): Promise<BetaInviteRedemption | undefined>;
  close?(): Promise<void>;
}

export class HouseholdInviteConflictError extends Error {
  constructor() { super('Household invite identity is already linked'); }
}

export class BetaInviteConflictError extends Error {
  constructor() { super('Beta invite identity is already linked'); }
}

interface IdentityBindingRow extends Record<string, unknown> {
  tenant_id: string;
  owner_subject: string;
  member_id: string | null;
}

function validatedIdentityBinding(row: IdentityBindingRow | undefined): TenantIdentityBinding | undefined {
  if (!row) return undefined;
  if (!isCanonicalTenantId(row.tenant_id) || !row.owner_subject || row.owner_subject.length > 512 ||
    row.owner_subject.trim() !== row.owner_subject) {
    throw new Error('Identity binding lookup is invalid');
  }
  const memberId = row.member_id ?? null;
  if (memberId !== null && (!memberId || memberId.length > 255 || memberId.trim() !== memberId)) {
    throw new Error('Identity binding lookup is invalid');
  }
  return {
    tenantId: row.tenant_id,
    ownerSubject: row.owner_subject,
    ...(memberId ? { memberId } : {}),
  };
}

function sameIdentityBinding(left: TenantIdentityBinding, right: TenantIdentityBinding): boolean {
  return left.tenantId === right.tenantId && left.ownerSubject === right.ownerSubject &&
    left.memberId === right.memberId;
}

function canonicalBindingKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('Identity binding key must be a canonical base64-encoded 32-byte key');
  }
  return key;
}

export function tenantIdentityHash(provider: IdentityProvider, providerSubject: string, bindingKey: string): string {
  if (!providerSubject || providerSubject.length > 512 || providerSubject.trim() !== providerSubject) {
    throw new Error('Identity provider subject is invalid');
  }
  return createHmac('sha256', canonicalBindingKey(bindingKey))
    .update(`meowwa:identity:v1:${provider}\0${providerSubject}`, 'utf8')
    .digest('hex');
}

export class PostgresTenantIdentityResolver implements TenantIdentityResolver {
  readonly #bindingKeys: readonly string[];
  readonly #statementTimeout: string;
  readonly #lockTimeout: string;

  constructor(
    private readonly pool: PgPoolLike,
    options: { bindingKey?: string; bindingKeys?: readonly string[]; statementTimeoutMs?: number; lockTimeoutMs?: number },
  ) {
    if (options.bindingKey && options.bindingKeys) throw new Error('Configure one identity binding key source');
    const bindingKeys = options.bindingKeys ? [...options.bindingKeys] : options.bindingKey ? [options.bindingKey] : [];
    if (bindingKeys.length < 1 || bindingKeys.length > 3 || new Set(bindingKeys).size !== bindingKeys.length) {
      throw new Error('Identity binding keyring is invalid');
    }
    for (const key of bindingKeys) canonicalBindingKey(key);
    this.#bindingKeys = bindingKeys;
    const statementTimeoutMs = options.statementTimeoutMs ?? 5_000;
    const lockTimeoutMs = options.lockTimeoutMs ?? 1_000;
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 100 || statementTimeoutMs > 30_000 ||
      !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 100 || lockTimeoutMs > statementTimeoutMs) {
      throw new Error('Identity resolver timeout configuration is invalid');
    }
    this.#statementTimeout = `${statementTimeoutMs}ms`;
    this.#lockTimeout = `${lockTimeoutMs}ms`;
  }

  async resolve(provider: IdentityProvider, providerSubject: string): Promise<TenantIdentityBinding | undefined> {
    const identityHashes = this.#bindingKeys.map((bindingKey) => tenantIdentityHash(provider, providerSubject, bindingKey));
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await client.query('SET LOCAL ROLE meowwa_identity_resolver');
      await client.query("SELECT set_config('search_path', 'pg_catalog, public', true)");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [this.#statementTimeout]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [this.#lockTimeout]);
      let binding: TenantIdentityBinding | undefined;
      for (const identityHash of identityHashes) {
        const result = await client.query<IdentityBindingRow>(
          'SELECT tenant_id::text, owner_subject, member_id FROM meowwa_resolve_identity($1, $2)',
          [provider, identityHash],
        );
        if (result.rows.length > 1) throw new Error('Identity binding lookup is invalid');
        const resolved = validatedIdentityBinding(result.rows[0]);
        if (!resolved) continue;
        if (binding && !sameIdentityBinding(binding, resolved)) {
          throw new Error('Identity binding lookup is invalid');
        }
        binding = resolved;
      }
      await client.query('COMMIT');
      return binding;
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* retain the original lookup error */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptHouseholdInvite(
    token: string,
    provider: IdentityProvider,
    providerSubject: string,
  ): Promise<TenantIdentityBinding | undefined> {
    const inviteHash = householdInviteTokenHash(token);
    const identityHashes = this.#bindingKeys.map((bindingKey) => tenantIdentityHash(provider, providerSubject, bindingKey));
    const identityHash = identityHashes[0]!;
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SET LOCAL ROLE meowwa_identity_resolver');
      await client.query("SELECT set_config('search_path', 'pg_catalog, public', true)");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [this.#statementTimeout]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [this.#lockTimeout]);
      const result = await client.query<IdentityBindingRow>(
        `SELECT tenant_id::text, owner_subject, member_id
         FROM meowwa_accept_household_invite($1, $2, $3)`,
        [inviteHash, provider, identityHash],
      );
      if (result.rows.length > 1) throw new Error('Household invite acceptance is invalid');
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return undefined;
      }
      if (!isCanonicalTenantId(row.tenant_id) || !row.owner_subject || row.owner_subject.length > 512 ||
        row.owner_subject.trim() !== row.owner_subject || !row.member_id || row.member_id.length > 255 ||
        row.member_id.trim() !== row.member_id) {
        throw new Error('Household invite acceptance is invalid');
      }
      // Acceptance only binds the current key. During a rotation window the same Privy identity
      // may already be bound under a previous key — possibly to a different tenant — which
      // resolve() would later reject. Fail closed here instead, inside the same transaction so
      // the binding insert and the invite consumption both roll back.
      for (const previousHash of identityHashes.slice(1)) {
        const other = await client.query<IdentityBindingRow>(
          'SELECT tenant_id::text, owner_subject, member_id FROM meowwa_resolve_identity($1, $2)',
          [provider, previousHash],
        );
        if (other.rows.length > 1) throw new Error('Household invite acceptance is invalid');
        const existing = other.rows[0];
        if (!existing) continue;
        if (existing.tenant_id !== row.tenant_id || (existing.member_id ?? null) !== row.member_id) {
          throw new HouseholdInviteConflictError();
        }
      }
      await client.query('COMMIT');
      return { tenantId: row.tenant_id, ownerSubject: row.owner_subject, memberId: row.member_id };
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* retain the original acceptance error */ }
      }
      if (error instanceof Error &&
        (error.message === 'identity is already linked' || error.message === 'household member is already linked')) {
        throw new HouseholdInviteConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async redeemBetaInvite(
    token: string,
    provider: IdentityProvider,
    providerSubject: string,
  ): Promise<BetaInviteRedemption | undefined> {
    const inviteHash = betaInviteTokenHash(token);
    const identityHashes = this.#bindingKeys.map((bindingKey) => tenantIdentityHash(provider, providerSubject, bindingKey));
    const identityHash = identityHashes[0]!;
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SET LOCAL ROLE meowwa_identity_resolver');
      await client.query("SELECT set_config('search_path', 'pg_catalog, public', true)");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [this.#statementTimeout]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [this.#lockTimeout]);
      const result = await client.query<IdentityBindingRow & { newly_accepted: boolean }>(
        `SELECT tenant_id::text, owner_subject, newly_accepted
         FROM meowwa_redeem_beta_invite($1, $2, $3)`,
        [inviteHash, provider, identityHash],
      );
      if (result.rows.length > 1) throw new Error('Beta invite redemption is invalid');
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return undefined;
      }
      if (!isCanonicalTenantId(row.tenant_id) || !row.owner_subject || row.owner_subject.length > 512 ||
        row.owner_subject.trim() !== row.owner_subject || typeof row.newly_accepted !== 'boolean') {
        throw new Error('Beta invite redemption is invalid');
      }
      // Redemption only binds the current key. During a rotation window the same Privy
      // identity may already be bound under a previous key — possibly to a different
      // tenant or as a household member — which resolve() would later reject. Fail
      // closed here instead, inside the same transaction so the binding insert and the
      // invite consumption both roll back.
      for (const previousHash of identityHashes.slice(1)) {
        const other = await client.query<IdentityBindingRow>(
          'SELECT tenant_id::text, owner_subject, member_id FROM meowwa_resolve_identity($1, $2)',
          [provider, previousHash],
        );
        if (other.rows.length > 1) throw new Error('Beta invite redemption is invalid');
        const existing = other.rows[0];
        if (!existing) continue;
        if (existing.tenant_id !== row.tenant_id || (existing.member_id ?? null) !== null) {
          throw new BetaInviteConflictError();
        }
      }
      await client.query('COMMIT');
      return { tenantId: row.tenant_id, ownerSubject: row.owner_subject, newlyAccepted: row.newly_accepted };
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* retain the original redemption error */ }
      }
      if (error instanceof Error &&
        (error.message === 'identity is already linked' || error.message === 'tenant is already claimed')) {
        throw new BetaInviteConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}
