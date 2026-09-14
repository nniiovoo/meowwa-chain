import type { CategoryCode, NeedCode, PolicyReasonCode } from './codes.js';

/**
 * Sentinel used by the local rehearsal sandbox when transaction frequency
 * should not accumulate across repeated demo runs. Monetary, merchant,
 * product, wallet, and owner-approval controls still apply.
 */
export const UNLIMITED_TRANSACTIONS = Number.MAX_SAFE_INTEGER;

/**
 * Which product categories can answer a need at all.
 *
 * A need absent from this map is not a need a purchase can meet. `attention` is the clearest
 * case: a pet asking for company wants a person, and answering it with a product is the failure
 * mode this map exists to prevent. `stress_or_fear` and `possible_discomfort` call for owner
 * review, and `bathroom_or_litter` for a door, so all of them resolve to nothing purchasable.
 *
 * This is a separate question from what the owner allows. A mandate may list a need for reporting
 * or history, so the allowlist alone cannot be trusted to keep an unanswerable need out of a
 * purchase: a label being mentioned by a mandate does not mean a purchase can answer it.
 *
 * Deliberately only the two needs the suggestion path already serves. Adding an entry here widens
 * what the agent may propose, so it is an owner-facing product decision rather than a refactor.
 */
const PURCHASABLE_CATEGORIES_BY_NEED: Partial<Record<NeedCode, readonly CategoryCode[]>> = {
  hunger: ['PET_FOOD', 'TREATS'],
  play_or_enrichment: ['TOYS_ENRICHMENT'],
};

export function purchasableCategoriesForNeed(need: NeedCode): readonly CategoryCode[] {
  return PURCHASABLE_CATEGORIES_BY_NEED[need] ?? [];
}

/** Whether a purchase can answer this need at all, before any owner policy is consulted. */
export function needIsPurchasable(need: NeedCode): boolean {
  return purchasableCategoriesForNeed(need).length > 0;
}

/**
 * Whether a purchase in this category can answer this need. Checking the need and the category as
 * independent allowlist memberships let a hunger signal buy a toy: both sides passed on their own.
 */
export function categoryAnswersNeed(need: NeedCode, category: CategoryCode): boolean {
  return purchasableCategoriesForNeed(need).includes(category);
}

export interface PolicySpendEntry { amountMinor: number; executedAt: string }

/**
 * Entries settled inside the trailing `days`-day window ending at `now` (epoch milliseconds).
 *
 * The financial allowance and the autonomy money caps are the same question asked of the same
 * shape, so they share one cutoff. Anchoring spend separately is how the financial side ended up
 * with no anchor at all.
 */
export function withinTrailingWindow<Entry extends { executedAt: string }>(
  entries: readonly Entry[], now: number, days: number,
): Entry[] {
  const cutoff = now - days * 24 * 60 * 60_000;
  return entries.filter((entry) => Date.parse(entry.executedAt) > cutoff);
}

export interface PolicyMandate {
  status: 'ACTIVE' | 'DRAFT' | 'PENDING_APPROVAL' | 'EXHAUSTED' | 'EXPIRED' | 'REVOKED' | 'SUSPENDED';
  signatureVerified: boolean; nonceValid: boolean; validFrom: string; validUntil: string;
  allowedNeeds: NeedCode[]; allowedCategories: CategoryCode[];
  allowedMerchantIds: string[]; allowedProductIds: string[];
  token: 'USDC'; chainId: 84532; recipients: string[]; contracts: string[];
  perTransactionLimitMinor: number; periodLimitMinor: number; periodDays: number; reservedMinor: number;
  /** Settled spend this mandate must answer for; only the trailing `periodDays` of it counts. */
  periodSpend: readonly PolicySpendEntry[];
  maxTransactions: number; transactionCount: number;
}

export interface PolicyInput {
  authenticated: boolean; sourceVerified: boolean; now: string;
  ownerId: string; petId: string; requestOwnerId: string; requestPetId: string;
  interpretationConfirmed: boolean; interpretationValid: boolean;
  need: NeedCode; category: CategoryCode; merchantId: string; productId: string;
  token: 'USDC'; chainId: 84532; recipient: string; contract: string;
  amountMinor: number; walletBalanceMinor: number; quoteAmountMinor: number;
  quoteExpiresAt: string; quoteVerified: boolean; substitution: boolean; emergencyMode: boolean;
  replayDetected: boolean; anomalyDetected: boolean; policyVersion: string; requestPolicyVersion: string;
  mandate: PolicyMandate;
}

export interface PolicyDecision {
  decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK';
  reasonCodes: PolicyReasonCode[];
}

const blocked = (reason: PolicyReasonCode): PolicyDecision => ({ decision: 'BLOCK', reasonCodes: [reason] });
const nonEssential = new Set<CategoryCode>(['TOYS_ENRICHMENT', 'TREATS', 'GROOMING', 'BOARDING_DAYCARE']);

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const mandate = input.mandate;
  const now = Date.parse(input.now);
  const validFrom = Date.parse(mandate.validFrom);
  const validUntil = Date.parse(mandate.validUntil);
  const quoteExpiresAt = Date.parse(input.quoteExpiresAt);
  if (!input.authenticated) return blocked('UNAUTHENTICATED');
  if (!input.sourceVerified) return blocked('SOURCE_UNVERIFIED');
  if (![now, validFrom, validUntil, quoteExpiresAt].every(Number.isFinite)) return blocked('INVALID_TIMESTAMP');
  if (mandate.status !== 'ACTIVE') return blocked(mandate.status === 'EXPIRED' ? 'MANDATE_EXPIRED' : 'MANDATE_INACTIVE');
  if (!mandate.signatureVerified || !mandate.nonceValid) return blocked('MANDATE_INVALID');
  // Opposite ends of the validity window are opposite causes. Reporting a mandate whose window has
  // not opened as expired sends the owner to check an expiry that is really a start date, and the
  // autonomy layer already distinguishes the two (AUTONOMY_NOT_YET_VALID vs AUTONOMY_EXPIRED).
  if (now < validFrom) return blocked('MANDATE_NOT_YET_VALID');
  if (now >= validUntil) return blocked('MANDATE_EXPIRED');
  if (input.ownerId !== input.requestOwnerId || input.petId !== input.requestPetId) return blocked('OWNER_PET_MISMATCH');
  if (!input.interpretationValid) return blocked('INTERPRETATION_INVALID');
  if (!input.interpretationConfirmed) return blocked('INTERPRETATION_NOT_CONFIRMED');
  if (input.emergencyMode && nonEssential.has(input.category)) return blocked('EMERGENCY_NONESSENTIAL');
  // Allowed by the owner AND answerable by a purchase. A mandate may carry a need the owner wants
  // reported without wanting it shopped for, and `attention` listed there let a single signal reach
  // an approval prompt for a bag of dog food. Blocking here keeps the auditable BLOCKED record
  // and leaves the earlier safety gate's verdict in front where distress applies.
  if (!mandate.allowedNeeds.includes(input.need) || !needIsPurchasable(input.need)) return blocked('NEED_NOT_ALLOWED');
  // Allowed by the owner AND able to answer this need. Both allowlists passing independently is
  // what let a hunger signal reach an approval prompt for a feather wand.
  if (!mandate.allowedCategories.includes(input.category) ||
    !categoryAnswersNeed(input.need, input.category)) return blocked('CATEGORY_NOT_ALLOWED');
  if (!mandate.allowedMerchantIds.includes(input.merchantId)) return blocked('MERCHANT_NOT_ALLOWED');
  if (!mandate.allowedProductIds.includes(input.productId)) return blocked('PRODUCT_NOT_ALLOWED');
  if (input.token !== mandate.token) return blocked('TOKEN_NOT_ALLOWED');
  if (input.chainId !== mandate.chainId) return blocked('CHAIN_NOT_ALLOWED');
  if (!mandate.recipients.includes(input.recipient)) return blocked('RECIPIENT_NOT_ALLOWED');
  if (!mandate.contracts.includes(input.contract)) return blocked('CONTRACT_NOT_ALLOWED');
  if (!input.quoteVerified) return blocked('QUOTE_INVALID');
  if (now >= quoteExpiresAt) return blocked('QUOTE_EXPIRED');
  if (input.amountMinor !== input.quoteAmountMinor) return blocked('PRICE_CHANGED');
  if (input.substitution) return blocked('SUBSTITUTION_REQUIRES_APPROVAL');
  if (input.policyVersion !== input.requestPolicyVersion) return blocked('POLICY_VERSION_CHANGED');
  // The allowance the owner is shown is a 30-day limit, so it has to be enforced over a rolling
  // 30 days. Charging it against every settlement the mandate ever made turned it into a
  // lifetime cap with no reset, which a year-long mandate exhausts permanently.
  const settledInWindow = withinTrailingWindow(mandate.periodSpend, now, mandate.periodDays);
  const spentMinor = settledInWindow.reduce((total, entry) => total + entry.amountMinor, 0);
  const nonNegativeFinancialValues = [
    input.amountMinor, input.walletBalanceMinor, input.quoteAmountMinor,
    mandate.perTransactionLimitMinor, mandate.periodLimitMinor, mandate.periodDays, mandate.reservedMinor,
    mandate.maxTransactions, mandate.transactionCount,
    ...mandate.periodSpend.map((entry) => entry.amountMinor),
  ];
  if (!nonNegativeFinancialValues.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    mandate.perTransactionLimitMinor === 0 || mandate.periodLimitMinor === 0 || mandate.periodDays === 0 ||
    mandate.maxTransactions === 0 ||
    mandate.periodSpend.some((entry) => !Number.isFinite(Date.parse(entry.executedAt))) ||
    !Number.isSafeInteger(spentMinor + mandate.reservedMinor)) return blocked('ANOMALY_DETECTED');
  if (input.amountMinor > mandate.perTransactionLimitMinor) return blocked('TRANSACTION_LIMIT_EXCEEDED');
  if (input.amountMinor + spentMinor + mandate.reservedMinor > mandate.periodLimitMinor) return blocked('BUDGET_EXCEEDED');
  // The frequency cap is per-period in the contract (schemas.ts pairs `maxTransactions` with P30D)
  // and in the owner UI, which renders "N of M transactions used" under the 30-day allowance, so it
  // has to reset on the same rolling window the allowance above uses. Charging it against the
  // lifetime counter turned it into a cap with no reset, which a year-long mandate exhausts
  // permanently. `transactionCount` arrives as that lifetime settled count plus the caller's
  // still-held reservations, so the excess over the settled ledger is what is still in flight —
  // which must keep consuming the cap, or concurrent signals each pass it before any of them lands.
  const inFlightTransactionCount = Math.max(0, mandate.transactionCount - mandate.periodSpend.length);
  const periodTransactionCount = settledInWindow.length + inFlightTransactionCount;
  if (mandate.maxTransactions !== UNLIMITED_TRANSACTIONS &&
    periodTransactionCount >= mandate.maxTransactions) return blocked('FREQUENCY_EXCEEDED');
  if (input.amountMinor > input.walletBalanceMinor) return blocked('INSUFFICIENT_BALANCE');
  if (input.replayDetected) return blocked('REPLAY_DETECTED');
  if (input.anomalyDetected) return blocked('ANOMALY_DETECTED');
  return { decision: 'REQUIRE_APPROVAL', reasonCodes: ['ALPHA_OWNER_APPROVAL_REQUIRED'] };
}

export class BudgetLedger {
  readonly #reservations = new Map<string, number>();

  snapshot(): Array<[string, number]> {
    return [...this.#reservations.entries()];
  }

  restore(entries: Array<[string, number]>): void {
    const restored = new Map<string, number>();
    let total = 0;
    for (const [requestId, amountMinor] of entries) {
      if (typeof requestId !== 'string' || requestId.length === 0 || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        throw new Error('Invalid budget reservation snapshot');
      }
      if (restored.has(requestId)) throw new Error('Duplicate budget reservation');
      total += amountMinor;
      if (!Number.isSafeInteger(total)) throw new Error('Invalid budget reservation snapshot');
      restored.set(requestId, amountMinor);
    }
    this.#reservations.clear();
    for (const [requestId, amountMinor] of restored) this.#reservations.set(requestId, amountMinor);
  }

  reserve(requestId: string, amountMinor: number, limitMinor: number) {
    if (typeof requestId !== 'string' || requestId.length === 0 ||
      !Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
      !Number.isSafeInteger(limitMinor) || limitMinor < 0) {
      throw new Error('Invalid budget reservation');
    }
    const existing = this.#reservations.get(requestId);
    if (existing !== undefined) {
      if (existing !== amountMinor) throw new Error('Reservation amount conflict');
      return { ok: true as const, reservedMinor: this.reservedMinor };
    }
    const nextReservedMinor = this.reservedMinor + amountMinor;
    if (!Number.isSafeInteger(nextReservedMinor) || nextReservedMinor > limitMinor) return { ok: false as const, reason: 'BUDGET_EXCEEDED' as const };
    this.#reservations.set(requestId, amountMinor);
    return { ok: true as const, reservedMinor: this.reservedMinor };
  }

  release(requestId: string): number {
    this.#reservations.delete(requestId);
    return this.reservedMinor;
  }

  get reservedMinor(): number {
    return [...this.#reservations.values()].reduce((total, amount) => total + amount, 0);
  }

  get reservationCount(): number {
    return this.#reservations.size;
  }

  reservedFor(requestId: string): number {
    return this.#reservations.get(requestId) ?? 0;
  }
}
