import { describe, expect, it, vi } from 'vitest';
import type { PrivyClient } from '@privy-io/node';
import { buildAgentSignerPolicy, policyDigest } from './policy.js';
import {
  createPrivyWalletControlApi,
  PrivyWalletControlProvider,
  type PrivyWalletControlApi,
} from './privy-provider.js';

const expectedPolicy = buildAgentSignerPolicy({
  ownerPrivyUserId: 'did:privy:owner_123', petId: 'pet_mochi',
  allowedRecipients: ['0x1111111111111111111111111111111111111111'],
  perTransactionLimitAtomic: '25000000', validUntil: '2026-07-15T12:00:00.000Z',
});

function embedded(id = 'embedded_123', address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  return { type: 'wallet', chain_type: 'ethereum', connector_type: 'embedded', wallet_client: 'privy', id, address };
}

function safe(address = '0x2222222222222222222222222222222222222222') {
  return { type: 'smart_wallet', smart_wallet_type: 'safe', address };
}

function policyRecord(overrides: Record<string, unknown> = {}) {
  return { id: 'policy_123', owner_id: null, ...expectedPolicy, owner: undefined, ...overrides };
}

function api(overrides: Partial<PrivyWalletControlApi> = {}): PrivyWalletControlApi {
  return {
    createPolicy: vi.fn(async () => policyRecord()),
    getPolicy: vi.fn(async () => policyRecord()),
    getUser: vi.fn(async () => ({ id: 'did:privy:owner_123', linked_accounts: [embedded(), safe()] })),
    pregenerateWallets: vi.fn(async () => ({ id: 'did:privy:owner_123', linked_accounts: [embedded(), safe()] })),
    listWalletsByExternalId: vi.fn(async () => []),
    updateWalletAdditionalSigner: vi.fn(async () => undefined),
    getWallet: vi.fn(async () => ({
      id: 'embedded_123', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain_type: 'ethereum', owner_id: null,
      additional_signers: [{ signer_id: 'quorum_agent_123', override_policy_ids: ['policy_123'] }],
    })),
    getKeyQuorum: vi.fn(async (id) => ({
      id, authorization_keys: [{}], authorization_threshold: 1, user_ids: [], key_quorum_ids: [],
    })),
    ...overrides,
  };
}

describe('Privy wallet control provider', () => {
  it('sends the policy idempotency key through the SDK header parameter', async () => {
    // Parameter kept for call typing; marked used locally rather than widening the lint policy.
    const create = vi.fn(async (input: unknown) => { void input; return policyRecord(); });
    const client = {
      policies: () => ({ create }),
    } as unknown as PrivyClient;
    const adapter = createPrivyWalletControlApi(client);

    await adapter.createPolicy(expectedPolicy, 'meowwa-policy-request-123');

    expect(create).toHaveBeenCalledWith({
      ...expectedPolicy,
      'privy-idempotency-key': 'meowwa-policy-request-123',
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('idempotency_key');
  });

  it('creates the exact user-owned policy with a deterministic idempotency key', async () => {
    const client = api({ getUser: vi.fn(async () => ({ id: 'did:privy:owner_123', linked_accounts: [embedded()] })) });
    const provider = new PrivyWalletControlProvider(client);
    const created = await provider.createUserOwnedPolicy({
      privyUserId: 'did:privy:owner_123', policy: expectedPolicy, idempotencyKey: 'meowwa_policy_123',
    });
    expect(client.createPolicy).toHaveBeenCalledWith(expectedPolicy, 'meowwa_policy_123');
    expect(created).toEqual({ policyId: 'policy_123', digest: policyDigest(expectedPolicy), ownerType: 'privy_user' });
  });

  it('refuses a provider policy whose rules or owner changed', async () => {
    const changedRules = structuredClone(expectedPolicy.rules);
    changedRules[0]!.conditions[0]!.value = '8453';
    const noSafe = { getUser: vi.fn(async () => ({ id: 'did:privy:owner_123', linked_accounts: [embedded()] })) };
    const changed = new PrivyWalletControlProvider(api({ ...noSafe, createPolicy: vi.fn(async () => policyRecord({ rules: changedRules })) }));
    await expect(changed.createUserOwnedPolicy({
      privyUserId: 'did:privy:owner_123', policy: expectedPolicy, idempotencyKey: 'key_123',
    })).rejects.toThrow('Policy returned by Privy does not match');

    const keyOwned = new PrivyWalletControlProvider(api({ ...noSafe, createPolicy: vi.fn(async () => policyRecord({ owner_id: 'quorum_owner' })) }));
    await expect(keyOwned.createUserOwnedPolicy({
      privyUserId: 'did:privy:owner_123', policy: expectedPolicy, idempotencyKey: 'key_123',
    })).rejects.toThrow('Policy returned by Privy is not user-owned');
  });

  it('allows an HD-wallet policy when the Privy user already owns a Safe', async () => {
    const client = api();
    const provider = new PrivyWalletControlProvider(client);
    await expect(provider.createUserOwnedPolicy({
      privyUserId: 'did:privy:owner_123', policy: expectedPolicy, idempotencyKey: 'key_existing_safe',
    })).resolves.toMatchObject({ policyId: 'policy_123' });
    expect(client.createPolicy).toHaveBeenCalledOnce();
  });

  it('accepts Privy user ownership represented by a user-only 1-of-1 quorum', async () => {
    const owner_id = 'quorum_user_owner';
    const client = api({
      createPolicy: vi.fn(async () => policyRecord({ owner_id })),
      getPolicy: vi.fn(async () => policyRecord({ owner_id })),
      getWallet: vi.fn(async () => ({
        id: 'embedded_123', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain_type: 'ethereum', owner_id,
        additional_signers: [{ signer_id: 'quorum_agent_123', override_policy_ids: ['policy_123'] }],
      })),
      getKeyQuorum: vi.fn(async (id) => ({
        id, authorization_keys: [], authorization_threshold: 1,
        user_ids: ['did:privy:owner_123'], key_quorum_ids: [],
      })),
    });
    const provider = new PrivyWalletControlProvider(client);

    await expect(provider.createUserOwnedPolicy({
      privyUserId: 'did:privy:owner_123', policy: expectedPolicy, idempotencyKey: 'key_user_quorum',
    })).resolves.toMatchObject({ ownerType: 'privy_user' });
    await expect(provider.inspectBinding({
      privyUserId: 'did:privy:owner_123', embeddedWalletId: 'embedded_123',
      smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentPolicyId: 'policy_123', expectedPolicy,
    })).resolves.toMatchObject({
      userLinked: true, ownerResourceId: owner_id,
      policy: { ownerType: 'privy_user', ownerResourceId: owner_id },
    });
    const attestation = {
      embeddedWalletId: 'embedded_123', smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerResourceId: owner_id, agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123', expectedPolicy,
    };
    await expect(provider.verifyAttestedControl({
      ...attestation, expectedPrivyUserId: 'did:privy:owner_123',
    })).resolves.toBe(true);

    // The quorum's sole member can be swapped after provisioning while the wallet and policy
    // owner_id stay identical, so shape alone must never attest ownership.
    await expect(provider.verifyAttestedControl({
      ...attestation, expectedPrivyUserId: 'did:privy:attacker',
    })).resolves.toBe(false);

    // No expected identity means nothing to compare against: fail closed.
    await expect(provider.verifyAttestedControl({
      ...attestation, expectedPrivyUserId: null,
    })).resolves.toBe(false);
  });

  it('reports a provisioning remnant only when a wallet exists for the external ID', async () => {
    const absent = new PrivyWalletControlProvider(api());
    await expect(absent.findProvisionedWallet({ externalId: 'meowwa_control_abc' })).resolves.toBeUndefined();

    const client = api({ listWalletsByExternalId: vi.fn(async () => [{ id: 'embedded_123', external_id: 'meowwa_control_abc' }]) });
    const present = new PrivyWalletControlProvider(client);
    await expect(present.findProvisionedWallet({ externalId: 'meowwa_control_abc' })).resolves.toEqual({
      embeddedWalletId: 'embedded_123',
      smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerResourceId: null,
      agentSigners: [{ signerId: 'quorum_agent_123', overridePolicyIds: ['policy_123'] }],
    });
    expect(client.getWallet).toHaveBeenCalledWith('embedded_123');
  });

  it('pregenerates one embedded HD wallet with only the policy-bound agent signer', async () => {
    const before = { id: 'did:privy:owner_123', linked_accounts: [embedded('embedded_existing'), safe()] };
    const after = { id: 'did:privy:owner_123', linked_accounts: [
      ...before.linked_accounts,
      embedded('embedded_123', '0x2222222222222222222222222222222222222222'),
    ] };
    const client = api({
      getUser: vi.fn(async () => before),
      pregenerateWallets: vi.fn(async () => after),
    });
    const provider = new PrivyWalletControlProvider(client);
    await expect(provider.provisionUserWallet({
      privyUserId: 'did:privy:owner_123', externalId: 'meowwa_control_123',
      agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123', idempotencyKey: 'meowwa_wallet_123',
    })).resolves.toEqual({ embeddedWalletId: 'embedded_123', smartWalletAddress: '0x2222222222222222222222222222222222222222' });
    expect(client.pregenerateWallets).toHaveBeenCalledWith('did:privy:owner_123', {
      wallets: [{
        chain_type: 'ethereum', external_id: 'meowwa_control_123',
        additional_signers: [{ signer_id: 'quorum_agent_123', override_policy_ids: ['policy_123'] }],
      }],
    }, 'meowwa_wallet_123');
  });

  it('uses the fresh owner JWT to replace an embedded wallet signer policy', async () => {
    const client = api();
    const provider = new PrivyWalletControlProvider(client);
    await expect(provider.rotateUserWalletPolicy({
      privyUserId: 'did:privy:owner_123',
      authorizationToken: 'fresh-owner-jwt',
      embeddedWalletId: 'embedded_123',
      agentSignerId: 'quorum_agent_123',
      agentPolicyId: 'policy_rotated',
    })).resolves.toBeUndefined();
    expect(client.updateWalletAdditionalSigner).toHaveBeenCalledWith('embedded_123', {
      signerId: 'quorum_agent_123', policyId: 'policy_rotated', authorizationToken: 'fresh-owner-jwt',
    });
  });

  it('provisions an additional embedded HD wallet when the user already owns a Safe', async () => {
    const before = { id: 'did:privy:owner_123', linked_accounts: [embedded('embedded_existing'), safe()] };
    const client = api({
      getUser: vi.fn(async () => before),
      pregenerateWallets: vi.fn(async () => ({
        ...before,
        linked_accounts: [...before.linked_accounts, embedded('embedded_pet', '0x3333333333333333333333333333333333333333')],
      })),
    });
    const provider = new PrivyWalletControlProvider(client);
    await expect(provider.provisionUserWallet({
      privyUserId: 'did:privy:owner_123', externalId: 'meowwa_control_123',
      agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123', idempotencyKey: 'meowwa_wallet_123',
    })).resolves.toEqual({
      embeddedWalletId: 'embedded_pet', smartWalletAddress: '0x3333333333333333333333333333333333333333',
    });
    expect(client.pregenerateWallets).toHaveBeenCalledOnce();
  });

  it('inspects user linkage, HD type, exact signer override, and policy drift', async () => {
    const provider = new PrivyWalletControlProvider(api());
    const inspection = await provider.inspectBinding({
      privyUserId: 'did:privy:owner_123', embeddedWalletId: 'embedded_123',
      smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentPolicyId: 'policy_123',
      expectedPolicy,
    });
    expect(inspection).toEqual({
      privyUserId: 'did:privy:owner_123', embeddedWalletId: 'embedded_123',
      smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', smartWalletType: 'embedded_hd', userLinked: true,
      ownerResourceId: null,
      agentSigners: [{ signerId: 'quorum_agent_123', overridePolicyIds: ['policy_123'] }],
      policy: {
        policyId: 'policy_123', digest: policyDigest(expectedPolicy), ownerType: 'privy_user', ownerResourceId: null,
      },
    });
  });

  it('retries a recently pregenerated wallet until it appears on the user', async () => {
    const getUser = vi.fn()
      .mockResolvedValueOnce({ id: 'did:privy:owner_123', linked_accounts: [] })
      .mockResolvedValue({ id: 'did:privy:owner_123', linked_accounts: [embedded()] });
    const provider = new PrivyWalletControlProvider(api({ getUser }));

    await expect(provider.inspectBinding({
      privyUserId: 'did:privy:owner_123', embeddedWalletId: 'embedded_123',
      smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentPolicyId: 'policy_123', expectedPolicy,
    })).resolves.toMatchObject({ userLinked: true });
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong wallet owner', { owner_id: 'key_quorum_123' }],
    ['wrong wallet chain', { chain_type: 'solana' }],
    ['wallet address mismatch', { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
  ])('marks %s as not user-linked', async (_label, walletOverride) => {
    const provider = new PrivyWalletControlProvider(api({
      getWallet: vi.fn(async () => ({
        id: 'embedded_123', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain_type: 'ethereum', owner_id: null,
        additional_signers: [{ signer_id: 'quorum_agent_123', override_policy_ids: ['policy_123'] }],
        ...walletOverride,
      })),
    }));
    const inspection = await provider.inspectBinding({
      privyUserId: 'did:privy:owner_123', embeddedWalletId: 'embedded_123',
      smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agentPolicyId: 'policy_123', expectedPolicy,
    });
    expect(inspection.userLinked).toBe(false);
  });

});
