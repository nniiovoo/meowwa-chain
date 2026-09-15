import { describe, expect, it, vi } from 'vitest';
import type { PaymentRequest } from '@meowwa/chain-domain';
import { paymentIntentForRequest } from '../adapters/wallet.js';
import { buildAgentSignerPolicy, policyDigest, BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import type { WalletControlBinding } from '../wallet-control/types.js';
import { PrivySandboxWalletAdapter } from './adapter.js';
import type { WalletExecutionProvider } from './provider.js';
import { WalletExecutionRepository } from './repository.js';

const now = new Date('2026-07-14T23:00:00.000Z');
const recipient = '0x1111111111111111111111111111111111111111';
const smartWalletAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    requestId: 'request_123', petId: 'pet_mochi', ownerId: 'owner_1', agentId: 'agent_mochi',
    mandateId: 'mandate_alpha', interpretationId: 'interpretation_1', interpretationVersion: 'interpretation-version-1',
    taxonomyVersion: 'v1', ownerConfirmationStatus: 'confirmed', need: 'hunger', category: 'PET_FOOD',
    merchantId: 'merchant_approved_1', productId: 'product_usual_food_1', quantity: 1, amountMinor: 1299,
    currency: 'USDC', chainId: 84532, recipient, contract: BASE_SEPOLIA_USDC,
    quoteId: 'quote_usual_food', quoteExpiresAt: '2026-07-14T23:30:00.000Z', taxMinor: 0,
    shippingMinor: 0, feesMinor: 0, evidenceRefs: ['evidence_1'], idempotencyKey: 'request-key-123',
    requestNonce: 'nonce_12345678', createdAt: now.toISOString(), emergencyMode: false,
    requestedApprovalMode: 'EVERY_REQUEST', policyVersion: 'v1', state: 'AUTHORIZED', approvedBy: 'owner_1',
    ...overrides,
  };
}

function binding(overrides: Partial<WalletControlBinding> = {}): WalletControlBinding {
  const policy = buildAgentSignerPolicy({
    ownerPrivyUserId: 'did:privy:owner_123', petId: 'pet_mochi', allowedRecipients: [recipient],
    perTransactionLimitAtomic: '20000000', validUntil: '2026-07-15T23:00:00.000Z',
  });
  return {
    bindingId: 'wcb_123', ownerId: 'owner_1', petId: 'pet_mochi', appWalletId: 'wallet_mochi',
    privyUserId: 'did:privy:owner_123', privyEmbeddedWalletId: 'embedded_123', smartWalletAddress,
    environment: 'sandbox', chainId: 84532, usdcContract: BASE_SEPOLIA_USDC, smartWalletType: 'embedded_hd',
    ownerType: 'privy_user', agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
    expectedPolicyDigest: policyDigest(policy), expectedPolicyJson: JSON.stringify(policy), status: 'active',
    signerStatus: 'attached', ownerEscapeStatus: 'unverified', provisioningVersion: 1,
    lastVerifiedAt: now.toISOString(), escapeVerifiedAt: null, failureCode: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 3,
    ...overrides,
  };
}

function setup(options: {
  verifiedBinding?: WalletControlBinding;
  provider?: WalletExecutionProvider;
  allowedRecipients?: string[];
} = {}) {
  const repository = new WalletExecutionRepository(':memory:', { now: () => now });
  const walletControl = { verify: vi.fn(async () => options.verifiedBinding ?? binding()) };
  const provider = options.provider ?? {
    submit: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', userOperationHash: `0x${'d'.repeat(64)}` as `0x${string}`,
      transactionHash: null,
    })),
  };
  const signer = { sign: vi.fn(async () => 'base64-der-signature') };
  const adapter = new PrivySandboxWalletAdapter({
    repository, walletControl, provider, signer, now: () => now,
    allowedRecipients: options.allowedRecipients ?? [recipient], maxBindingAgeMs: 60_000,
  });
  return { repository, walletControl, provider, signer, adapter };
}

describe('restricted Privy sandbox wallet adapter', () => {
  it('rejects a zero execution recipient before provider submission', () => {
    expect(() => setup({ allowedRecipients: ['0x0000000000000000000000000000000000000000'] })).toThrow('Invalid execution recipient');
  });

  it('reverifies, locally authorizes, persists, and submits exactly once', async () => {
    const harness = setup();
    const intent = paymentIntentForRequest(request());
    const first = await harness.adapter.submit(intent);
    const second = await harness.adapter.submit(intent);
    if (first.status !== 'pending') throw new Error('Expected a pending sandbox submission');
    expect(first).toEqual({ status: 'pending', submissionId: expect.stringMatching(/^mw_[a-f0-9]{61}$/) });
    expect(second).toEqual(first);
    expect(harness.walletControl.verify).toHaveBeenCalledTimes(2);
    expect(harness.walletControl.verify).toHaveBeenCalledWith('owner_1', 'pet_mochi');
    expect(harness.provider.submit).toHaveBeenCalledTimes(1);
    expect(harness.provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      embeddedWalletId: 'embedded_123', smartWalletAddress, caip2: 'eip155:84532',
      contract: BASE_SEPOLIA_USDC.toLowerCase(), referenceId: first.submissionId, sign: harness.signer.sign,
    }));
    expect(harness.repository.getByRequestId('request_123')).toMatchObject({
      status: 'submitted', providerTransactionId: 'privy_tx_123', sender: smartWalletAddress,
      recipient, amountAtomic: '12990000', referenceId: first.submissionId,
    });
    harness.repository.close();
  });

  it('never interprets a provider broadcast hash as settlement', async () => {
    const provider: WalletExecutionProvider = { submit: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', userOperationHash: null,
      transactionHash: `0x${'e'.repeat(64)}` as `0x${string}`,
    })) };
    const harness = setup({ provider });
    await expect(harness.adapter.submit(paymentIntentForRequest(request()))).resolves.toMatchObject({ status: 'pending' });
    expect(harness.repository.getByRequestId('request_123')).toMatchObject({
      status: 'submitted', transactionHash: `0x${'e'.repeat(64)}`, confirmedAt: null,
    });
    harness.repository.close();
  });

  it('replays an ambiguous provider exception with the same idempotent reference', async () => {
    const provider: WalletExecutionProvider = { submit: vi.fn()
      .mockRejectedValueOnce(new Error('sensitive transport detail'))
      .mockResolvedValueOnce({ providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null }) };
    const harness = setup({ provider });
    const intent = paymentIntentForRequest(request());
    await expect(harness.adapter.submit(intent)).resolves.toMatchObject({ status: 'pending' });
    await expect(harness.adapter.submit(intent)).resolves.toMatchObject({ status: 'pending' });
    expect(provider.submit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.submit).mock.calls[0]?.[0].referenceId)
      .toBe(vi.mocked(provider.submit).mock.calls[1]?.[0].referenceId);
    expect(harness.repository.getByRequestId('request_123')).toMatchObject({
      status: 'submitted', providerTransactionId: 'privy_tx_123',
    });
    harness.repository.close();
  });

  it('accepts a freshly verified recovered signer binding', async () => {
    const harness = setup({ verifiedBinding: binding({ status: 'recovered' }) });
    await expect(harness.adapter.submit(paymentIntentForRequest(request()))).resolves.toMatchObject({ status: 'pending' });
    expect(harness.provider.submit).toHaveBeenCalledOnce();
    harness.repository.close();
  });

  it.each([
    ['paused binding', binding({ status: 'paused' })],
    ['revoked signer', binding({ signerStatus: 'revoked', status: 'revoked' })],
    ['stale verification', binding({ lastVerifiedAt: '2026-07-14T22:58:59.000Z' })],
    ['missing wallet ID', binding({ privyEmbeddedWalletId: null })],
    ['missing wallet address', binding({ smartWalletAddress: null })],
    ['wrong owner', binding({ ownerId: 'owner_attacker' })],
  ])('denies %s before preparing or calling Privy', async (_label, verifiedBinding) => {
    const harness = setup({ verifiedBinding });
    await expect(harness.adapter.submit(paymentIntentForRequest(request()))).resolves.toMatchObject({ status: 'failed' });
    expect(harness.provider.submit).not.toHaveBeenCalled();
    expect(harness.repository.getByRequestId('request_123')).toBeUndefined();
    harness.repository.close();
  });

  it('denies server-allowlist, policy, amount, and explicit-approval mismatches before Privy', async () => {
    const wrongRecipientHarness = setup({ allowedRecipients: ['0x2222222222222222222222222222222222222222'] });
    await expect(wrongRecipientHarness.adapter.submit(paymentIntentForRequest(request()))).resolves.toMatchObject({ status: 'failed' });
    expect(wrongRecipientHarness.provider.submit).not.toHaveBeenCalled();
    wrongRecipientHarness.repository.close();

    const smallPolicy = buildAgentSignerPolicy({
      ownerPrivyUserId: 'did:privy:owner_123', petId: 'pet_mochi', allowedRecipients: [recipient],
      perTransactionLimitAtomic: '1000000', validUntil: '2026-07-15T23:00:00.000Z',
    });
    const policyHarness = setup({ verifiedBinding: binding({
      expectedPolicyDigest: policyDigest(smallPolicy), expectedPolicyJson: JSON.stringify(smallPolicy),
    }) });
    await expect(policyHarness.adapter.submit(paymentIntentForRequest(request()))).resolves.toMatchObject({ status: 'failed' });
    expect(policyHarness.provider.submit).not.toHaveBeenCalled();
    policyHarness.repository.close();

    const approvalHarness = setup();
    await expect(approvalHarness.adapter.submit(paymentIntentForRequest(request({ approvedBy: undefined })))).resolves.toMatchObject({ status: 'failed' });
    expect(approvalHarness.provider.submit).not.toHaveBeenCalled();
    approvalHarness.repository.close();
  });
});
