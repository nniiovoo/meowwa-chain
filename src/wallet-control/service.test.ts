import { describe, expect, it, vi } from 'vitest';
import { WalletControlRepository } from './repository.js';
import type { WalletControlProvider, WalletControlProviderInspection } from './provider.js';
import { WalletControlService, walletControlProviderDiagnostic } from './service.js';

const policyConfig = {
  ownerPrivyUserId: 'did:privy:owner_123',
  petId: 'pet_mochi',
  allowedRecipients: ['0x1111111111111111111111111111111111111111'],
  perTransactionLimitAtomic: '25000000',
  validUntil: '2026-07-15T12:00:00.000Z',
};

function serviceInput() {
  return {
    ownerId: 'owner_1', petId: 'pet_mochi', appWalletId: 'wallet_mochi',
    privyUserId: 'did:privy:owner_123', policyConfig,
  };
}

function fakeProvider(overrides: Partial<WalletControlProvider> = {}) {
  let policyId = 'policy_123';
  const policyDigests = new Map<string, string>();
  let signerAttached = true;
  let attachedPolicyId = 'policy_123';
  let provisionFailures = 0;
  let provisionedWallet: Awaited<ReturnType<NonNullable<WalletControlProvider['findProvisionedWallet']>>>;
  const createUserOwnedPolicy = vi.fn<WalletControlProvider['createUserOwnedPolicy']>(async ({ policy }) => {
    const { policyDigest } = await import('./policy.js');
    const digest = policyDigest(policy);
    policyDigests.set(policyId, digest);
    return { policyId, digest, ownerType: 'privy_user' };
  });
  const provisionUserWallet = vi.fn<WalletControlProvider['provisionUserWallet']>(async (input) => {
    if (provisionFailures > 0) {
      provisionFailures -= 1;
      throw new Error('provider unavailable');
    }
    attachedPolicyId = input.agentPolicyId;
    provisionedWallet = {
      embeddedWalletId: 'embedded_123',
      agentSigners: [{ signerId: input.agentSignerId, overridePolicyIds: [input.agentPolicyId] }],
    };
    return { embeddedWalletId: 'embedded_123', smartWalletAddress: '0x2222222222222222222222222222222222222222' };
  });
  const findProvisionedWallet = vi.fn<NonNullable<WalletControlProvider['findProvisionedWallet']>>(
    async () => provisionedWallet,
  );
  const inspectBinding = vi.fn<WalletControlProvider['inspectBinding']>(async (input) => ({
    privyUserId: input.privyUserId,
    embeddedWalletId: input.embeddedWalletId,
    smartWalletAddress: input.smartWalletAddress,
    smartWalletType: 'embedded_hd',
    userLinked: true,
    agentSigners: signerAttached ? [{ signerId: 'quorum_agent_123', overridePolicyIds: [attachedPolicyId] }] : [],
    policy: { policyId: input.agentPolicyId, digest: policyDigests.get(input.agentPolicyId) ?? '', ownerType: 'privy_user' },
  }));
  return {
    provider: { createUserOwnedPolicy, provisionUserWallet, inspectBinding, findProvisionedWallet, ...overrides } as WalletControlProvider,
    createUserOwnedPolicy, provisionUserWallet, inspectBinding, findProvisionedWallet,
    setPolicyId(value: string) { policyId = value; },
    failProvisionOnce() { provisionFailures += 1; },
    simulateProvisionedWalletRemnant(value: string) {
      provisionedWallet = { embeddedWalletId: 'embedded_123', agentSigners: [{ signerId: 'quorum_agent_123', overridePolicyIds: [value] }] };
    },
    authorizeClientAttachment(value: string) { signerAttached = true; attachedPolicyId = value; },
    authorizeClientRevocation() { signerAttached = false; },
  };
}

function createService(provider: WalletControlProvider, repository = new WalletControlRepository(':memory:')) {
  return {
    repository,
    service: new WalletControlService({
      repository, provider, agentSignerId: 'quorum_agent_123', now: () => new Date('2026-07-14T12:00:00.000Z'),
    }),
  };
}

describe('wallet control service', () => {
  it('provisions a user-owned embedded HD wallet with one exact policy-bound agent signer', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    const binding = await service.provision(serviceInput());
    expect(binding).toMatchObject({
      status: 'active', ownerType: 'privy_user', smartWalletType: 'embedded_hd', signerStatus: 'attached',
      agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
      privyEmbeddedWalletId: 'embedded_123', smartWalletAddress: '0x2222222222222222222222222222222222222222',
    });
    expect(fake.createUserOwnedPolicy).toHaveBeenCalledWith(expect.objectContaining({
      privyUserId: 'did:privy:owner_123', idempotencyKey: expect.stringMatching(/^meowwa_policy_[a-f0-9]{32}$/),
    }));
    expect(fake.provisionUserWallet).toHaveBeenCalledWith(expect.objectContaining({
      privyUserId: 'did:privy:owner_123', agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
      externalId: expect.stringMatching(/^meowwa_control_[a-f0-9]{32}$/),
    }));
    repository.close();
  });

  it('coalesces concurrent retries and does not create another policy or wallet', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    const [left, right] = await Promise.all([service.provision(serviceInput()), service.provision(serviceInput())]);
    expect(left.bindingId).toBe(right.bindingId);
    expect(fake.createUserOwnedPolicy).toHaveBeenCalledTimes(1);
    expect(fake.provisionUserWallet).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it('does not let a stale concurrent process mark a successfully progressing binding failed', async () => {
    const fake = fakeProvider();
    const repository = new WalletControlRepository(':memory:');
    const left = createService(fake.provider, repository).service;
    const right = createService(fake.provider, repository).service;
    const results = await Promise.allSettled([left.provision(serviceInput()), right.provision(serviceInput())]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({ status: 'active', signerStatus: 'attached' });
    expect(repository.getBinding('owner_1', 'pet_mochi')?.failureCode).toBeNull();
    repository.close();
  });

  it('persists the policy ID and resumes after a partial provider failure', async () => {
    let first = true;
    const fake = fakeProvider({
      provisionUserWallet: vi.fn(async () => {
        if (first) { first = false; throw new Error('provider timed out with sensitive detail'); }
        return { embeddedWalletId: 'embedded_123', smartWalletAddress: '0x2222222222222222222222222222222222222222' };
      }),
    });
    const { service, repository } = createService(fake.provider);
    await expect(service.provision(serviceInput())).rejects.toThrow('Wallet control provisioning failed');
    expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({
      status: 'failed', agentPolicyId: 'policy_123', failureCode: 'provider-error',
    });
    const retried = await service.provision(serviceInput());
    expect(retried.status).toBe('active');
    expect(fake.createUserOwnedPolicy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(repository.listEvents(retried.bindingId))).not.toContain('sensitive detail');
    repository.close();
  });

  // GREEN (was the RED `it.fails` for .scratch/audited-defect-followups spec item 1): a failed
  // binding adopts the new policy only after the provider confirms no wallet exists for the
  // binding's write-once external ID, which proves the abandoned policy is orphaned.
  it('recovers a failed provisioning after its original policy expires', async () => {
    let now = new Date('2026-07-14T12:00:00.000Z');
    const fake = fakeProvider();
    const repository = new WalletControlRepository(':memory:', { now: () => now });
    const service = new WalletControlService({
      repository,
      provider: fake.provider,
      agentSignerId: 'quorum_agent_123',
      now: () => now,
    });

    try {
      fake.failProvisionOnce();
      await expect(service.provision(serviceInput())).rejects.toThrow('Wallet control provisioning failed');
      expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({
        status: 'failed',
        agentPolicyId: 'policy_123',
      });

      now = new Date('2026-07-16T12:00:00.000Z');
      fake.setPolicyId('policy_456');
      await expect(service.provision({
        ...serviceInput(),
        policyConfig: {
          ...policyConfig,
          validUntil: '2026-07-17T12:00:00.000Z',
        },
      })).resolves.toMatchObject({ status: 'active', agentPolicyId: 'policy_456' });
      expect(fake.findProvisionedWallet).toHaveBeenCalledOnce();
      // The abandoned policy id and the adopted digests stay auditable on the binding's event log.
      const bindingId = repository.getBinding('owner_1', 'pet_mochi')!.bindingId;
      expect(repository.listEvents(bindingId).some((event) =>
        event.kind === 'reprovision_policy_adopted' && event.detail?.startsWith('policy_123:'))).toBe(true);
      // Privy 400s a reused idempotency key whose body changed, so the changed wallet request
      // must carry a fresh key rather than replay the stale one.
      const walletKeys = fake.provisionUserWallet.mock.calls.map(([input]) => input.idempotencyKey);
      expect(walletKeys).toHaveLength(2);
      expect(new Set(walletKeys).size).toBe(2);
    } finally {
      repository.close();
    }
  });

  it('fails closed when the abandoned policy may still be attached to a provisioned wallet', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    fake.failProvisionOnce();
    await expect(service.provision(serviceInput())).rejects.toThrow('Wallet control provisioning failed');
    const failed = repository.getBinding('owner_1', 'pet_mochi');
    expect(failed).toMatchObject({ status: 'failed', agentPolicyId: 'policy_123' });

    // The wallet call timed out server-side but actually succeeded: the wallet exists and the
    // agent signer still carries the old policy, which could resurrect a signer believed gone.
    fake.simulateProvisionedWalletRemnant('policy_123');
    await expect(service.provision({
      ...serviceInput(),
      policyConfig: { ...policyConfig, validUntil: '2026-07-17T12:00:00.000Z' },
    })).rejects.toMatchObject({ name: 'WalletControlStalePolicyError', reason: 'stale-policy-attached' });
    expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({
      status: 'failed', agentPolicyId: 'policy_123', expectedPolicyDigest: failed!.expectedPolicyDigest,
    });
    expect(fake.createUserOwnedPolicy).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it.each([
    ['user-link-mismatch', (inspection: WalletControlProviderInspection) => ({ ...inspection, userLinked: false })],
    ['wallet-type-mismatch', (inspection: WalletControlProviderInspection) => ({ ...inspection, smartWalletType: 'unknown' as const })],
    ['agent-signer-missing', (inspection: WalletControlProviderInspection) => ({ ...inspection, agentSigners: [] })],
    ['agent-policy-mismatch', (inspection: WalletControlProviderInspection) => ({ ...inspection, agentSigners: [{ signerId: 'quorum_agent_123', overridePolicyIds: ['policy_other'] }] })],
    ['policy-digest-mismatch', (inspection: WalletControlProviderInspection) => ({ ...inspection, policy: { ...inspection.policy, digest: 'b'.repeat(64) } })],
    ['policy-owner-mismatch', (inspection: WalletControlProviderInspection) => ({ ...inspection, policy: { ...inspection.policy, ownerType: 'key_quorum' as const } })],
  ] as const)('marks %s as drift instead of repairing it', async (reason, mutate) => {
    const base = fakeProvider();
    const inspectBinding = vi.fn<WalletControlProvider['inspectBinding']>(async (input) => {
      const created = await base.inspectBinding(input);
      return mutate(created);
    });
    const { service, repository } = createService({ ...base.provider, inspectBinding });
    const binding = await service.provision(serviceInput());
    expect(binding).toMatchObject({ status: 'drifted', signerStatus: 'drifted', failureCode: reason });
    repository.close();
  });

  it('re-verifies active provider state and records drift when the signer later changes', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    const active = await service.provision(serviceInput());
    fake.inspectBinding.mockResolvedValueOnce({
      privyUserId: active.privyUserId, embeddedWalletId: active.privyEmbeddedWalletId!, smartWalletAddress: active.smartWalletAddress!,
      smartWalletType: 'embedded_hd', userLinked: true, agentSigners: [],
      policy: { policyId: active.agentPolicyId!, digest: active.expectedPolicyDigest, ownerType: 'privy_user' },
    });
    const checked = await service.verify('owner_1', 'pet_mochi');
    expect(checked).toMatchObject({ status: 'drifted', failureCode: 'agent-signer-missing' });
    repository.close();
  });

  it('persists revocation only after the client removes every additional signer', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    const active = await service.provision(serviceInput());
    const prepared = service.prepareClientSignerRevocation('owner_1', 'pet_mochi');
    expect(prepared).toEqual({
      status: 'owner-authorization-required',
      attachment: { walletAddress: active.smartWalletAddress, expectedBindingVersion: active.version },
    });
    await expect(service.completeClientSignerRevocation('owner_1', 'pet_mochi', active.version))
      .rejects.toThrow('Wallet control provisioning failed');
    expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({ status: 'active', signerStatus: 'attached' });

    fake.authorizeClientRevocation();
    const revoked = await service.completeClientSignerRevocation('owner_1', 'pet_mochi', active.version);
    expect(revoked).toMatchObject({ status: 'revoked', signerStatus: 'revoked' });
    expect(await service.completeClientSignerRevocation('owner_1', 'pet_mochi', active.version)).toEqual(revoked);
    repository.close();
  });

  it('restores only the exact stored signer and policy after provider verification', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    const active = await service.provision(serviceInput());
    fake.authorizeClientRevocation();
    const revoked = await service.completeClientSignerRevocation('owner_1', 'pet_mochi', active.version);
    const prepared = service.prepareClientSignerRecovery('owner_1', 'pet_mochi');
    expect(prepared).toMatchObject({
      status: 'owner-authorization-required',
      attachment: {
        walletAddress: active.smartWalletAddress, agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
        expectedPolicyDigest: active.expectedPolicyDigest, expectedBindingVersion: revoked.version,
      },
    });
    await expect(service.completeClientSignerRecovery('owner_1', 'pet_mochi', prepared.attachment))
      .rejects.toThrow('Wallet control provisioning failed');
    expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({ status: 'revoked', signerStatus: 'revoked' });

    fake.authorizeClientAttachment(prepared.attachment.agentPolicyId);
    const recovered = await service.completeClientSignerRecovery('owner_1', 'pet_mochi', prepared.attachment);
    expect(recovered).toMatchObject({ status: 'recovered', signerStatus: 'attached', lastVerifiedAt: '2026-07-14T12:00:00.000Z' });
    expect(await service.completeClientSignerRecovery('owner_1', 'pet_mochi', prepared.attachment)).toEqual(recovered);
    repository.close();
  });

  it('prepares a policy without server-side wallet authorization and persists only after the client attachment verifies', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    const active = await service.provision(serviceInput());
    fake.setPolicyId('policy_456');
    const input = {
      ...serviceInput(),
      policyConfig: {
        ...policyConfig,
        allowedRecipients: ['0x3333333333333333333333333333333333333333'],
        validUntil: '2026-07-16T12:00:00.000Z',
      },
    };

    const prepared = await service.prepareClientPolicyRotation(input);
    expect(prepared).toMatchObject({
      status: 'owner-authorization-required',
      attachment: {
        walletAddress: active.smartWalletAddress, agentSignerId: 'quorum_agent_123',
        agentPolicyId: 'policy_456', expectedPolicyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({
      agentPolicyId: 'policy_123', expectedPolicyDigest: active.expectedPolicyDigest,
    });
    if (prepared.status !== 'owner-authorization-required') throw new Error('Expected owner authorization');
    fake.authorizeClientAttachment(prepared.attachment.agentPolicyId);

    const completed = await service.completeClientPolicyRotation(input, prepared.attachment);
    expect(completed).toMatchObject({
      bindingId: active.bindingId, agentPolicyId: 'policy_456', status: 'active', signerStatus: 'attached',
    });
    repository.close();
  });

  it('does not persist a prepared policy when the client attachment cannot be verified', async () => {
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    const active = await service.provision(serviceInput());
    fake.setPolicyId('policy_456');
    const input = {
      ...serviceInput(),
      policyConfig: {
        ...policyConfig,
        allowedRecipients: ['0x3333333333333333333333333333333333333333'],
        validUntil: '2026-07-16T12:00:00.000Z',
      },
    };
    const prepared = await service.prepareClientPolicyRotation(input);
    if (prepared.status !== 'owner-authorization-required') throw new Error('Expected owner authorization');

    await expect(service.completeClientPolicyRotation(input, prepared.attachment))
      .rejects.toThrow('Wallet control provisioning failed');
    expect(repository.getBinding('owner_1', 'pet_mochi')).toMatchObject({
      version: active.version, agentPolicyId: 'policy_123', expectedPolicyDigest: active.expectedPolicyDigest,
    });
    repository.close();
  });

  it('reports only a redacted provider stage when replacement policy creation fails', async () => {
    // The diagnostic is spread as top-level log fields, which never reach the `err` serializer or
    // the redact allowlist, so the provider's free-text message may not be one of them: it carries
    // whatever Privy put in it -- here an RPC URL with the API key in its query string.
    const providerError = Object.assign(new Error(
      '403 wallet 0x4444444444444444444444444444444444444444 rejected token eyJsupersecretownerjwttokenvalue' +
      ' calling https://api.privy.io/v1/policies?apiKey=pk-live-9 for user bob@example.test',
    ), { status: 403, error: { code: 'permission_denied' } });
    const fake = fakeProvider();
    const { service, repository } = createService(fake.provider);
    await service.provision(serviceInput());
    fake.setPolicyId('policy_456');
    fake.createUserOwnedPolicy.mockRejectedValueOnce(providerError);
    let failure: unknown;
    try {
      await service.prepareClientPolicyRotation({
        ...serviceInput(), policyConfig: {
          ...policyConfig, allowedRecipients: ['0x3333333333333333333333333333333333333333'],
          validUntil: '2026-07-16T12:00:00.000Z',
        },
      });
    } catch (error) {
      failure = error;
    }

    const diagnostic = walletControlProviderDiagnostic(failure);
    expect(diagnostic).toEqual({
      stage: 'create-replacement-policy', providerStatus: 403, providerCode: 'permission_denied',
    });
    // `toEqual` above is the real guard -- no field carries provider text at all. These name the
    // values a pattern-scrubbing denylist let through and a whole-message drop does not.
    expect(JSON.stringify(diagnostic)).not.toContain('0x4444444444444444444444444444444444444444');
    expect(JSON.stringify(diagnostic)).not.toContain('eyJsupersecretownerjwttokenvalue');
    expect(JSON.stringify(diagnostic)).not.toContain('api.privy.io');
    expect(JSON.stringify(diagnostic)).not.toContain('pk-live-9');
    expect(JSON.stringify(diagnostic)).not.toContain('bob@example.test');
    repository.close();
  });
});
