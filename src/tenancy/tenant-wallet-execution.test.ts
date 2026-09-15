import { describe, expect, it, vi } from 'vitest';
import type { PaymentRequest } from '@meowwa/chain-domain';
import { paymentIntentForRequest } from '../adapters/wallet.js';
import { BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import type { WalletControlAttestationProvider } from '../wallet-control/provider.js';
import type { WalletExecutionProvider } from '../wallet-execution/provider.js';
import type { TenantWalletBinding } from './financial-repository.js';
import {
  TenantWalletExecutionConflictError,
  TenantWalletExecutionService,
  type PrepareTenantWalletExecutionInput,
  type TenantWalletExecutionRepository,
  type TenantWalletExecutionSubmission,
} from './tenant-wallet-execution.js';

const now = new Date('2026-07-17T20:00:00.000Z');
const tenantId = '11111111-1111-4111-8111-111111111111';
const recipient = '0x1111111111111111111111111111111111111111';
const sender = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    requestId: 'request_123', petId: 'pet_mochi', ownerId: 'owner_1', agentId: 'agent_mochi',
    mandateId: 'mandate_alpha', interpretationId: 'interpretation_1', interpretationVersion: 'interpretation-version-1',
    taxonomyVersion: 'v1', ownerConfirmationStatus: 'confirmed', need: 'play_or_enrichment', category: 'TOYS_ENRICHMENT',
    merchantId: 'merchant_approved_1', productId: 'product_mouse_1', quantity: 1, amountMinor: 1299,
    currency: 'USDC', chainId: 84532, recipient, contract: BASE_SEPOLIA_USDC,
    quoteId: 'quote_mouse', quoteExpiresAt: '2026-07-17T20:30:00.000Z', taxMinor: 0,
    shippingMinor: 0, feesMinor: 0, evidenceRefs: ['evidence_1'], idempotencyKey: 'request-key-123',
    requestNonce: 'nonce_12345678', createdAt: now.toISOString(), emergencyMode: false,
    requestedApprovalMode: 'EVERY_REQUEST', policyVersion: 'v1', state: 'AUTHORIZED', approvedBy: 'owner_1',
    ...overrides,
  };
}

function binding(overrides: Partial<TenantWalletBinding> = {}): TenantWalletBinding {
  return {
    tenantId, walletId: 'wallet_mochi', petId: 'pet_mochi', provider: 'privy',
    privyEmbeddedWalletId: 'embedded_mochi', smartWalletAddress: sender,
    ownerQuorumId: 'quorum_owner_123',
    ownerPrivyUserId: 'did:privy:owner-fixture', agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
    revocationReason: null,
    policyDigest: 'a'.repeat(64), policyValidUntil: '2026-07-18T20:00:00.000Z',
    controlVerifiedAt: '2026-07-15T20:00:00.000Z', chainKey: 'base_sepolia', chainId: 84532, status: 'active',
    createdAt: '2026-07-15T20:00:00.000Z', updatedAt: '2026-07-15T20:00:00.000Z',
    ...overrides,
  };
}

class MemoryExecutionRepository implements TenantWalletExecutionRepository {
  submission: TenantWalletExecutionSubmission | undefined;

  constructor(readonly wallet: TenantWalletBinding) {}

  async getVerifiedBinding(): Promise<TenantWalletBinding> { return this.wallet; }

  async prepareExecution(input: PrepareTenantWalletExecutionInput): Promise<TenantWalletExecutionSubmission> {
    if (this.submission) {
      if (this.submission.requestId !== input.requestId || this.submission.intentHash !== input.intentHash ||
        this.submission.referenceId !== input.referenceId || this.submission.tenantId !== input.tenantId) {
        throw new TenantWalletExecutionConflictError();
      }
      return this.submission;
    }
    this.submission = {
      ...input, status: 'prepared', providerTransactionId: null, userOperationHash: null, transactionHash: null,
      blockHash: null, blockNumber: null, logIndex: null, failureCode: null, confirmedAt: null,
      applicationSettledAt: null,
      blindSubmitAttempts: 0,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 1,
    };
    return this.submission;
  }

  async markExecutionSubmitting(_tenantId: string, _submissionId: string, expectedVersion: number) {
    return this.transition(expectedVersion, 'submitting', {});
  }

  async markExecutionSubmitted(input: {
    tenantId: string; submissionId: string; expectedVersion: number; providerTransactionId: string;
    userOperationHash: `0x${string}` | null; transactionHash: `0x${string}` | null;
  }) {
    return this.transition(input.expectedVersion, 'submitted', {
      providerTransactionId: input.providerTransactionId,
      userOperationHash: input.userOperationHash,
      transactionHash: input.transactionHash,
      failureCode: null,
    });
  }

  async markExecutionUnknown(_tenantId: string, _submissionId: string, expectedVersion: number, reason: string) {
    return this.transition(expectedVersion, 'unknown', { failureCode: reason });
  }

  private transition(
    expectedVersion: number,
    status: TenantWalletExecutionSubmission['status'],
    changes: Partial<TenantWalletExecutionSubmission>,
  ): TenantWalletExecutionSubmission {
    if (!this.submission || this.submission.version !== expectedVersion) throw new TenantWalletExecutionConflictError();
    this.submission = { ...this.submission, ...changes, status, version: expectedVersion + 1 };
    return this.submission;
  }
}

function setup(options: {
  wallet?: TenantWalletBinding;
  attested?: boolean;
  provider?: WalletExecutionProvider;
} = {}) {
  const repository = new MemoryExecutionRepository(options.wallet ?? binding());
  const controlProvider: WalletControlAttestationProvider = {
    verifyAttestedControl: vi.fn(async () => options.attested ?? true),
  };
  const executionProvider = options.provider ?? {
    submit: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', userOperationHash: `0x${'d'.repeat(64)}` as `0x${string}`,
      transactionHash: null,
    })),
  };
  const signer = { sign: vi.fn(async () => 'base64-der-signature') };
  const service = new TenantWalletExecutionService({
    repository, controlProvider, executionProvider, signer, agentSignerId: 'quorum_agent_123',
    allowedRecipients: [recipient], perTransactionLimitAtomic: '20000000', now: () => now,
  });
  return { repository, controlProvider, executionProvider, signer, service };
}

describe('tenant restricted Privy wallet execution', () => {
  it('rechecks the user-only owner quorum and exact policy on every request but submits once', async () => {
    const harness = setup();
    const payment = paymentIntentForRequest(request());
    const first = await harness.service.submit({ tenantId, ownerSubject: 'owner_1', payment });
    const second = await harness.service.submit({ tenantId, ownerSubject: 'owner_1', payment });

    expect(first).toEqual({ status: 'pending', submissionId: expect.stringMatching(/^mw_[0-9a-f]{61}$/) });
    expect(second).toEqual(first);
    expect(harness.controlProvider.verifyAttestedControl).toHaveBeenCalledTimes(2);
    expect(harness.controlProvider.verifyAttestedControl).toHaveBeenCalledWith(expect.objectContaining({
      embeddedWalletId: 'embedded_mochi', smartWalletAddress: sender, ownerResourceId: 'quorum_owner_123',
      agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
    }));
    expect(harness.executionProvider.submit).toHaveBeenCalledTimes(1);
    expect(harness.executionProvider.submit).toHaveBeenCalledWith(expect.objectContaining({
      embeddedWalletId: 'embedded_mochi', smartWalletAddress: sender, caip2: 'eip155:84532',
      contract: BASE_SEPOLIA_USDC.toLowerCase(), referenceId: first.status === 'pending' ? first.submissionId : '',
      sign: harness.signer.sign,
    }));
    expect(harness.repository.submission).toMatchObject({
      tenantId, ownerSubject: 'owner_1', status: 'submitted', providerTransactionId: 'privy_tx_123',
      sender, recipient, amountAtomic: '12990000', controlVerifiedAt: '2026-07-15T20:00:00.000Z',
    });
  });

  it.each([
    ['wrong tenant', { tenantId: '22222222-2222-4222-8222-222222222222', ownerSubject: 'owner_1' }],
    ['wrong owner', { tenantId, ownerSubject: 'owner_attacker' }],
  ])('denies a %s identity before control or provider access', async (_label, override) => {
    const harness = setup();
    const result = await harness.service.submit({
      tenantId: override.tenantId,
      ownerSubject: override.ownerSubject,
      payment: paymentIntentForRequest(request()),
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(harness.controlProvider.verifyAttestedControl).not.toHaveBeenCalled();
    expect(harness.executionProvider.submit).not.toHaveBeenCalled();
  });

  it('denies a tampered intent and live quorum or policy drift before provider submission', async () => {
    const tampered = setup();
    const payment = paymentIntentForRequest(request());
    await expect(tampered.service.submit({
      tenantId, ownerSubject: 'owner_1', payment: { ...payment, amountMinor: payment.amountMinor + 1 },
    })).resolves.toEqual({ status: 'failed', reason: 'EXECUTION_IDENTITY_DENIED' });
    expect(tampered.controlProvider.verifyAttestedControl).not.toHaveBeenCalled();

    const drifted = setup({ attested: false });
    await expect(drifted.service.submit({ tenantId, ownerSubject: 'owner_1', payment }))
      .resolves.toEqual({ status: 'failed', reason: 'WALLET_CONTROL_UNVERIFIED' });
    expect(drifted.executionProvider.submit).not.toHaveBeenCalled();
    expect(drifted.repository.submission).toBeUndefined();
  });

  it('attests against the provisioning owner and fails closed when the binding has no identity', async () => {
    const harness = setup();
    await expect(harness.service.submit({
      tenantId, ownerSubject: 'owner_1', payment: paymentIntentForRequest(request()),
    })).resolves.toMatchObject({ status: 'pending' });
    // The owner the wallet was provisioned for, not a placeholder: this is what makes the quorum
    // check mean anything.
    expect(harness.controlProvider.verifyAttestedControl).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPrivyUserId: 'did:privy:owner-fixture',
        // The digest is rebuilt from this policy, so the owner in it must be the real one too --
        // a placeholder here would compare against a policy no owner ever agreed to.
        expectedPolicy: expect.objectContaining({ owner: { user_id: 'did:privy:owner-fixture' } }),
      }),
    );

    const unidentified = setup({ wallet: binding({ ownerPrivyUserId: null }) });
    await expect(unidentified.service.submit({
      tenantId, ownerSubject: 'owner_1', payment: paymentIntentForRequest(request()),
    })).resolves.toEqual({ status: 'failed', reason: 'WALLET_CONTROL_UNVERIFIED' });
    expect(unidentified.controlProvider.verifyAttestedControl).not.toHaveBeenCalled();
    expect(unidentified.executionProvider.submit).not.toHaveBeenCalled();
  });

  it('accepts an older stored attestation because a fresh provider attestation is mandatory', async () => {
    const harness = setup({ wallet: binding({ controlVerifiedAt: '2026-01-01T00:00:00.000Z' }) });
    await expect(harness.service.submit({
      tenantId, ownerSubject: 'owner_1', payment: paymentIntentForRequest(request()),
    })).resolves.toMatchObject({ status: 'pending' });
    expect(harness.controlProvider.verifyAttestedControl).toHaveBeenCalledOnce();
    expect(harness.executionProvider.submit).toHaveBeenCalledOnce();
  });

  it('keeps new outgoing execution disabled while a wallet policy rotation is provisioning', async () => {
    const harness = setup({ wallet: binding({ status: 'provisioning' }) });
    await expect(harness.service.submit({
      tenantId, ownerSubject: 'owner_1', payment: paymentIntentForRequest(request()),
    })).resolves.toEqual({ status: 'failed', reason: 'WALLET_CONTROL_UNVERIFIED' });
    expect(harness.controlProvider.verifyAttestedControl).not.toHaveBeenCalled();
    expect(harness.executionProvider.submit).not.toHaveBeenCalled();
    expect(harness.repository.submission).toBeUndefined();
  });

  it('replays an ambiguous provider result with the same idempotent reference', async () => {
    const provider: WalletExecutionProvider = { submit: vi.fn()
      .mockRejectedValueOnce(new Error('sensitive detail'))
      .mockResolvedValueOnce({ providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null }) };
    const harness = setup({ provider });
    const payment = paymentIntentForRequest(request());
    await expect(harness.service.submit({ tenantId, ownerSubject: 'owner_1', payment })).resolves.toMatchObject({ status: 'pending' });
    await expect(harness.service.submit({ tenantId, ownerSubject: 'owner_1', payment })).resolves.toMatchObject({ status: 'pending' });
    expect(provider.submit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.submit).mock.calls[0]?.[0].referenceId)
      .toBe(vi.mocked(provider.submit).mock.calls[1]?.[0].referenceId);
    expect(harness.repository.submission).toMatchObject({
      status: 'submitted', providerTransactionId: 'privy_tx_123', failureCode: null,
    });
    expect(harness.controlProvider.verifyAttestedControl).toHaveBeenCalledTimes(2);
  });
});
