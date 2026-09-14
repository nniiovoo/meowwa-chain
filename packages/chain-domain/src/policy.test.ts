import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_USDC_CONTRACT, BudgetLedger, evaluatePolicy, UNLIMITED_TRANSACTIONS, type PolicyInput } from './index.js';

function validInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    authenticated: true,
    sourceVerified: true,
    now: '2026-07-10T12:00:00.000Z',
    ownerId: 'owner_1',
    petId: 'pet_mochi',
    requestOwnerId: 'owner_1',
    requestPetId: 'pet_mochi',
    interpretationConfirmed: true,
    interpretationValid: true,
    need: 'hunger',
    category: 'PET_FOOD',
    merchantId: 'merchant_approved_1',
    productId: 'product_usual_food_1',
    token: 'USDC',
    chainId: 84532,
    recipient: '0x1111111111111111111111111111111111111111',
    contract: BASE_SEPOLIA_USDC_CONTRACT,
    amountMinor: 1299,
    walletBalanceMinor: 4200,
    quoteAmountMinor: 1299,
    quoteExpiresAt: '2026-07-10T12:05:00.000Z',
    quoteVerified: true,
    substitution: false,
    emergencyMode: false,
    replayDetected: false,
    anomalyDetected: false,
    policyVersion: 'v1',
    requestPolicyVersion: 'v1',
    mandate: {
      status: 'ACTIVE', signatureVerified: true, nonceValid: true,
      validFrom: '2026-07-10T00:00:00.000Z', validUntil: '2026-08-09T00:00:00.000Z',
      allowedNeeds: ['hunger'], allowedCategories: ['PET_FOOD'],
      allowedMerchantIds: ['merchant_approved_1'], allowedProductIds: ['product_usual_food_1'],
      token: 'USDC', chainId: 84532,
      recipients: ['0x1111111111111111111111111111111111111111'],
      contracts: [BASE_SEPOLIA_USDC_CONTRACT],
      perTransactionLimitMinor: 2000, periodLimitMinor: 5000,
      periodDays: 30, periodSpend: [], reservedMinor: 0, maxTransactions: 3, transactionCount: 0,
    },
    ...overrides,
  };
}

describe('financial harness', () => {
  it('requires explicit approval for a valid alpha request', () => {
    expect(evaluatePolicy(validInput())).toEqual({
      decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'],
    });
  });

  it('does not accumulate a transaction-count cap for the rehearsal sandbox', () => {
    expect(evaluatePolicy(validInput({
      mandate: {
        ...validInput().mandate,
        maxTransactions: UNLIMITED_TRANSACTIONS,
        transactionCount: 10_000,
      },
    }))).toEqual({
      decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'],
    });
  });

  it.each([
    [{ authenticated: false }, 'UNAUTHENTICATED'],
    [{ mandate: { ...validInput().mandate, validUntil: '2026-07-09T00:00:00.000Z' } }, 'MANDATE_EXPIRED'],
    [{ requestPetId: 'pet_other' }, 'OWNER_PET_MISMATCH'],
    [{ interpretationConfirmed: false }, 'INTERPRETATION_NOT_CONFIRMED'],
    [{ emergencyMode: true, category: 'TREATS' }, 'EMERGENCY_NONESSENTIAL'],
    [{ merchantId: 'merchant_unknown' }, 'MERCHANT_NOT_ALLOWED'],
    [{ quoteAmountMinor: 1399 }, 'PRICE_CHANGED'],
    [{
      amountMinor: 5100,
      quoteAmountMinor: 5100,
      walletBalanceMinor: 10000,
      mandate: { ...validInput().mandate, perTransactionLimitMinor: 10000 },
    }, 'BUDGET_EXCEEDED'],
    [{ replayDetected: true }, 'REPLAY_DETECTED'],
  ] as const)('blocks %j with %s', (overrides, reason) => {
    const decision = evaluatePolicy(validInput(overrides as Partial<PolicyInput>));
    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasonCodes[0]).toBe(reason);
  });

  it.each([
    [{ sourceVerified: false }, 'SOURCE_UNVERIFIED'],
    [{ mandate: { ...validInput().mandate, signatureVerified: false } }, 'MANDATE_INVALID'],
    [{ mandate: { ...validInput().mandate, status: 'SUSPENDED' as const } }, 'MANDATE_INACTIVE'],
    [{ mandate: { ...validInput().mandate, status: 'EXPIRED' as const } }, 'MANDATE_EXPIRED'],
    [{ mandate: { ...validInput().mandate, validFrom: '2026-07-11T00:00:00.000Z' } }, 'MANDATE_NOT_YET_VALID'],
    [{ interpretationValid: false }, 'INTERPRETATION_INVALID'],
    [{ need: 'unlisted_need' as const }, 'NEED_NOT_ALLOWED'],
    [{ category: 'GROOMING' as const }, 'CATEGORY_NOT_ALLOWED'],
    [{ productId: 'product_unknown' }, 'PRODUCT_NOT_ALLOWED'],
    [{ token: 'DAI' as never }, 'TOKEN_NOT_ALLOWED'],
    [{ chainId: 1 as never }, 'CHAIN_NOT_ALLOWED'],
    [{ recipient: '0x9999999999999999999999999999999999999999' }, 'RECIPIENT_NOT_ALLOWED'],
    [{ contract: '0x9999999999999999999999999999999999999999' }, 'CONTRACT_NOT_ALLOWED'],
    [{ quoteVerified: false }, 'QUOTE_INVALID'],
    [{ now: '2026-07-10T12:06:00.000Z' }, 'QUOTE_EXPIRED'],
    [{ substitution: true }, 'SUBSTITUTION_REQUIRES_APPROVAL'],
    [{ requestPolicyVersion: 'v0' }, 'POLICY_VERSION_CHANGED'],
    [{ amountMinor: 2001, quoteAmountMinor: 2001 }, 'TRANSACTION_LIMIT_EXCEEDED'],
    [{ mandate: { ...validInput().mandate, reservedMinor: 4000 } }, 'BUDGET_EXCEEDED'],
    [{ mandate: { ...validInput().mandate, transactionCount: 3 } }, 'FREQUENCY_EXCEEDED'],
    [{ walletBalanceMinor: 1200 }, 'INSUFFICIENT_BALANCE'],
    [{ anomalyDetected: true }, 'ANOMALY_DETECTED'],
    [{ now: 'not-a-date' }, 'INVALID_TIMESTAMP'],
    [{ mandate: { ...validInput().mandate, validFrom: 'not-a-date' } }, 'INVALID_TIMESTAMP'],
    [{ quoteExpiresAt: 'not-a-date' }, 'INVALID_TIMESTAMP'],
  ] as const)('covers the complete controlled block surface for %j', (overrides, reason) => {
    expect(evaluatePolicy(validInput(overrides as Partial<PolicyInput>))).toEqual({ decision: 'BLOCK', reasonCodes: [reason] });
  });

  it('blocks a category the owner allows but that cannot answer the interpreted need', () => {
    const mandate = { ...validInput().mandate, allowedNeeds: ['hunger' as const, 'play_or_enrichment' as const], allowedCategories: ['PET_FOOD' as const, 'TOYS_ENRICHMENT' as const] };
    expect(evaluatePolicy(validInput({ mandate, need: 'hunger', category: 'TOYS_ENRICHMENT' })))
      .toEqual({ decision: 'BLOCK', reasonCodes: ['CATEGORY_NOT_ALLOWED'] });
    expect(evaluatePolicy(validInput({ mandate, need: 'play_or_enrichment', category: 'PET_FOOD' })))
      .toEqual({ decision: 'BLOCK', reasonCodes: ['CATEGORY_NOT_ALLOWED'] });
    expect(evaluatePolicy(validInput({ mandate, need: 'play_or_enrichment', category: 'TOYS_ENRICHMENT' })))
      .toEqual({ decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] });
  });

  it('uses the documented fixed precedence when several checks fail', () => {
    const decision = evaluatePolicy(validInput({
      authenticated: false,
      sourceVerified: false,
      mandate: { ...validInput().mandate, signatureVerified: false, status: 'REVOKED' },
      merchantId: 'merchant_unknown',
      amountMinor: 9999,
      quoteAmountMinor: 9999,
    }));
    expect(decision).toEqual({ decision: 'BLOCK', reasonCodes: ['UNAUTHENTICATED'] });
  });

  it.each([
    { amountMinor: -1, quoteAmountMinor: -1 },
    { walletBalanceMinor: Number.NaN },
    { mandate: { ...validInput().mandate, periodSpend: [{ amountMinor: -1, executedAt: '2026-07-10T00:00:00.000Z' }] } },
    { mandate: { ...validInput().mandate, periodSpend: [{ amountMinor: 10, executedAt: 'not-a-date' }] } },
    { mandate: { ...validInput().mandate, periodDays: 0 } },
    { mandate: { ...validInput().mandate, reservedMinor: Number.MAX_SAFE_INTEGER + 1 } },
    { mandate: { ...validInput().mandate, transactionCount: -1 } },
  ])('fails closed when financial state contains invalid numeric values: %j', (overrides) => {
    expect(evaluatePolicy(validInput(overrides as Partial<PolicyInput>))).toEqual({
      decision: 'BLOCK', reasonCodes: ['ANOMALY_DETECTED'],
    });
  });

  it('charges the period allowance against a rolling window instead of the life of the mandate', () => {
    const settled = (executedAt: string) => ({ amountMinor: 1900, executedAt });
    // A year-long mandate that has spent its way past the limit over months: the allowance the
    // owner was shown is a 30-day one, so only what settled inside the window may block.
    const yearLong = { ...validInput().mandate, validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' };
    const stale = { ...yearLong, periodSpend: [settled('2026-01-05T00:00:00.000Z'), settled('2026-03-05T00:00:00.000Z'), settled('2026-05-05T00:00:00.000Z')] };
    expect(evaluatePolicy(validInput({ mandate: stale })))
      .toEqual({ decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] });
    const recent = { ...yearLong, periodSpend: [settled('2026-06-25T00:00:00.000Z'), settled('2026-07-01T00:00:00.000Z')] };
    expect(evaluatePolicy(validInput({ mandate: recent })))
      .toEqual({ decision: 'BLOCK', reasonCodes: ['BUDGET_EXCEEDED'] });
    // The oldest of those two leaves the window a fortnight later and the allowance recovers.
    expect(evaluatePolicy(validInput({ mandate: recent, now: '2026-07-26T12:00:00.000Z', quoteExpiresAt: '2026-07-26T12:05:00.000Z' })))
      .toEqual({ decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] });
  });

  it('charges the transaction cap against the same rolling window as the allowance', () => {
    const settled = (executedAt: string) => ({ amountMinor: 1, executedAt });
    const yearLong = {
      ...validInput().mandate,
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', maxTransactions: 3,
    };
    const at = (mandate: PolicyInput['mandate']) => evaluatePolicy(validInput({
      mandate, now: '2026-12-01T12:00:00.000Z', quoteExpiresAt: '2026-12-01T12:05:00.000Z',
    }));
    // Three purchases spread across the year, none of them inside the trailing 30 days.
    expect(at({
      ...yearLong, transactionCount: 3,
      periodSpend: ['2026-01-05T00:00:00.000Z', '2026-03-05T00:00:00.000Z', '2026-05-05T00:00:00.000Z'].map(settled),
    })).toEqual({ decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] });
    // Exactly on the 30-day cutoff is outside the window; one millisecond later is inside it.
    const cutoff = '2026-11-01T12:00:00.000Z';
    expect(at({ ...yearLong, transactionCount: 3, periodSpend: [cutoff, cutoff, cutoff].map(settled) }))
      .toEqual({ decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] });
    const inside = '2026-11-01T12:00:00.001Z';
    expect(at({ ...yearLong, transactionCount: 3, periodSpend: [inside, inside, inside].map(settled) }))
      .toEqual({ decision: 'BLOCK', reasonCodes: ['FREQUENCY_EXCEEDED'] });
    // The caller folds still-held reservations into transactionCount, so two settled purchases
    // inside the window plus one in flight must still exhaust a cap of three.
    expect(at({ ...yearLong, transactionCount: 3, periodSpend: [inside, inside].map(settled) }))
      .toEqual({ decision: 'BLOCK', reasonCodes: ['FREQUENCY_EXCEEDED'] });
  });

  it('separates a mandate that has not started from one that has ended', () => {
    const at = (now: string) => evaluatePolicy(validInput({ now, quoteExpiresAt: '2026-09-01T00:00:00.000Z' }));
    expect(at('2026-07-09T23:59:59.999Z')).toEqual({ decision: 'BLOCK', reasonCodes: ['MANDATE_NOT_YET_VALID'] });
    expect(at('2026-07-10T00:00:00.000Z')).toEqual({ decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] });
    expect(at('2026-08-08T23:59:59.999Z')).toEqual({ decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] });
    expect(at('2026-08-09T00:00:00.000Z')).toEqual({ decision: 'BLOCK', reasonCodes: ['MANDATE_EXPIRED'] });
  });
});

describe('budget ledger', () => {
  it('reserves once per request and releases exactly once', () => {
    const ledger = new BudgetLedger();
    expect(ledger.reserve('request_1', 1200, 2000)).toEqual({ ok: true, reservedMinor: 1200 });
    expect(ledger.reserve('request_1', 1200, 2000)).toEqual({ ok: true, reservedMinor: 1200 });
    expect(ledger.reservedFor('request_1')).toBe(1200);
    expect(ledger.reservedFor('unknown')).toBe(0);
    expect(ledger.reservationCount).toBe(1);
    expect(ledger.reserve('request_2', 900, 2000)).toEqual({ ok: false, reason: 'BUDGET_EXCEEDED' });
    expect(ledger.release('request_1')).toBe(0);
    expect(ledger.release('request_1')).toBe(0);
  });

  it('fails closed on duplicate reservation keys during durable restore', () => {
    const ledger = new BudgetLedger();
    expect(() => ledger.restore([['request_1', 1200], ['request_1', 800]])).toThrow('Duplicate budget reservation');
  });

  it('fails closed when restored reservations overflow safe integer accounting', () => {
    const ledger = new BudgetLedger();
    expect(() => ledger.restore([
      ['request_1', Number.MAX_SAFE_INTEGER],
      ['request_2', 1],
    ])).toThrow('Invalid budget reservation snapshot');
    expect(ledger.reservedMinor).toBe(0);
  });

  it('rejects a reused reservation key when the amount changes', () => {
    const ledger = new BudgetLedger();
    expect(ledger.reserve('request_1', 1200, 2000)).toEqual({ ok: true, reservedMinor: 1200 });
    expect(() => ledger.reserve('request_1', 800, 2000)).toThrow('Reservation amount conflict');
    expect(ledger.reservedMinor).toBe(1200);
  });

  it.each([
    ['', 100, 2000],
    ['request_1', -1, 2000],
    ['request_1', 1.5, 2000],
    ['request_1', Number.NaN, 2000],
    ['request_1', 100, -1],
    ['request_1', 100, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects an invalid reservation input (%j, %j, %j)', (requestId, amountMinor, limitMinor) => {
    const ledger = new BudgetLedger();
    expect(() => ledger.reserve(requestId, amountMinor, limitMinor)).toThrow('Invalid budget reservation');
    expect(ledger.reservedMinor).toBe(0);
  });
});
