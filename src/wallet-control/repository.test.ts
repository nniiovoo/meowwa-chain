import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { walletControlMigrations } from './migrations.js';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, buildAgentSignerPolicy, policyDigest } from './policy.js';
import { WalletControlConflictError, WalletControlRepository } from './repository.js';

const directories: string[] = [];
const now = new Date('2026-07-14T12:00:00.000Z');

function openRepositoryInChild(path: string): Promise<{ code: number | null; stderr: string }> {
  const modulePath = new URL('./repository.ts', import.meta.url).pathname;
  const source = `import { WalletControlRepository } from ${JSON.stringify(modulePath)}; const repository = new WalletControlRepository(process.env.TEST_DB_PATH); repository.close();`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(), env: { ...process.env, TEST_DB_PATH: path }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function beginInput(overrides: Record<string, unknown> = {}) {
  const expectedPolicy = buildAgentSignerPolicy({
    ownerPrivyUserId: 'did:privy:owner_123', petId: 'pet_mochi',
    allowedRecipients: ['0x1111111111111111111111111111111111111111'],
    perTransactionLimitAtomic: '1000000', validUntil: '2026-07-15T12:00:00.000Z',
  });
  const expectedPolicyJson = JSON.stringify(expectedPolicy);
  return {
    bindingId: 'wcb_123', ownerId: 'owner_1', petId: 'pet_mochi', appWalletId: 'wallet_mochi',
    privyUserId: 'did:privy:owner_123', agentSignerId: 'quorum_agent_123',
    expectedPolicyDigest: policyDigest(expectedPolicy),
    expectedPolicyJson,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('wallet control repository', () => {
  it('persists a namespaced Base Sepolia binding lifecycle and audit events', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    expect(repository.appliedMigrationVersions()).toEqual([1, 2]);

    const requested = repository.beginProvisioning(beginInput());
    expect(requested).toMatchObject({
      bindingId: 'wcb_123', environment: 'sandbox', chainId: BASE_SEPOLIA_CHAIN_ID,
      usdcContract: BASE_SEPOLIA_USDC, smartWalletType: 'embedded_hd', ownerType: 'privy_user',
      status: 'requested', signerStatus: 'pending', ownerEscapeStatus: 'unverified', version: 1,
    });
    const withPolicy = repository.setPolicy('wcb_123', requested.version, 'policy_123');
    expect(withPolicy).toMatchObject({ status: 'provisioning', agentPolicyId: 'policy_123', version: 2 });
    const active = repository.activate('wcb_123', withPolicy.version, {
      privyEmbeddedWalletId: 'embedded_123',
      smartWalletAddress: '0x1111111111111111111111111111111111111111',
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });
    expect(active).toMatchObject({
      status: 'active', signerStatus: 'attached', privyEmbeddedWalletId: 'embedded_123',
      smartWalletAddress: '0x1111111111111111111111111111111111111111',
      lastVerifiedAt: '2026-07-14T12:01:00.000Z', version: 3,
    });
    expect(repository.getBinding('owner_1', 'pet_mochi')).toEqual(active);
    expect(repository.listEvents('wcb_123').map((event) => event.kind)).toEqual([
      'provisioning_requested', 'policy_created', 'binding_activated',
    ]);
    repository.close();
  });

  it('can move a paused binding back out of paused', () => {
    // 'paused' used to have only markDrifted and recordAgentRevoked as successors -- both of which
    // take capability away -- so an ordinary owner pause was a one-way door and every route that
    // needs a live binding answered 409 for that pet forever.
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const requested = repository.beginProvisioning(beginInput());
    const withPolicy = repository.setPolicy(requested.bindingId, requested.version, 'policy_123');
    const active = repository.activate(withPolicy.bindingId, withPolicy.version, {
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: '0x1111111111111111111111111111111111111111',
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });
    const paused = repository.pause(active.bindingId, active.version, 'owner');
    expect(paused).toMatchObject({ status: 'paused' });

    const resumed = repository.resume(paused.bindingId, paused.version);
    expect(resumed).toMatchObject({ status: 'active', signerStatus: 'attached', version: paused.version + 1 });
    expect(repository.listEvents('wcb_123').map((event) => event.kind)).toEqual([
      'provisioning_requested', 'policy_created', 'binding_activated', 'binding_paused', 'binding_resumed',
    ]);
    // A binding that is not paused is not resumable, and a stale version still loses.
    expect(() => repository.resume(resumed.bindingId, resumed.version)).toThrow('Cannot transition');
    const repaused = repository.pause(resumed.bindingId, resumed.version, 'owner');
    expect(() => repository.resume(repaused.bindingId, repaused.version - 1)).toThrow('stale');
    // Revocation is still the stronger state: resuming must not reach past it.
    const revoked = repository.recordAgentRevoked(repaused.bindingId, repaused.version);
    expect(() => repository.resume(revoked.bindingId, revoked.version)).toThrow('Cannot transition');
    repository.close();
  });

  it('is idempotent for the same request and rejects an immutable binding conflict', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const first = repository.beginProvisioning(beginInput());
    expect(repository.beginProvisioning(beginInput())).toEqual(first);
    expect(() => repository.beginProvisioning(beginInput({ agentSignerId: 'quorum_other' }))).toThrow(WalletControlConflictError);
    const alternatePolicy = buildAgentSignerPolicy({
      ownerPrivyUserId: 'did:privy:owner_123', petId: 'pet_mochi',
      allowedRecipients: ['0x2222222222222222222222222222222222222222'],
      perTransactionLimitAtomic: '1000000', validUntil: '2026-07-15T12:00:00.000Z',
    });
    expect(() => repository.beginProvisioning(beginInput({
      expectedPolicyDigest: policyDigest(alternatePolicy), expectedPolicyJson: JSON.stringify(alternatePolicy),
    }))).toThrow(WalletControlConflictError);
    repository.close();
  });

  it('rejects a case-insensitive duplicate external wallet address across pets', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const first = repository.beginProvisioning(beginInput());
    const firstWithPolicy = repository.setPolicy(first.bindingId, first.version, 'policy_123');
    repository.activate(first.bindingId, firstWithPolicy.version, {
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: `0xA${'b'.repeat(39)}`,
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });

    const secondPolicy = buildAgentSignerPolicy({
      ownerPrivyUserId: 'did:privy:owner_123', petId: 'pet_pepper',
      allowedRecipients: ['0x1111111111111111111111111111111111111111'],
      perTransactionLimitAtomic: '1000000', validUntil: '2026-07-15T12:00:00.000Z',
    });
    const second = repository.beginProvisioning(beginInput({
      bindingId: 'wcb_456', petId: 'pet_pepper', appWalletId: 'wallet_pepper',
      expectedPolicyDigest: policyDigest(secondPolicy), expectedPolicyJson: JSON.stringify(secondPolicy),
    }));
    const secondWithPolicy = repository.setPolicy(second.bindingId, second.version, 'policy_456');
    expect(() => repository.activate(second.bindingId, secondWithPolicy.version, {
      privyEmbeddedWalletId: 'embedded_456', smartWalletAddress: `0xa${'b'.repeat(39)}`,
      verifiedAt: '2026-07-14T12:02:00.000Z',
    })).toThrow(WalletControlConflictError);
    expect(repository.getBinding('owner_1', 'pet_pepper')).toMatchObject({ status: 'provisioning' });
    repository.close();
  });

  it('rejects stale transitions and cannot silently replace external identities', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const requested = repository.beginProvisioning(beginInput());
    const withPolicy = repository.setPolicy(requested.bindingId, requested.version, 'policy_123');
    expect(() => repository.setPolicy(requested.bindingId, requested.version, 'policy_123')).toThrow('stale');
    const active = repository.activate(withPolicy.bindingId, withPolicy.version, {
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: '0x1111111111111111111111111111111111111111',
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });
    expect(() => repository.activate(active.bindingId, active.version, {
      privyEmbeddedWalletId: 'embedded_other', smartWalletAddress: '0x2222222222222222222222222222222222222222',
      verifiedAt: '2026-07-14T12:02:00.000Z',
    })).toThrow('active');
    repository.close();
  });

  it('resumes only an existing policy and never replaces it through the creation transition', () => {
    const missingPolicyRepository = new WalletControlRepository(':memory:', { now: () => now });
    const requested = missingPolicyRepository.beginProvisioning(beginInput());
    const failedBeforePolicy = missingPolicyRepository.markFailed(requested.bindingId, requested.version, 'provider-error');
    expect(() => missingPolicyRepository.resumeProvisioning(failedBeforePolicy.bindingId, failedBeforePolicy.version))
      .toThrow('policy is missing');
    missingPolicyRepository.close();

    const existingPolicyRepository = new WalletControlRepository(':memory:', { now: () => now });
    const secondRequested = existingPolicyRepository.beginProvisioning(beginInput());
    const withPolicy = existingPolicyRepository.setPolicy(secondRequested.bindingId, secondRequested.version, 'policy_original');
    const failedAfterPolicy = existingPolicyRepository.markFailed(withPolicy.bindingId, withPolicy.version, 'provider-error');
    expect(() => existingPolicyRepository.setPolicy(failedAfterPolicy.bindingId, failedAfterPolicy.version, 'policy_attacker'))
      .toThrow(WalletControlConflictError);
    expect(existingPolicyRepository.getBindingById(failedAfterPolicy.bindingId)?.agentPolicyId).toBe('policy_original');
    expect(existingPolicyRepository.resumeProvisioning(failedAfterPolicy.bindingId, failedAfterPolicy.version))
      .toMatchObject({ status: 'provisioning', agentPolicyId: 'policy_original' });
    existingPolicyRepository.close();
  });

  it('atomically records a verified signer-policy rotation without replacing the pet wallet', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const requested = repository.beginProvisioning(beginInput());
    const withPolicy = repository.setPolicy(requested.bindingId, requested.version, 'policy_123');
    const active = repository.activate(withPolicy.bindingId, withPolicy.version, {
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: '0x1111111111111111111111111111111111111111',
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });
    const replacement = buildAgentSignerPolicy({
      ownerPrivyUserId: 'did:privy:owner_123', petId: 'pet_mochi',
      allowedRecipients: ['0x3333333333333333333333333333333333333333'],
      perTransactionLimitAtomic: '2000000', validUntil: '2026-07-16T12:00:00.000Z',
    });

    const rotated = repository.recordPolicyRotation(active.bindingId, active.version, {
      agentPolicyId: 'policy_456', expectedPolicyDigest: policyDigest(replacement),
      expectedPolicyJson: JSON.stringify(replacement), verifiedAt: '2026-07-14T12:02:00.000Z',
    });

    expect(rotated).toMatchObject({
      status: 'active', signerStatus: 'attached', agentPolicyId: 'policy_456',
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: '0x1111111111111111111111111111111111111111',
      expectedPolicyDigest: policyDigest(replacement), lastVerifiedAt: '2026-07-14T12:02:00.000Z', version: 4,
    });
    expect(repository.listEvents(active.bindingId).map((event) => event.kind)).toEqual([
      'provisioning_requested', 'policy_created', 'binding_activated', 'agent_policy_rotated',
    ]);
    expect(() => repository.recordPolicyRotation(active.bindingId, active.version, {
      agentPolicyId: 'policy_456', expectedPolicyDigest: policyDigest(replacement),
      expectedPolicyJson: JSON.stringify(replacement), verifiedAt: '2026-07-14T12:02:00.000Z',
    })).toThrow('stale');
    repository.close();
  });

  it('records pause, drift, signer revocation, and verified recovery explicitly', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const requested = repository.beginProvisioning(beginInput());
    const withPolicy = repository.setPolicy(requested.bindingId, requested.version, 'policy_123');
    const active = repository.activate(withPolicy.bindingId, withPolicy.version, {
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: '0x1111111111111111111111111111111111111111',
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });
    const paused = repository.pause(active.bindingId, active.version, 'owner');
    expect(paused.status).toBe('paused');
    const drifted = repository.markDrifted(paused.bindingId, paused.version, 'agent-policy-mismatch');
    expect(drifted).toMatchObject({ status: 'drifted', signerStatus: 'drifted', failureCode: 'agent-policy-mismatch' });
    const revoked = repository.recordAgentRevoked(drifted.bindingId, drifted.version);
    expect(revoked).toMatchObject({ status: 'revoked', signerStatus: 'revoked' });
    expect(() => repository.pause(revoked.bindingId, revoked.version, 'owner')).toThrow('revoked');
    const recovered = repository.recordAgentRecovered(revoked.bindingId, revoked.version, '2026-07-14T12:03:00.000Z');
    expect(recovered).toMatchObject({
      status: 'recovered', signerStatus: 'attached', lastVerifiedAt: '2026-07-14T12:03:00.000Z',
    });
    expect(repository.listEvents(recovered.bindingId).map((event) => event.kind)).toEqual([
      'provisioning_requested', 'policy_created', 'binding_activated', 'binding_paused', 'binding_drifted',
      'agent_signer_revoked', 'agent_signer_recovered',
    ]);
    repository.close();
  });

  it('releases a drift that happened before the binding ever had a wallet, and only that one', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    // Drift before activation: the provider answered with a policy it owns itself, or the agent
    // signer had not attached yet. `recordAgentRevoked` is the only other edge out of 'drifted' and
    // it needs a wallet address the owner's client can sign against, so this binding had none.
    const requested = repository.beginProvisioning(beginInput());
    const drifted = repository.markDrifted(requested.bindingId, requested.version, 'policy-owner-mismatch');
    expect(drifted).toMatchObject({ status: 'drifted', privyEmbeddedWalletId: null, smartWalletAddress: null });
    const released = repository.releaseUnprovisionedDrift(drifted.bindingId)!;
    expect(released).toMatchObject({
      status: 'failed', signerStatus: 'pending', failureCode: 'policy-owner-mismatch', version: drifted.version + 1,
    });
    expect(repository.listEvents(released.bindingId).map((event) => event.kind))
      .toEqual(['provisioning_requested', 'binding_drifted', 'drift_released']);
    // 'failed' is the state the reprovision machinery already understands, so the retry path is live.
    expect(repository.setPolicy(released.bindingId, released.version, 'policy_123').status).toBe('provisioning');
    expect(repository.releaseUnprovisionedDrift(released.bindingId)).toBeUndefined();
    repository.close();
  });

  it('leaves a drift on a binding that was once live to the owner-authorized recovery pair', () => {
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const requested = repository.beginProvisioning(beginInput());
    const withPolicy = repository.setPolicy(requested.bindingId, requested.version, 'policy_123');
    const active = repository.activate(withPolicy.bindingId, withPolicy.version, {
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: '0x1111111111111111111111111111111111111111',
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });
    const drifted = repository.markDrifted(active.bindingId, active.version, 'agent-signer-missing');
    // `activate` is the only writer of these two columns, so carrying either means this wallet was
    // live once: re-arming it needs the owner's own Privy authorization, not a local edit.
    expect(repository.releaseUnprovisionedDrift(drifted.bindingId)).toBeUndefined();
    expect(repository.getBindingById(drifted.bindingId)).toMatchObject({ status: 'drifted', version: drifted.version });
    repository.close();
  });

  it('reopens durable state and restricts the database file permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-wallet-control-')); directories.push(directory);
    const path = join(directory, 'control.sqlite');
    const first = new WalletControlRepository(path, { now: () => now });
    first.beginProvisioning(beginInput());
    first.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new WalletControlRepository(path, { now: () => now });
    expect(reopened.getBinding('owner_1', 'pet_mochi')).toMatchObject({ bindingId: 'wcb_123', status: 'requested' });
    reopened.close();
  });

  it('upgrades a legacy migration ledger and rejects changed migration source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-wallet-control-ledger-')); directories.push(directory);
    const path = join(directory, 'control.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec('CREATE TABLE wallet_control_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of walletControlMigrations) {
      legacy.exec(migration.sql);
      legacy.prepare('INSERT INTO wallet_control_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, now.toISOString());
    }
    legacy.close();

    const upgraded = new WalletControlRepository(path, { now: () => now });
    expect(upgraded.appliedMigrationVersions()).toEqual(walletControlMigrations.map(({ version }) => version));
    upgraded.close();

    const tampered = new DatabaseSync(path);
    const checksums = tampered.prepare('SELECT version, checksum FROM wallet_control_schema_migrations ORDER BY version').all() as
      unknown as Array<{ version: number; checksum: string }>;
    expect(checksums).toEqual(walletControlMigrations.map((migration) => ({
      version: migration.version, checksum: createHash('sha256').update(migration.sql).digest('hex'),
    })));
    tampered.prepare('UPDATE wallet_control_schema_migrations SET checksum = ? WHERE version = 1').run('0'.repeat(64));
    tampered.close();

    expect(() => new WalletControlRepository(path, { now: () => now })).toThrow(/checksum/i);
  });

  it('rejects a database created by an unsupported newer schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-wallet-control-future-')); directories.push(directory);
    const path = join(directory, 'control.sqlite');
    const repository = new WalletControlRepository(path, { now: () => now });
    repository.close();
    const database = new DatabaseSync(path);
    database.prepare('INSERT INTO wallet_control_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
      .run(999, 'f'.repeat(64), now.toISOString());
    database.close();

    expect(() => new WalletControlRepository(path, { now: () => now })).toThrow(/unsupported newer schema/i);
  });

  it('converges concurrent fresh repository migration attempts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-wallet-control-concurrent-')); directories.push(directory);
    const path = join(directory, 'control.sqlite');
    const results = await Promise.all(Array.from({ length: 8 }, () => openRepositoryInChild(path)));

    expect(results.filter(({ code }) => code !== 0)).toEqual([]);
    const repository = new WalletControlRepository(path, { now: () => now });
    expect(repository.appliedMigrationVersions()).toEqual(walletControlMigrations.map(({ version }) => version));
    repository.close();
  });
});
