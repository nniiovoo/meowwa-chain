import type { CategoryCode, NeedCode } from './codes.js';
import { categoryAnswersNeed, withinTrailingWindow } from './policy.js';

export type AutonomyMode = 'OWNER_APPROVAL' | 'LIMITED_AUTONOMY' | 'SUSPENDED' | 'REVOKED';
export type AutonomyLevel = 'suggest_only' | 'approve_each' | 'automatic_replenishment' | 'need_based';

const autonomyModes: readonly AutonomyMode[] = ['OWNER_APPROVAL', 'LIMITED_AUTONOMY', 'SUSPENDED', 'REVOKED'];
const autonomyLevels: readonly AutonomyLevel[] = ['suggest_only', 'approve_each', 'automatic_replenishment', 'need_based'];

/** Validate the active mode/level invariant at both evaluation and persistence boundaries. */
export function isAutonomyLevelModeValid(mode: unknown, level?: unknown): boolean {
  if (!autonomyModes.includes(mode as AutonomyMode) ||
    (level !== undefined && !autonomyLevels.includes(level as AutonomyLevel))) return false;
  if (mode === 'SUSPENDED' || mode === 'REVOKED') return true;
  const effectiveLevel = level ?? (mode === 'OWNER_APPROVAL' ? 'approve_each' : 'automatic_replenishment');
  return mode === 'OWNER_APPROVAL'
    ? effectiveLevel === 'suggest_only' || effectiveLevel === 'approve_each'
    : effectiveLevel === 'automatic_replenishment' || effectiveLevel === 'need_based';
}

export interface SignedMandateProof {
  algorithm: 'ed25519';
  keyId: string;
  publicKey: string;
  payloadHash: string;
  signature: string;
  signedAt: string;
}

export type AutonomyReasonCode =
  | 'OWNER_MANDATE_PREAUTHORIZED' | 'OWNER_APPROVAL_MODE' | 'AUTONOMY_SUSPENDED' | 'AUTONOMY_REVOKED'
  | 'AGENT_INACTIVE' | 'AUTONOMY_NOT_YET_VALID' | 'AUTONOMY_EXPIRED'
  | 'PET_AGENT_MISMATCH' | 'OWNER_PET_MISMATCH' | 'OWNER_AUTHORIZATION_INVALID'
  | 'AUTONOMY_CONFIGURATION_INVALID'
  | 'SUGGESTION_ONLY_MODE'
  | 'NEED_BASED_EVIDENCE_REQUIRED'
  | 'NEED_NOT_AUTONOMOUS' | 'SIGNAL_QUALITY_LOW' | 'INTERPRETATION_SCORE_LOW'
  | 'MERCHANT_NOT_AUTONOMOUS' | 'PRODUCT_NOT_AUTONOMOUS' | 'PRICE_CHANGED'
  | 'QUOTE_INVALID'
  | 'TRANSACTION_LIMIT_EXCEEDED' | 'DAILY_LIMIT_EXCEEDED' | 'PERIOD_LIMIT_EXCEEDED'
  | 'FREQUENCY_EXCEEDED' | 'COOLDOWN_ACTIVE' | 'WALLET_UNAVAILABLE'
  | 'EMERGENCY_ACTIVE' | 'RECONCILIATION_UNRESOLVED' | 'POLICY_CHANGED' | 'SAFETY_REVIEW_REQUIRED';

export interface AutonomyMandate {
  autonomyId: string; ownerId: string; petId: string; agentId: string; mode: AutonomyMode; level?: AutonomyLevel;
  allowedNeedCode: NeedCode; allowedMerchantId: string; allowedProductId: string;
  /**
   * Need-based autonomy may choose one product from this owner-approved set.
   * The singular field remains the preferred/legacy product for the other
   * autonomy levels and for backwards-compatible persisted mandates.
   */
  allowedProductIds?: string[];
  approvedAmountMinor: number; perTransactionLimitMinor: number; dailyLimitMinor: number;
  periodLimitMinor: number; periodDays: number; cooldownMinutes: number; maxTransactionsPerPeriod: number;
  minimumSignalQuality: number; minimumInterpretationScore: number;
  validFrom: string; validUntil: string; policyVersion: string;
  authorization: {
    kind: 'simulated_owner_approval'; approvedBy: string; approvedAt: string; displayedText: string;
    proof?: SignedMandateProof;
  };
}

export interface AutonomyExecution {
  requestId: string; amountMinor: number; executedAt: string;
}

export interface AutonomyInput {
  now: string; ownerId: string; petId: string; agentId: string; agentActive: boolean;
  need: NeedCode; signalQuality: number; interpretationScore: number;
  merchantId: string; productId: string; category: CategoryCode; amountMinor: number;
  quoteVerified?: boolean;
  walletAvailable: boolean; emergencyMode: boolean; unresolvedReconciliation: boolean;
  policyVersion: string; mandate: AutonomyMandate; executions: AutonomyExecution[];
  pendingTransactionCount?: number;
  /**
   * Autonomous spend already authorized under this mandate but not yet settled. Settled spend
   * arrives via `executions`; without this an in-flight autonomous payment is invisible to the
   * daily and period money caps and to the cooldown, so concurrent signals can each authorize
   * a full-limit purchase before any of them lands.
   */
  pendingExecutions?: AutonomyExecution[];
  /**
   * Readiness evidence is supplied by the application boundary for the
   * need-based level. Keeping it out of the mandate prevents a caller from
   * making the authorization self-asserting: the application must derive the
   * counts from persisted, pet-scoped history before the policy is evaluated.
   */
  needBasedEvidence?: {
    repeatedObservationCount: number;
    ownerApprovedBaseline: boolean;
    positivePreferenceEvidence: boolean;
  };
}

export type AutonomyDecision =
  | { decision: 'AUTO_AUTHORIZE'; reasonCode: 'OWNER_MANDATE_PREAUTHORIZED' }
  | { decision: 'REQUIRE_OWNER_APPROVAL'; reasonCode: 'OWNER_APPROVAL_MODE' | 'SAFETY_REVIEW_REQUIRED' }
  | { decision: 'BLOCK'; reasonCode: Exclude<AutonomyReasonCode, 'OWNER_MANDATE_PREAUTHORIZED' | 'OWNER_APPROVAL_MODE'> };

const blocked = (reasonCode: Exclude<AutonomyReasonCode, 'OWNER_MANDATE_PREAUTHORIZED' | 'OWNER_APPROVAL_MODE'>): AutonomyDecision =>
  ({ decision: 'BLOCK', reasonCode });

/**
 * How far ahead of the evaluating clock a timestamp minted by a sibling replica may sit before it
 * is read as corrupted state rather than clock skew. Every one of these timestamps is stamped by
 * whichever replica served the earlier request, so a strict comparison against the evaluating
 * replica's `now` refuses an autonomous purchase for AUTONOMY_CONFIGURATION_INVALID — a code that
 * reads as corrupted owner configuration — over a millisecond of ordinary drift.
 *
 * Applied only to the two backward-looking sanity checks, which cannot widen an authorization: a
 * tolerated future execution still counts against every money cap and still holds the cooldown
 * (`now - latest` goes negative), and a tolerated future `approvedAt` moves no money. The
 * owner-facing validity window stays exact so a mandate never authorizes before it starts.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

const safePositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const safeNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const unitInterval = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

export function evaluateAutonomy(input: AutonomyInput): AutonomyDecision {
  const { mandate } = input;
  const level = mandate.level ?? 'automatic_replenishment';
  const allowedProductIds = mandate.allowedProductIds ?? [mandate.allowedProductId];
  if (!isAutonomyLevelModeValid(mandate.mode, mandate.level)) return blocked('AUTONOMY_CONFIGURATION_INVALID');
  // A pause or a revocation is a different security posture from a suggestion-only setting, and it
  // is the one an incident review has to see. Reporting a REVOKED agent that happens to sit at
  // suggest_only as merely 'suggestion only' hid that the owner had revoked it.
  if (mandate.mode === 'SUSPENDED') return blocked('AUTONOMY_SUSPENDED');
  if (mandate.mode === 'REVOKED') return blocked('AUTONOMY_REVOKED');
  if (mandate.level === 'suggest_only') return blocked('SUGGESTION_ONLY_MODE');
  if (!input.agentActive) return blocked('AGENT_INACTIVE');

  const now = Date.parse(input.now);
  const validFrom = Date.parse(mandate.validFrom);
  const validUntil = Date.parse(mandate.validUntil);
  const approvedAt = Date.parse(mandate.authorization.approvedAt);
  const consideredExecutions = [...input.executions, ...(input.pendingExecutions ?? [])];
  const executionTimes = consideredExecutions.map((item) => Date.parse(item.executedAt));
  if (
    ![now, validFrom, validUntil, approvedAt, ...executionTimes].every(Number.isFinite)
    || validFrom >= validUntil
    || ![input.ownerId, input.petId, input.agentId, mandate.ownerId, mandate.petId, mandate.agentId,
      mandate.allowedMerchantId, mandate.allowedProductId, mandate.authorization.approvedBy]
      .every((value) => typeof value === 'string' && value.length > 0)
    || !Array.isArray(allowedProductIds) || allowedProductIds.length === 0
    || allowedProductIds.some((productId) => typeof productId !== 'string' || productId.length === 0)
    || !safePositiveInteger(input.amountMinor)
    || !safePositiveInteger(mandate.approvedAmountMinor)
    || !safePositiveInteger(mandate.perTransactionLimitMinor)
    || !safePositiveInteger(mandate.dailyLimitMinor)
    || !safePositiveInteger(mandate.periodLimitMinor)
    || !safePositiveInteger(mandate.periodDays)
    || !safeNonNegativeInteger(mandate.cooldownMinutes)
    || !safePositiveInteger(mandate.maxTransactionsPerPeriod)
    || !safeNonNegativeInteger(input.pendingTransactionCount ?? 0)
    || !unitInterval(input.signalQuality) || !unitInterval(input.interpretationScore)
    || !unitInterval(mandate.minimumSignalQuality) || !unitInterval(mandate.minimumInterpretationScore)
    || consideredExecutions.some((item, index) =>
      typeof item.requestId !== 'string' || item.requestId.length === 0 ||
      !safePositiveInteger(item.amountMinor) || executionTimes[index]! > now + CLOCK_SKEW_TOLERANCE_MS)
  ) return blocked('AUTONOMY_CONFIGURATION_INVALID');
  if (now < validFrom) return blocked('AUTONOMY_NOT_YET_VALID');
  if (now >= validUntil) return blocked('AUTONOMY_EXPIRED');
  if (approvedAt > now + CLOCK_SKEW_TOLERANCE_MS) return blocked('AUTONOMY_CONFIGURATION_INVALID');
  if (input.petId !== mandate.petId || input.agentId !== mandate.agentId) return blocked('PET_AGENT_MISMATCH');
  if (input.ownerId !== mandate.ownerId) return blocked('OWNER_PET_MISMATCH');
  if (mandate.authorization.approvedBy !== mandate.ownerId) return blocked('OWNER_AUTHORIZATION_INVALID');
  // Only now: an OWNER_APPROVAL mandate that is expired, malformed, or bound to a different pet is
  // not something to ask the owner to approve. Returning REQUIRE_OWNER_APPROVAL ahead of these
  // checks prompted the owner to review a purchase against a mandate that authorized nothing.
  if (mandate.mode === 'OWNER_APPROVAL') return { decision: 'REQUIRE_OWNER_APPROVAL', reasonCode: 'OWNER_APPROVAL_MODE' };
  if (input.need !== mandate.allowedNeedCode) return blocked('NEED_NOT_AUTONOMOUS');
  if (input.signalQuality < mandate.minimumSignalQuality) return blocked('SIGNAL_QUALITY_LOW');
  if (input.interpretationScore < mandate.minimumInterpretationScore) return blocked('INTERPRETATION_SCORE_LOW');
  if (level === 'need_based') {
    const evidence = input.needBasedEvidence;
    if (!evidence || !safeNonNegativeInteger(evidence.repeatedObservationCount)) {
      return blocked('NEED_BASED_EVIDENCE_REQUIRED');
    }
    // The current signal may be the second observation, but one observation
    // can never establish a need-based purchasing rule. Preference and owner
    // baseline evidence are independent gates so purchase history alone does
    // not masquerade as pet preference.
    if (evidence.repeatedObservationCount < 2 || evidence.ownerApprovedBaseline !== true || evidence.positivePreferenceEvidence !== true) {
      return blocked('NEED_BASED_EVIDENCE_REQUIRED');
    }
  }
  if (input.merchantId !== mandate.allowedMerchantId) return blocked('MERCHANT_NOT_AUTONOMOUS');
  // The product still has to answer the need it is bought for. Need-based autonomy picks the
  // product itself out of the whole owner allowlist, so without this a hunger signal auto-
  // authorized and paid for a toy with no owner in the loop.
  if (!allowedProductIds.includes(input.productId) ||
    !categoryAnswersNeed(input.need, input.category)) return blocked('PRODUCT_NOT_AUTONOMOUS');
  if (level !== 'need_based' && input.amountMinor !== mandate.approvedAmountMinor) return blocked('PRICE_CHANGED');
  if (input.quoteVerified !== true) return blocked('QUOTE_INVALID');
  if (input.amountMinor > mandate.perTransactionLimitMinor) return blocked('TRANSACTION_LIMIT_EXCEEDED');
  if (!input.walletAvailable) return blocked('WALLET_UNAVAILABLE');
  if (input.emergencyMode) return blocked('EMERGENCY_ACTIVE');
  if (input.unresolvedReconciliation) return blocked('RECONCILIATION_UNRESOLVED');
  if (input.policyVersion !== mandate.policyVersion) return blocked('POLICY_CHANGED');

  const daily = withinTrailingWindow(consideredExecutions, now, 1);
  const period = withinTrailingWindow(consideredExecutions, now, mandate.periodDays);
  const latest = executionTimes.reduce<number | undefined>((value, timestamp) => {
    return value === undefined || timestamp > value ? timestamp : value;
  }, undefined);
  if (latest !== undefined && now - latest < mandate.cooldownMinutes * 60_000) return blocked('COOLDOWN_ACTIVE');
  const dailyTotal = daily.reduce((total, item) => total + item.amountMinor, 0);
  const periodTotal = period.reduce((total, item) => total + item.amountMinor, 0);
  if (![dailyTotal, periodTotal, dailyTotal + input.amountMinor, periodTotal + input.amountMinor].every(Number.isSafeInteger)) {
    return blocked('AUTONOMY_CONFIGURATION_INVALID');
  }
  if (dailyTotal + input.amountMinor > mandate.dailyLimitMinor) return blocked('DAILY_LIMIT_EXCEEDED');
  if (periodTotal + input.amountMinor > mandate.periodLimitMinor) return blocked('PERIOD_LIMIT_EXCEEDED');
  if (period.length + (input.pendingTransactionCount ?? 0) >= mandate.maxTransactionsPerPeriod) return blocked('FREQUENCY_EXCEEDED');
  return { decision: 'AUTO_AUTHORIZE', reasonCode: 'OWNER_MANDATE_PREAUTHORIZED' };
}
