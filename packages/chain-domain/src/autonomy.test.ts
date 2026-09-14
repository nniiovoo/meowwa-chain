import { describe, expect, it } from 'vitest';
import { evaluateAutonomy, type AutonomyInput, type AutonomyMandate } from './autonomy.js';

const now = '2026-07-11T12:00:00.000Z';

const mandate: AutonomyMandate = {
  autonomyId: 'autonomy_mochi', ownerId: 'owner_1', petId: 'pet_mochi', agentId: 'agent_mochi',
  mode: 'LIMITED_AUTONOMY', allowedNeedCode: 'hunger', allowedMerchantId: 'merchant_approved_1',
  allowedProductId: 'product_usual_food_1', approvedAmountMinor: 1299, perTransactionLimitMinor: 1299,
  dailyLimitMinor: 1299, periodLimitMinor: 3897, periodDays: 30, cooldownMinutes: 1440,
  maxTransactionsPerPeriod: 3, minimumSignalQuality: 0.5, minimumInterpretationScore: 0.5,
  validFrom: '2026-07-10T00:00:00.000Z', validUntil: '2026-08-10T00:00:00.000Z',
  policyVersion: 'v1', authorization: {
    kind: 'simulated_owner_approval', approvedBy: 'owner_1', approvedAt: '2026-07-10T00:00:00.000Z',
    displayedText: 'Mochi may buy one exact usual-food product within bounded test-USDC limits.',
  },
};

function input(overrides: Partial<AutonomyInput> = {}): AutonomyInput {
  return {
    now, ownerId: 'owner_1', petId: 'pet_mochi', agentId: 'agent_mochi', agentActive: true,
    need: 'hunger', signalQuality: 0.6, interpretationScore: 0.6,
    merchantId: 'merchant_approved_1', productId: 'product_usual_food_1', category: 'PET_FOOD', amountMinor: 1299,
    quoteVerified: true,
    walletAvailable: true, emergencyMode: false, unresolvedReconciliation: false,
    policyVersion: 'v1', mandate, executions: [], ...overrides,
  };
}

describe('bounded pet-agent autonomy', () => {
  it('auto-authorizes only the exact owner-approved repeat essential', () => {
    expect(evaluateAutonomy(input())).toEqual({
      decision: 'AUTO_AUTHORIZE', reasonCode: 'OWNER_MANDATE_PREAUTHORIZED',
    });
  });

  it('keeps need-based autonomy blocked until repeated, owner-approved preference evidence exists', () => {
    const needBased = { ...mandate, level: 'need_based' as const };
    expect(evaluateAutonomy(input({ mandate: needBased, needBasedEvidence: {
      repeatedObservationCount: 1, ownerApprovedBaseline: true, positivePreferenceEvidence: true,
    } }))).toEqual({ decision: 'BLOCK', reasonCode: 'NEED_BASED_EVIDENCE_REQUIRED' });
    expect(evaluateAutonomy(input({ mandate: needBased, needBasedEvidence: {
      repeatedObservationCount: 2, ownerApprovedBaseline: true, positivePreferenceEvidence: true,
    } }))).toEqual({ decision: 'AUTO_AUTHORIZE', reasonCode: 'OWNER_MANDATE_PREAUTHORIZED' });
  });

  it('allows a need-based purchase from the signed owner-approved product set', () => {
    const needBased = {
      ...mandate,
      level: 'need_based' as const,
      allowedProductIds: ['product_usual_food_1', 'product_treat_1', 'product_toy_feather_1'],
      perTransactionLimitMinor: 2000,
    };
    expect(evaluateAutonomy(input({
      mandate: needBased,
      productId: 'product_treat_1',
      category: 'TREATS',
      amountMinor: 699,
      needBasedEvidence: { repeatedObservationCount: 2, ownerApprovedBaseline: true, positivePreferenceEvidence: true },
    }))).toEqual({ decision: 'AUTO_AUTHORIZE', reasonCode: 'OWNER_MANDATE_PREAUTHORIZED' });
    expect(evaluateAutonomy(input({
      mandate: needBased,
      productId: 'product_litter_clumping_1',
      category: 'CAT_LITTER',
      amountMinor: 1599,
      needBasedEvidence: { repeatedObservationCount: 2, ownerApprovedBaseline: true, positivePreferenceEvidence: true },
    }))).toEqual({ decision: 'BLOCK', reasonCode: 'PRODUCT_NOT_AUTONOMOUS' });
  });

  it('does not let a hunger signal auto-authorize a toy from the owner-approved product set', () => {
    expect(evaluateAutonomy(input({
      mandate: {
        ...mandate,
        level: 'need_based' as const,
        allowedProductIds: ['product_usual_food_1', 'product_toy_feather_1'],
        perTransactionLimitMinor: 2000,
      },
      productId: 'product_toy_feather_1',
      category: 'TOYS_ENRICHMENT',
      amountMinor: 899,
      needBasedEvidence: { repeatedObservationCount: 2, ownerApprovedBaseline: true, positivePreferenceEvidence: true },
    }))).toEqual({ decision: 'BLOCK', reasonCode: 'PRODUCT_NOT_AUTONOMOUS' });
  });

  it('falls back to explicit owner approval when autonomy is not enabled', () => {
    expect(evaluateAutonomy(input({ mandate: { ...mandate, mode: 'OWNER_APPROVAL' } }))).toEqual({
      decision: 'REQUIRE_OWNER_APPROVAL', reasonCode: 'OWNER_APPROVAL_MODE',
    });
  });

  it('does not turn suggest-only mode into an autonomous or approval request', () => {
    expect(evaluateAutonomy(input({ mandate: { ...mandate, level: 'suggest_only', mode: 'OWNER_APPROVAL' } }))).toEqual({
      decision: 'BLOCK', reasonCode: 'SUGGESTION_ONLY_MODE',
    });
  });

  it('fails closed when approve-each is paired with limited autonomy', () => {
    expect(evaluateAutonomy(input({
      mandate: { ...mandate, level: 'approve_each', mode: 'LIMITED_AUTONOMY' },
    }))).toEqual({
      decision: 'BLOCK', reasonCode: 'AUTONOMY_CONFIGURATION_INVALID',
    });
  });

  it.each([
    [{ mandate: { ...mandate, mode: 'SUSPENDED' } }, 'AUTONOMY_SUSPENDED'],
    [{ mandate: { ...mandate, mode: 'REVOKED' } }, 'AUTONOMY_REVOKED'],
    [{ agentActive: false }, 'AGENT_INACTIVE'],
    [{ now: '2026-07-09T23:59:59.000Z' }, 'AUTONOMY_NOT_YET_VALID'],
    [{ now: '2026-08-10T00:00:00.000Z' }, 'AUTONOMY_EXPIRED'],
    [{ now: '2026-08-10T00:00:00.001Z' }, 'AUTONOMY_EXPIRED'],
    [{ agentId: 'agent_pepper' }, 'PET_AGENT_MISMATCH'],
    [{ ownerId: 'owner_other' }, 'OWNER_PET_MISMATCH'],
    [{ mandate: { ...mandate, authorization: { ...mandate.authorization, approvedBy: 'owner_other' } } }, 'OWNER_AUTHORIZATION_INVALID'],
    [{ need: 'other_need' }, 'NEED_NOT_AUTONOMOUS'],
    [{ signalQuality: 0.4 }, 'SIGNAL_QUALITY_LOW'],
    [{ interpretationScore: 0.4 }, 'INTERPRETATION_SCORE_LOW'],
    [{ merchantId: 'merchant_other' }, 'MERCHANT_NOT_AUTONOMOUS'],
    [{ productId: 'product_other' }, 'PRODUCT_NOT_AUTONOMOUS'],
    [{ amountMinor: 1300 }, 'PRICE_CHANGED'],
    [{ quoteVerified: undefined }, 'QUOTE_INVALID'],
    [{ quoteVerified: false }, 'QUOTE_INVALID'],
    [{ mandate: { ...mandate, perTransactionLimitMinor: 1298 } }, 'TRANSACTION_LIMIT_EXCEEDED'],
    [{ walletAvailable: false }, 'WALLET_UNAVAILABLE'],
    [{ emergencyMode: true }, 'EMERGENCY_ACTIVE'],
    [{ unresolvedReconciliation: true }, 'RECONCILIATION_UNRESOLVED'],
    [{ policyVersion: 'v2' }, 'POLICY_CHANGED'],
  ] as const)('blocks an unsafe boundary with a stable reason code', (overrides, reasonCode) => {
    expect(evaluateAutonomy(input(overrides as unknown as Partial<AutonomyInput>))).toEqual({ decision: 'BLOCK', reasonCode });
  });

  it.each([
    [{ executions: [{ requestId: 'request_1', amountMinor: 1299, executedAt: '2026-07-11T11:59:59.000Z' }] }, 'COOLDOWN_ACTIVE'],
    [{
      mandate: { ...mandate, cooldownMinutes: 60 },
      executions: [{ requestId: 'request_1', amountMinor: 1299, executedAt: '2026-07-11T10:00:00.000Z' }],
    }, 'DAILY_LIMIT_EXCEEDED'],
    [{ executions: [
      { requestId: 'request_1', amountMinor: 1299, executedAt: '2026-06-20T12:00:00.000Z' },
      { requestId: 'request_2', amountMinor: 1299, executedAt: '2026-06-25T12:00:00.000Z' },
      { requestId: 'request_3', amountMinor: 1299, executedAt: '2026-07-01T12:00:00.000Z' },
    ] }, 'PERIOD_LIMIT_EXCEEDED'],
    [{
      executions: [
        { requestId: 'request_1', amountMinor: 1, executedAt: '2026-06-20T12:00:00.000Z' },
        { requestId: 'request_2', amountMinor: 1, executedAt: '2026-06-25T12:00:00.000Z' },
        { requestId: 'request_3', amountMinor: 1, executedAt: '2026-07-01T12:00:00.000Z' },
      ],
    }, 'FREQUENCY_EXCEEDED'],
  ] as const)('enforces rolling spend, frequency, and cooldown boundaries', (overrides, reasonCode) => {
    expect(evaluateAutonomy(input(overrides as unknown as Partial<AutonomyInput>))).toEqual({ decision: 'BLOCK', reasonCode });
  });

  it('names the terminal autonomy state ahead of the suggestion-only level', () => {
    expect(evaluateAutonomy(input({ mandate: { ...mandate, mode: 'SUSPENDED', level: 'suggest_only' } })))
      .toEqual({ decision: 'BLOCK', reasonCode: 'AUTONOMY_SUSPENDED' });
    expect(evaluateAutonomy(input({ mandate: { ...mandate, mode: 'REVOKED', level: 'suggest_only' } })))
      .toEqual({ decision: 'BLOCK', reasonCode: 'AUTONOMY_REVOKED' });
  });

  it('does not ask the owner to approve a mandate that is invalid on its face', () => {
    const ownerApproval = { ...mandate, mode: 'OWNER_APPROVAL' as const };
    expect(evaluateAutonomy(input({ mandate: ownerApproval, now: '2026-08-10T00:00:00.000Z' })))
      .toEqual({ decision: 'BLOCK', reasonCode: 'AUTONOMY_EXPIRED' });
    expect(evaluateAutonomy(input({ mandate: ownerApproval, agentId: 'agent_pepper' })))
      .toEqual({ decision: 'BLOCK', reasonCode: 'PET_AGENT_MISMATCH' });
    expect(evaluateAutonomy(input({
      mandate: { ...ownerApproval, authorization: { ...mandate.authorization, approvedBy: 'owner_other' } },
    }))).toEqual({ decision: 'BLOCK', reasonCode: 'OWNER_AUTHORIZATION_INVALID' });
    expect(evaluateAutonomy(input({ mandate: ownerApproval })))
      .toEqual({ decision: 'REQUIRE_OWNER_APPROVAL', reasonCode: 'OWNER_APPROVAL_MODE' });
  });

  it('absorbs a millisecond of replica clock skew instead of reporting corrupted configuration', () => {
    const oneMsAhead = '2026-07-11T12:00:00.001Z';
    expect(evaluateAutonomy(input({
      mandate: { ...mandate, authorization: { ...mandate.authorization, approvedAt: oneMsAhead } },
    }))).toEqual({ decision: 'AUTO_AUTHORIZE', reasonCode: 'OWNER_MANDATE_PREAUTHORIZED' });
    // An in-flight execution stamped a millisecond ahead by a sibling replica still consumes the
    // caps and the cooldown; it is not corrupted state.
    expect(evaluateAutonomy(input({
      pendingExecutions: [{ requestId: 'request_pending', amountMinor: 1299, executedAt: oneMsAhead }],
    }))).toEqual({ decision: 'BLOCK', reasonCode: 'COOLDOWN_ACTIVE' });
    // Past the tolerance the timestamp is corrupted state again.
    const farAhead = '2026-07-11T13:00:00.000Z';
    expect(evaluateAutonomy(input({
      mandate: { ...mandate, authorization: { ...mandate.authorization, approvedAt: farAhead } },
    }))).toEqual({ decision: 'BLOCK', reasonCode: 'AUTONOMY_CONFIGURATION_INVALID' });
    expect(evaluateAutonomy(input({
      pendingExecutions: [{ requestId: 'request_far', amountMinor: 1299, executedAt: farAhead }],
    }))).toEqual({ decision: 'BLOCK', reasonCode: 'AUTONOMY_CONFIGURATION_INVALID' });
  });

  it('counts pending wallet reservations against the transaction cap', () => {
    expect(evaluateAutonomy(input({
      mandate: { ...mandate, periodLimitMinor: 10_000 }, pendingTransactionCount: 3,
    }))).toEqual({ decision: 'BLOCK', reasonCode: 'FREQUENCY_EXCEEDED' });
  });

  it.each([
    { now: 'not-a-timestamp' },
    { mandate: { ...mandate, validUntil: 'not-a-timestamp' } },
    { signalQuality: Number.NaN },
    { interpretationScore: Number.POSITIVE_INFINITY },
    { amountMinor: -1299, mandate: { ...mandate, approvedAmountMinor: -1299 } },
    { mandate: { ...mandate, dailyLimitMinor: Number.MAX_SAFE_INTEGER + 1 } },
    { pendingTransactionCount: -1 },
    { executions: [{ requestId: 'request_bad_time', amountMinor: 1, executedAt: 'not-a-timestamp' }] },
    { executions: [{ requestId: 'request_negative', amountMinor: -1, executedAt: '2026-07-11T10:00:00.000Z' }] },
    {
      mandate: { ...mandate, cooldownMinutes: 0, dailyLimitMinor: Number.MAX_SAFE_INTEGER, periodLimitMinor: Number.MAX_SAFE_INTEGER },
      executions: [
        { requestId: 'request_1', amountMinor: Number.MAX_SAFE_INTEGER, executedAt: '2026-07-11T10:00:00.000Z' },
        { requestId: 'request_2', amountMinor: 1, executedAt: '2026-07-11T09:00:00.000Z' },
      ],
    },
  ] as Array<Partial<AutonomyInput>>)('fails closed when autonomy state is numerically or temporally invalid: %#', (overrides) => {
    expect(evaluateAutonomy(input(overrides))).toEqual({
      decision: 'BLOCK', reasonCode: 'AUTONOMY_CONFIGURATION_INVALID',
    });
  });
});
