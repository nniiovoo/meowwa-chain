import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeFunctionData } from 'viem';
import type { PaymentRequest } from '@meowwa/chain-domain';
import { paymentIntentForRequest } from '../adapters/wallet.js';
import { BASE_SEPOLIA_USDC, ERC20_TRANSFER_ABI } from '../wallet-control/policy.js';
import { buildSandboxTransferIntent, minorToUsdcAtomic } from './intent.js';

function approvedRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    requestId: 'request_123', petId: 'pet_mochi', ownerId: 'owner_1', agentId: 'agent_mochi',
    mandateId: 'mandate_alpha', interpretationId: 'interpretation_1', interpretationVersion: 'cat-model-alpha',
    taxonomyVersion: 'v1', ownerConfirmationStatus: 'confirmed', need: 'hunger', category: 'PET_FOOD',
    merchantId: 'merchant_approved_1', productId: 'product_usual_food_1', quantity: 1, amountMinor: 1299,
    currency: 'USDC', chainId: 84532, recipient: '0x1111111111111111111111111111111111111111',
    contract: BASE_SEPOLIA_USDC, quoteId: 'quote_usual_food', quoteExpiresAt: '2026-07-14T23:30:00.000Z',
    taxMinor: 0, shippingMinor: 0, feesMinor: 0, evidenceRefs: ['evidence_1'], idempotencyKey: 'request-key-123',
    requestNonce: 'nonce_12345678', createdAt: '2026-07-14T23:00:00.000Z', emergencyMode: false,
    requestedApprovalMode: 'EVERY_REQUEST', policyVersion: 'v1', state: 'AUTHORIZED', approvedBy: 'owner_1',
    ...overrides,
  };
}

describe('canonical Base Sepolia sandbox transfer intent', () => {
  it('converts two-decimal quote units to six-decimal USDC atomic units exactly', () => {
    expect(minorToUsdcAtomic(1)).toBe('10000');
    expect(minorToUsdcAtomic(1299)).toBe('12990000');
    expect(() => minorToUsdcAtomic(0)).toThrow('positive');
    expect(() => minorToUsdcAtomic(Number.MAX_SAFE_INTEGER)).toThrow('safe');
  });

  it('binds approval and policy fields into a deterministic intent and reference', () => {
    const payment = paymentIntentForRequest(approvedRequest());
    const now = new Date('2026-07-14T23:00:00.000Z');
    const transfer = buildSandboxTransferIntent(payment, now);
    const expectedData = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: ['0x1111111111111111111111111111111111111111', 12_990_000n],
    });

    expect(payment).toMatchObject({
      approvedBy: 'owner_1', policyVersion: 'v1', quoteExpiresAt: '2026-07-14T23:30:00.000Z',
      requestedApprovalMode: 'EVERY_REQUEST',
    });
    expect(transfer).toEqual(expect.objectContaining({
      requestId: 'request_123', ownerId: 'owner_1', petId: 'pet_mochi',
      chainId: 84532, caip2: 'eip155:84532', smartWalletAddress: null,
      usdcContract: BASE_SEPOLIA_USDC.toLowerCase(),
      recipient: '0x1111111111111111111111111111111111111111', amountAtomic: '12990000',
      valueAtomic: '0', calldata: expectedData,
      referenceId: expect.stringMatching(/^mw_[a-f0-9]{61}$/),
      intentHash: payment.intentHash,
    }));
    expect(transfer.referenceId).toHaveLength(64);
    expect(buildSandboxTransferIntent(payment, now)).toEqual(transfer);
    expect(transfer.referenceId).toBe(`mw_${createHash('sha256')
      .update(`meowwa:base-sepolia:${payment.intentHash}`).digest('hex').slice(0, 61)}`);
    const tenantReference = buildSandboxTransferIntent(payment, now, '11111111-1111-4111-8111-111111111111').referenceId;
    expect(tenantReference).toMatch(/^mw_[a-f0-9]{61}$/);
    expect(tenantReference).not.toBe(transfer.referenceId);
  });

  it.each([
    ['missing approval', { approvedBy: undefined }],
    ['limited autonomy', { requestedApprovalMode: 'LIMITED_AUTONOMY' }],
    ['wrong chain', { chainId: 8453 }],
    ['wrong contract', { contract: '0x2222222222222222222222222222222222222222' }],
    ['zero recipient', { recipient: '0x0000000000000000000000000000000000000000' }],
    ['expired quote', { quoteExpiresAt: '2026-07-14T22:59:59.000Z' }],
  ])('rejects %s before encoding', (_label, overrides) => {
    const request = approvedRequest(overrides as Partial<PaymentRequest>);
    expect(() => buildSandboxTransferIntent(paymentIntentForRequest(request), new Date('2026-07-14T23:00:00.000Z'))).toThrow();
  });
});
