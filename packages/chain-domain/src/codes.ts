export const SPECIES = ['cat', 'dog'] as const;

/**
 * A need is an opaque label: the vocabulary is owned by the interpretation service, which is not
 * part of this repository, and is deliberately not enumerated here. Nothing in this package decides
 * which need a pet has, or what the set of possible needs is. The money rails only ever compare a
 * need against the owner's own allowlist and record it, so a validated shape is all they require —
 * and keeping the set open means a new label never needs a change here to be spendable against.
 */
export const NEED_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** A validated need label. Opaque by construction: see NEED_CODE_PATTERN above. */
export type NeedCode = string;

export function isNeedCode(value: string): boolean {
  return NEED_CODE_PATTERN.test(value);
}

export const CATEGORY_CODES = [
  'PET_FOOD',
  'WATER',
  'CAT_LITTER',
  'MEDICATION',
  'VET_CARE',
  'GROOMING',
  'TOYS_ENRICHMENT',
  'TREATS',
  'INSURANCE',
  'BOARDING_DAYCARE',
  'EMERGENCY_CARE',
] as const;

// Every household role that can act is an actor code, because the audit trail records who did a
// thing and a delegated member's action written as 'owner' is the one mistake an audit trail
// cannot make. Widening only: no code path reads this set at runtime, so a replica on either
// side of a rollout stores and renders both the old and the new values unchanged.
export const ACTOR_CODES = [
  'owner', 'co_owner', 'caregiver', 'view_only', 'agent', 'system', 'provider', 'support', 'admin',
] as const;
export const MANDATE_STATES = [
  'DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED', 'SUSPENDED',
] as const;
export const REQUEST_STATES = [
  'DRAFT', 'EVALUATING', 'BLOCKED', 'AWAITING_APPROVAL', 'AUTHORIZED',
  'DECLINED', 'EXPIRED', 'SUBMITTING', 'CONFIRMED', 'FAILED', 'REFUNDED', 'DISPUTED', 'CANCELLED',
] as const;
export const POLICY_REASON_CODES = [
  'ALPHA_OWNER_APPROVAL_REQUIRED', 'UNAUTHENTICATED', 'SOURCE_UNVERIFIED', 'INVALID_TIMESTAMP',
  'MANDATE_INVALID', 'MANDATE_EXPIRED', 'MANDATE_NOT_YET_VALID', 'MANDATE_INACTIVE', 'OWNER_PET_MISMATCH',
  'INTERPRETATION_INVALID', 'INTERPRETATION_NOT_CONFIRMED', 'EMERGENCY_NONESSENTIAL',
  'NEED_NOT_ALLOWED', 'CATEGORY_NOT_ALLOWED', 'MERCHANT_NOT_ALLOWED', 'PRODUCT_NOT_ALLOWED',
  'TOKEN_NOT_ALLOWED', 'CHAIN_NOT_ALLOWED', 'RECIPIENT_NOT_ALLOWED', 'CONTRACT_NOT_ALLOWED',
  'QUOTE_INVALID', 'QUOTE_EXPIRED', 'PRICE_CHANGED', 'SUBSTITUTION_REQUIRES_APPROVAL',
  'TRANSACTION_LIMIT_EXCEEDED', 'BUDGET_EXCEEDED', 'FREQUENCY_EXCEEDED',
  'INSUFFICIENT_BALANCE', 'POLICY_VERSION_CHANGED', 'REPLAY_DETECTED', 'ANOMALY_DETECTED',
  'SAFETY_REVIEW_REQUIRED',
] as const;

export type Species = (typeof SPECIES)[number];
export type CategoryCode = (typeof CATEGORY_CODES)[number];
export type Actor = (typeof ACTOR_CODES)[number];
export type MandateState = (typeof MANDATE_STATES)[number];
export type RequestState = (typeof REQUEST_STATES)[number];
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
export const BASE_SEPOLIA_USDC_CONTRACT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const BASE_MAINNET_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
/** Circle's canonical USDC mints. Devnet USDC is Circle's own faucet mint, not a look-alike. */
export const SOLANA_MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM4tf7UfF2h3kRFzJMbPfEqTLu3bT' as const;
export const SOLANA_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as const;
/** Full genesis hashes; a reader compares the RPC's `getGenesisHash` against these, not a URL. */
export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' as const;
export const SOLANA_DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' as const;
export const TEST_USDC = 'USDC' as const;
