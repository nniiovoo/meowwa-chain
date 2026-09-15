import { describe, expect, it, vi } from 'vitest';
import { CHAINS } from '@meowwa/chain-domain';
import { buildAgentSignerPolicy } from '../wallet-control/policy.js';
import type { WalletControlProviderInspection } from '../wallet-control/provider.js';
import type { TenantWalletBinding } from './financial-repository.js';
import { TenantSignerRevocationVerifier, type TenantRevocationRepository } from './tenant-signer-revocation.js';

const now = new Date('2026-07-20T12:00:00.000Z');
const tenantId = '11111111-1111-4111-8111-111111111111';
const agentSignerId = 'quorum_agent_123';
const recipient = '0x1111111111111111111111111111111111111111';
const solanaAddress = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const solanaRecipient = 'So11111111111111111111111111111111111111112';

function binding(overrides: Partial<TenantWalletBinding> = {}): TenantWalletBinding {
  return {
    tenantId, walletId: 'wallet_mochi', petId: 'pet_mochi', provider: 'privy',
    privyEmbeddedWalletId: 'embedded_mochi',
    smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ownerQuorumId: 'quorum_owner_123', ownerPrivyUserId: 'did:privy:owner-fixture',
    revocationReason: null,
    agentSignerId, agentPolicyId: 'policy_123', policyDigest: 'a'.repeat(64),
    policyValidUntil: '2026-08-18T12:00:00.000Z', controlVerifiedAt: '2026-07-19T12:00:00.000Z',
    chainKey: 'base_sepolia', chainId: 84532, status: 'active',
    createdAt: '2026-07-19T12:00:00.000Z', updatedAt: '2026-07-19T12:00:00.000Z',
    ...overrides,
  };
}

function inspection(agentSigners: Array<{ signerId: string; overridePolicyIds: string[] }>): WalletControlProviderInspection {
  return {
    privyUserId: 'did:privy:owner-fixture',
    embeddedWalletId: 'embedded_mochi',
    smartWalletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    smartWalletType: 'embedded_hd',
    userLinked: true,
    ownerResourceId: 'quorum_owner_123',
    agentSigners,
    policy: { policyId: 'policy_123', digest: 'a'.repeat(64), matchesExpected: true, ownerType: 'privy_user' },
  } as WalletControlProviderInspection;
}

function solanaBinding(overrides: Partial<TenantWalletBinding> = {}): TenantWalletBinding {
  return binding({
    walletId: 'wallet_mochi_solana', privyEmbeddedWalletId: 'embedded_mochi_solana',
    smartWalletAddress: solanaAddress, chainKey: 'solana_devnet', chainId: null, ...overrides,
  });
}

function setup(options: {
  wallet?: TenantWalletBinding;
  signers?: Array<{ signerId: string; overridePolicyIds: string[] }>;
  solana?: boolean;
} = {}) {
  const recorded: Array<Parameters<TenantRevocationRepository['recordBindingRevocation']>[0]> = [];
  const repository: TenantRevocationRepository = {
    getVerifiedBinding: vi.fn(async () => options.wallet ?? binding()),
    recordBindingRevocation: vi.fn(async (input) => {
      recorded.push(input);
      return binding({ status: input.status, revocationReason: input.reason });
    }),
  };
  const provider = { inspectBinding: vi.fn(async () => inspection(options.signers ?? [])) };
  const solanaProvider = { inspectBinding: vi.fn(async () => inspection(options.signers ?? [])) };
  const verifier = new TenantSignerRevocationVerifier({
    repository, provider, agentSignerId,
    allowedRecipients: [recipient],
    perTransactionLimitAtomic: '20000000',
    ...(options.solana ? { families: { solana_devnet: { provider: solanaProvider, allowedRecipients: [solanaRecipient] } } } : {}),
    now: () => now,
  });
  return { repository, provider, solanaProvider, verifier, recorded };
}

describe('tenant signer revocation verification', () => {
  it('records a revocation only after the provider confirms the signer is gone', async () => {
    const harness = setup({ signers: [] });

    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi' })).resolves.toEqual({
      status: 'revoked', reason: 'owner-authorized-detachment-verified',
    });
    expect(harness.provider.inspectBinding).toHaveBeenCalledOnce();
    expect(harness.recorded).toEqual([expect.objectContaining({
      tenantId, petId: 'pet_mochi', expectedWalletId: 'wallet_mochi', status: 'revoked',
    })]);
    // A Base request reads the Base Sepolia binding and rebuilds the same policy it always did.
    expect(harness.repository.getVerifiedBinding).toHaveBeenCalledWith(tenantId, 'pet_mochi', 'base_sepolia');
    expect(harness.provider.inspectBinding).toHaveBeenCalledWith(expect.objectContaining({
      expectedPolicy: buildAgentSignerPolicy({
        ownerPrivyUserId: 'did:privy:owner-fixture', petId: 'pet_mochi', allowedRecipients: [recipient],
        perTransactionLimitAtomic: '20000000', validUntil: '2026-08-18T12:00:00.000Z',
      }),
    }));
  });

  it('rebuilds the expected policy for the binding\'s own chain and inspects with that family\'s provider', async () => {
    const harness = setup({ wallet: solanaBinding(), signers: [], solana: true });

    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi', chain: 'solana_devnet' })).resolves.toEqual({
      status: 'revoked', reason: 'owner-authorized-detachment-verified',
    });
    expect(harness.repository.getVerifiedBinding).toHaveBeenCalledWith(tenantId, 'pet_mochi', 'solana_devnet');
    expect(harness.provider.inspectBinding).not.toHaveBeenCalled();
    expect(harness.solanaProvider.inspectBinding).toHaveBeenCalledOnce();
    const expectedPolicy = buildAgentSignerPolicy({
      ownerPrivyUserId: 'did:privy:owner-fixture', petId: 'pet_mochi', allowedRecipients: [solanaRecipient],
      perTransactionLimitAtomic: '20000000', validUntil: '2026-08-18T12:00:00.000Z',
    }, CHAINS.solana_devnet);
    expect(harness.solanaProvider.inspectBinding).toHaveBeenCalledWith({
      privyUserId: 'did:privy:owner-fixture', embeddedWalletId: 'embedded_mochi_solana',
      smartWalletAddress: solanaAddress, agentPolicyId: 'policy_123', expectedPolicy,
    });
    expect(expectedPolicy).toMatchObject({ chain_type: 'solana' });
    expect(expectedPolicy.rules[0]?.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'source.chain', value: 'solana_devnet' }),
      expect.objectContaining({ field: 'destination.address', value: [solanaRecipient] }),
    ]));
    expect(harness.recorded).toEqual([expect.objectContaining({ expectedWalletId: 'wallet_mochi_solana', status: 'revoked' })]);
  });

  it('refuses to verify a Solana binding when the workload has no Solana control provider', async () => {
    // Inspecting with the Base provider would rebuild a Base Sepolia policy that can never match, so
    // every Solana revocation would be recorded as tampered. Fail closed instead.
    const harness = setup({ wallet: solanaBinding(), signers: [] });

    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi', chain: 'solana_devnet' }))
      .rejects.toThrow('cannot be verified on Solana Devnet');
    expect(harness.provider.inspectBinding).not.toHaveBeenCalled();
    expect(harness.recorded).toEqual([]);
  });

  it('refuses a binding the repository returns on a chain other than the one asked for', async () => {
    const harness = setup({ wallet: solanaBinding(), signers: [], solana: true });
    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi' })).rejects.toThrow('another chain');
    expect(harness.recorded).toEqual([]);
  });

  it('refuses to call it revoked while the agent signer is still attached', async () => {
    // The defect this exists to prevent: telling an owner their signer is gone when it is not.
    const harness = setup({ signers: [{ signerId: agentSignerId, overridePolicyIds: ['policy_123'] }] });

    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi' })).resolves.toEqual({
      status: 'drifted', reason: 'agent-signer-still-attached',
    });
    expect(harness.recorded[0]).toMatchObject({ status: 'drifted' });
  });

  it('treats an unexpected remaining signer as drift rather than a clean revocation', async () => {
    const harness = setup({ signers: [{ signerId: 'signer_someone_else', overridePolicyIds: [] }] });

    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi' })).resolves.toEqual({
      status: 'drifted', reason: 'unexpected-additional-signer',
    });
  });

  it('refuses to verify a binding with no provisioning owner identity', async () => {
    // Nothing to inspect against, so recording any outcome would be a guess.
    const harness = setup({ wallet: binding({ ownerPrivyUserId: null }) });

    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi' })).rejects.toThrow(/cannot be verified/i);
    expect(harness.provider.inspectBinding).not.toHaveBeenCalled();
    expect(harness.recorded).toEqual([]);
  });

  it('is idempotent once an outcome is already recorded', async () => {
    const harness = setup({ wallet: binding({ status: 'revoked', revocationReason: 'owner-authorized-detachment-verified' }) });

    await expect(harness.verifier.verify({ tenantId, petId: 'pet_mochi' })).resolves.toEqual({
      status: 'revoked', reason: 'owner-authorized-detachment-verified',
    });
    expect(harness.provider.inspectBinding).not.toHaveBeenCalled();
    expect(harness.recorded).toEqual([]);
  });
});
