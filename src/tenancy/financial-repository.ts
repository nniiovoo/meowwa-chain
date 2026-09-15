import { createHash } from 'node:crypto';
import { decryptTenantJson } from './crypto.js';
import {
  CHAINS,
  chainByEvmChainId,
  chainByKey,
  isCanonicalUsdcAsset,
  isChainAddress,
  isChainTransactionId,
  isEvmChain,
  type ChainDescriptor,
  type ChainKey,
} from '@meowwa/chain-domain';
import { isCanonicalTenantId } from '../auth.js';
import {
  canonicalChainAddress,
  canonicalChainBlockHash,
  canonicalChainTransactionId,
  controlChainFor,
  fundingChainFor,
  isAtomicAmount,
  isChainBlockHash,
  isControlChainKey,
  isEvmAddress,
  isEvmTransactionHash,
  isFundingChainKey,
  parseAtomicAmount,
  sameAddressOn,
  type ControlChainKey,
  type FundingChainKey,
} from '../funding/types.js';
import type { PgClientLike, PgPoolLike } from './postgres-repository.js';
import {
  TenantWalletExecutionConflictError,
  type PrepareTenantWalletExecutionInput,
  type TenantWalletExecutionStatus,
  type TenantWalletExecutionSubmission,
} from './tenant-wallet-execution.js';

export type TenantFundingRail = 'stripe_onramp' | 'direct_usdc';
type TenantFundingStatus = 'pending' | 'settled' | 'failed' | 'refunded';
type TenantFundingReconciliation =
  | 'awaiting_provider'
  | 'awaiting_chain'
  | 'confirmed'
  | 'chargeback_review'
  | 'provider_refunded'
  | 'manual_review';

export interface TenantWithdrawalDestination {
  tenantId: string;
  destinationId: string;
  chainKey: FundingChainKey;
  /** The EVM chain id on an EVM rail; null on Solana, whose registry identity is the chain key. */
  chainId: number | null;
  address: string;
  label: string;
  status: 'active' | 'retired';
  registeredBy: string;
  createdAt: string;
  retiredAt: string | null;
}

/**
 * Every status below is derived, and every one of them names the code path that clears it. A
 * withdrawal holds a reservation against the wallet's withdrawable balance until it reaches a
 * status that releases it, so a status with no closer is the owner's money with no way out.
 *
 * awaiting_owner_signature -> acknowledgeWithdrawalBroadcast, cancelPreparedWithdrawal,
 *                             expireStaleWithdrawals
 * dispatch_review          -> acknowledgeWithdrawalBroadcast (a late hash),
 *                             cancelPreparedWithdrawal, which is accepted the moment it arrives
 *                             from any client, with or without a decline report, or
 *                             expireStaleWithdrawals attributing the debit the chain already shows
 *                             (-> confirmed), which needs no owner action at all
 * broadcast                -> the indexer's recordWalletOutflow (-> confirmed), whether it lands
 *                             under the hash the wallet reported or the replacement one it
 *                             actually sent, or -- when it never lands at all, which no indexer
 *                             event can ever announce -- `broadcastNeverLanded` releasing the
 *                             reservation a day after the broadcast, once the scan cursor proves
 *                             the chain was looked at in the meantime and still shows no debit
 * cancelled / provider_rejected / expired -> terminal, reservation released
 * confirmed                -> terminal; recordBaseReorgHalt may move it to reorg_review
 * reorg_review             -> re-canonicalizing the event, which is deliberately an operator
 *                             action through the migration authority (docs/runbooks/BASE_REORG.md)
 *                             because it raises balances: NO in-process code path clears it. It
 *                             holds no reservation, so an unresolved one costs the owner nothing
 *                             beyond the ledger debit the chain no longer backs.
 */
type TenantWithdrawalStatus =
  | 'awaiting_owner_signature'
  | 'cancelled'
  // Cancelled after the transfer was handed to the provider. The owner closed it and this server
  // observed no broadcast, which is strictly weaker than 'cancelled': only 'cancelled' may claim
  // nothing was sent.
  | 'provider_rejected'
  // Reserved for too long with no broadcast and never dispatched: the intent was closed by the
  // reaper and its reservation released. Only a never-dispatched intent may expire — that is the
  // one case where "nothing was sent" is provable.
  | 'expired'
  // Dispatched to the wallet provider, stale, and no outcome was ever observed. The funds may
  // have moved, so the reservation stays held until provider or chain evidence resolves it: a
  // late broadcast acknowledgement, an owner-reported provider decline, or an operator.
  | 'dispatch_review'
  | 'broadcast'
  | 'confirmed'
  | 'reorg_review';

const tenantWithdrawalStatuses: readonly TenantWithdrawalStatus[] = [
  'awaiting_owner_signature', 'cancelled', 'provider_rejected', 'expired', 'dispatch_review', 'broadcast', 'confirmed', 'reorg_review',
];

export interface TenantWithdrawal {
  tenantId: string;
  withdrawalId: string;
  petId: string;
  walletId: string;
  bindingFingerprint: string;
  destinationId: string;
  destinationAddress: string;
  amountAtomic: string;
  chainKey: FundingChainKey;
  chainId: number | null;
  /** Canonical USDC on the rail: the ERC-20 contract on an EVM chain, the SPL mint on Solana. */
  tokenAddress: string;
  status: TenantWithdrawalStatus;
  /** The EVM transaction hash, or the Solana signature. */
  transactionHash: string | null;
  /**
   * Whether this intent's amount is still held against the wallet's withdrawable balance, from the
   * server's own reservation predicate. The dashboard balance is already net of it; this says which
   * rows the difference is in, so a client can state it instead of subtracting a second time.
   */
  holdsReservation: boolean;
  createdAt: string;
  dispatchedAt: string | null;
  expiredAt: string | null;
  reviewRequiredAt: string | null;
  broadcastAt: string | null;
  cancelledAt: string | null;
  confirmedAt: string | null;
  updatedAt: string;
}

export interface TenantLedgerReconciliation {
  tenantId: string;
  walletId: string;
  chainKey: FundingChainKey;
  ledgerAtomic: string;
  canonicalChainAtomic: string;
  reorgedCreditAtomic: string;
  reorgedDebitAtomic: string;
  inFlightWithdrawalAtomic: string;
  consistent: boolean;
}

export interface TenantFundingTransaction {
  tenantId: string;
  fundingId: string;
  petId: string;
  walletId: string;
  walletAddress: string;
  rail: TenantFundingRail;
  status: TenantFundingStatus;
  reconciliationStatus: TenantFundingReconciliation;
  sourceCurrency: 'usd' | null;
  sourceAmountMinor: number | null;
  destinationCurrency: 'usdc';
  destinationAmountAtomic: string | null;
  chainKey: FundingChainKey;
  chainId: number | null;
  providerSessionId: string | null;
  transactionHash: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantWalletBinding {
  tenantId: string;
  walletId: string;
  petId: string;
  provider: 'privy';
  privyEmbeddedWalletId: string;
  smartWalletAddress: string;
  ownerQuorumId: string | null;
  agentSignerId: string | null;
  agentPolicyId: string | null;
  policyDigest: string | null;
  ownerPrivyUserId: string | null;
  policyValidUntil: string | null;
  controlVerifiedAt: string | null;
  /** The control-plane network this binding was provisioned on. */
  chainKey: ControlChainKey;
  chainId: number | null;
  /** The production rail this binding is attested to fund: the same family as `chainKey`. */
  fundingChainKey?: FundingChainKey;
  fundingChainId?: number | null;
  fundingEnvironment?: 'production';
  custodyClassification?: 'owner_controlled';
  fundingVerifiedAt?: string;
  status: 'provisioning' | 'active' | 'failed' | 'disabled' | 'revoked' | 'drifted';
  revocationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const tenantPetDeletionBlockers = [
  'not_found', 'not_archived', 'signer_not_revoked', 'nonzero_balance', 'funding_unsettled',
  'payment_unsettled', 'merchant_unsettled', 'withdrawal_unsettled', 'financial_review_open',
] as const;
export type TenantPetDeletionBlocker = typeof tenantPetDeletionBlockers[number];

export interface TenantWalletExecutionReconciliationClaim {
  tenantId: string;
  submissionId: string;
  workerId: string;
  lockedUntil: string;
  fenceToken: number;
}

interface FundingRow extends Record<string, unknown> {
  tenant_id: string;
  funding_id: string;
  pet_id: string;
  wallet_id: string;
  wallet_address: string;
  rail: TenantFundingRail;
  status: TenantFundingStatus;
  reconciliation_status: TenantFundingReconciliation;
  source_currency: 'usd' | null;
  source_amount_minor: number | string | null;
  destination_currency: 'usdc';
  destination_amount_atomic: string | null;
  chain_key?: string | null;
  chain_id: number | string | null;
  provider_session_id: string | null;
  transaction_hash: string | null;
  failure_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WalletRow extends Record<string, unknown> {
  tenant_id?: string;
  wallet_id: string;
  pet_id: string;
  provider?: 'privy';
  privy_embedded_wallet_id?: string;
  smart_wallet_address: string;
  owner_quorum_id?: string | null;
  agent_signer_id?: string | null;
  agent_policy_id?: string | null;
  policy_digest?: string | null;
  owner_identity_ciphertext?: string | null;
  policy_valid_until?: Date | string | null;
  control_verified_at?: Date | string | null;
  chain_key?: string | null;
  chain_id?: number | string | null;
  funding_chain_key?: string | null;
  funding_chain_id?: number | string | null;
  funding_environment?: string | null;
  custody_classification?: string | null;
  funding_verified_at?: Date | string | null;
  status: TenantWalletBinding['status'];
  revocation_reason?: string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface WalletExecutionRow extends Record<string, unknown> {
  tenant_id: string;
  submission_id: string;
  request_id: string;
  owner_subject: string;
  pet_id: string;
  wallet_id: string;
  provider_wallet_id: string;
  owner_quorum_id: string;
  agent_signer_id: string;
  agent_policy_id: string;
  policy_digest: string;
  policy_valid_until: Date | string;
  control_verified_at: Date | string;
  intent_hash: string;
  reference_id: string;
  chain_key?: string | null;
  chain_id: number | string | null;
  contract: string;
  sender: string;
  recipient: string;
  amount_atomic: string;
  value_atomic: string;
  calldata: string;
  status: TenantWalletExecutionStatus;
  provider_transaction_id: string | null;
  user_operation_hash: string | null;
  transaction_hash: string | null;
  block_hash: string | null;
  block_number: number | string | null;
  log_index: number | string | null;
  failure_code: string | null;
  confirmed_at: Date | string | null;
  application_settled_at: Date | string | null;
  blind_submit_attempts?: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number | string;
}

interface WalletExecutionClaimRow extends Record<string, unknown> {
  tenant_id: string;
  submission_id: string;
  locked_until: Date | string;
  fence_token: number | string;
}

/**
 * Exactly the columns `mapWallet` reads, which is what makes one list correct for every caller: a
 * query that projects less does not fail, it maps the missing column to that field's `?? null`
 * default. Thirteen hand-copied copies of this list omitted `revocation_reason`, so
 * `TenantWalletBinding.revocationReason` was structurally always null on those paths — it could not
 * tell 'not revoked' from 'not selected'. `stageExpiredPolicyRotation`, `recordPolicyRotationTarget`,
 * `activateVerifiedPolicyRotation` and `saveVerifiedBinding` place no `status` filter in SQL, so
 * they do map revoked and drifted rows; each rejects one afterwards on the mapped `status`, which
 * is the only reason a null reason was never returned to a caller.
 *
 * `owner_identity_ciphertext` is deliberately not here: `mapWallet` never reads it, and only
 * `getVerifiedBinding` — the one method holding the identity key — selects and decrypts it. Keeping
 * it out of the shared list keeps the sealed owner DID out of every query that has no use for it.
 */
const walletBindingColumns = `tenant_id::text, wallet_id, pet_id, provider, privy_embedded_wallet_id,
  smart_wallet_address::text, owner_quorum_id, agent_signer_id, agent_policy_id, policy_digest,
  revocation_reason,
  policy_valid_until, control_verified_at, chain_key, chain_id, funding_chain_key, funding_chain_id,
  funding_environment, custody_classification, funding_verified_at, status, created_at, updated_at`;

const walletExecutionColumns = `tenant_id::text, submission_id, request_id, owner_subject, pet_id, wallet_id,
  provider_wallet_id, owner_quorum_id, agent_signer_id, agent_policy_id, policy_digest,
  policy_valid_until, control_verified_at, intent_hash, reference_id, chain_key, chain_id, contract::text,
  sender::text, recipient::text, amount_atomic::text, value_atomic::text, calldata, status,
  provider_transaction_id, user_operation_hash::text, transaction_hash::text, block_hash::text,
  block_number, log_index, failure_code, confirmed_at, application_settled_at,
  blind_submit_attempts, created_at, updated_at, version`;

const fundingColumns = `tenant_id::text, funding_id, pet_id, wallet_id, wallet_address::text, rail, status,
  reconciliation_status, source_currency, source_amount_minor, destination_currency,
  destination_amount_atomic::text, chain_key, chain_id, provider_session_id, transaction_hash::text,
  failure_code, created_at, updated_at`;

/** One projection for the four destination queries, so `chain_key` cannot be missed on any of them. */
const withdrawalDestinationColumns = `tenant_id::text, destination_id, chain_key, chain_id, address::text, label, status,
  registered_by, created_at, retired_at`;

const fundingStatuses = new Set<TenantFundingStatus>(['pending', 'settled', 'failed', 'refunded']);
const reconciliationStatuses = new Set<TenantFundingReconciliation>([
  'awaiting_provider', 'awaiting_chain', 'confirmed', 'chargeback_review', 'provider_refunded', 'manual_review',
]);
const walletExecutionStatuses = new Set<TenantWalletExecutionStatus>([
  'prepared', 'submitting', 'submitted', 'provider_confirmed', 'confirmed', 'unknown', 'failed', 'review_required',
]);

export class TenantFundingIdempotencyConflictError extends Error {
  constructor() {
    super('Funding idempotency key was already used for a different request');
    this.name = 'TenantFundingIdempotencyConflictError';
  }
}

export class TenantWithdrawalIdempotencyConflictError extends Error {
  constructor() {
    super('Withdrawal idempotency key was already used for a different request');
    this.name = 'TenantWithdrawalIdempotencyConflictError';
  }
}

/** The chain already shows this withdrawal's debit, so it can no longer be cancelled or rejected. */
export class TenantWithdrawalSettledError extends Error {
  constructor() {
    super('Withdrawal already moved funds on-chain and cannot be cancelled');
    this.name = 'TenantWithdrawalSettledError';
  }
}

/** More USDC is already committed to in-flight withdrawals than the reconciled ledger holds. */
export class TenantWithdrawalInsufficientFundsError extends Error {
  constructor(readonly availableAtomic: string) {
    super('Withdrawal exceeds the reconciled balance not already committed to another withdrawal');
    this.name = 'TenantWithdrawalInsufficientFundsError';
  }
}

export class TenantWithdrawalDispatchConflictError extends Error {
  constructor() {
    super('Tenant withdrawal can no longer be dispatched');
    this.name = 'TenantWithdrawalDispatchConflictError';
  }
}

export type TenantOnrampEvidenceConflictReason =
  | 'provider_fulfillment_conflict'
  | 'provider_terminal_state_conflict'
  | 'multiple_canonical_chain_credits';

export class TenantOnrampEvidenceConflictError extends Error {
  readonly reason: TenantOnrampEvidenceConflictReason;
  readonly evidence: string;

  constructor(reason: TenantOnrampEvidenceConflictReason, evidence: string) {
    super(`Tenant Onramp evidence requires manual review: ${reason}`);
    this.name = 'TenantOnrampEvidenceConflictError';
    this.reason = reason;
    this.evidence = evidence;
  }
}

function validIdentifier(value: string, maximum = 255): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value;
}

function validOperation(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,127}$/.test(value);
}

type WithdrawalDestinationRow = {
  tenant_id: string;
  destination_id: string;
  chain_key?: string | null;
  chain_id: number | string | null;
  address: string;
  label: string;
  status: string;
  registered_by: string;
  created_at: Date | string;
  retired_at: Date | string | null;
} & Record<string, unknown>;

type WithdrawalRow = {
  tenant_id: string;
  withdrawal_id: string;
  pet_id: string;
  wallet_id: string;
  binding_fingerprint: string;
  destination_id: string;
  destination_address: string;
  amount_atomic: string;
  chain_key?: string | null;
  chain_id: number | string | null;
  token_address: string;
  effective_status: string;
  transaction_hash: string | null;
  holds_reservation: boolean;
  created_at: Date | string;
  dispatched_at: Date | string | null;
  expired_at: Date | string | null;
  review_required_at: Date | string | null;
  broadcast_at: Date | string | null;
  cancelled_at: Date | string | null;
  confirmed_at: Date | string | null;
  updated_at: Date | string;
} & Record<string, unknown>;

/**
 * The columns that make a chain debit this intent's transfer, minus the transaction hash.
 *
 * One definition, four readers -- `settledAtRecordedHash`, the reorg lateral,
 * `unattributedChainDebit` and `chainDebitSettlesIntent`. They used to be four hand-copied
 * predicates, and the copies disagreed: the reservation released only on
 * `chain.transaction_hash = withdrawal.transaction_hash`
 * while the cancellation veto matched hashlessly, so an intent whose acknowledgement was lost was
 * simultaneously "already settled, cannot cancel" and "still reserved" -- the amount charged by the
 * ledger and held against the balance at the same time, with no owner action that cleared it.
 */
const chainDebitMatchesIntent = (intent: string, chain: string) => `${chain}.tenant_id = ${intent}.tenant_id
  AND ${chain}.chain_key = ${intent}.chain_key
  AND ${chain}.wallet_id = ${intent}.wallet_id
  AND ${chain}.direction = 'debit'
  AND ${chain}.amount_atomic = ${intent}.amount_atomic
  AND ${chain}.counterparty_address = ${intent}.destination_address`;

/** Whether the chain canonically shows the transfer this intent already recorded a hash for. */
const settledAtRecordedHash = (intent: string) => `EXISTS (
  SELECT 1 FROM meowwa_wallet_chain_events AS settled
  WHERE ${chainDebitMatchesIntent(intent, 'settled')}
    AND settled.transaction_hash = ${intent}.transaction_hash
    AND settled.canonical_status = 'canonical'
)`;

/**
 * A chain debit that could be this withdrawal's transfer, keyed on nothing the client reported.
 *
 * The match is (wallet, amount, destination) observed since the intent was created -- which is not
 * unique: two identical prepared withdrawals both match a single debit. A debit whose hash is
 * already another intent's recorded broadcast belongs to that intent, so it is excluded here.
 * Without the exclusion the first withdrawal's settled transfer made the second one read as settled
 * (uncancellable) and block its own expiry, holding that amount against the withdrawable balance
 * forever.
 *
 * Expects the withdrawal side to be aliased `withdrawal` and the event side `chain`.
 */
const unattributedChainDebit = `${chainDebitMatchesIntent('withdrawal', 'chain')}
  AND chain.observed_at >= withdrawal.created_at
  AND NOT EXISTS (
    SELECT 1 FROM meowwa_withdrawals AS claimed
    WHERE claimed.tenant_id = chain.tenant_id
      AND claimed.chain_key = chain.chain_key
      AND claimed.transaction_hash = chain.transaction_hash
      AND claimed.withdrawal_id <> withdrawal.withdrawal_id
  )`;

/**
 * Another open intent that a debit matching this one would match just as well.
 *
 * One definition, two readers, because they are two halves of the same question. The sweep refuses
 * to ATTRIBUTE a debit while a rival exists -- a claim is a statement about whose money moved, and
 * with two identical open intents the server cannot know. Cancellation is the mirror: the veto that
 * says "Base already shows this transfer" is only true of ONE of them, so refusing both left the
 * owner holding two rows reading "outcome unknown", each answered by a notice telling them to
 * cancel, and a server that refused every time -- a status with no closer at all. With a rival
 * present the cancellation is honest for at least one row and costs nothing either way: every
 * matching intent already reads the same debit hashlessly, so none of them holds a reservation and
 * releasing changes no balance. Closing one is also what resolves the other, since the next sweep
 * finds no rival left and attributes the debit durably (-> confirmed).
 *
 * A rival that already settled at its OWN recorded hash is not a rival: that debit is claimed and
 * `unattributedChainDebit` excludes it from this intent's evidence in the first place.
 *
 * Expects the intent side to be aliased `withdrawal`.
 */
const rivalOpenIntent = `SELECT 1 FROM meowwa_withdrawals AS rival
  WHERE rival.tenant_id = withdrawal.tenant_id AND rival.wallet_id = withdrawal.wallet_id
    AND rival.withdrawal_id <> withdrawal.withdrawal_id
    AND rival.amount_atomic = withdrawal.amount_atomic
    AND rival.destination_address = withdrawal.destination_address
    AND rival.cancelled_at IS NULL AND rival.expired_at IS NULL
    AND rival.dispatched_at IS NOT NULL
    AND NOT ${settledAtRecordedHash('rival')}`;

/**
 * A chain debit that could be this intent's transfer: the one it recorded a hash for, or an
 * unattributed match.
 *
 * One definition, two readers -- the canonical evidence lateral and `withdrawalHoldsReservation`.
 * They were hand-copied and disagreed on BOTH disjuncts, once in each direction:
 *
 *  - The lateral matched an unattributed debit with no rival guard, so two identical intents whose
 *    transfer landed under a replacement hash BOTH read `confirmed` off the single debit, each
 *    linking the owner to the same BaseScan transaction -- 8 USDC of receipts for a 4 USDC
 *    transfer, on a screen whose balance correctly said 6. `confirmed` is terminal, so no owner,
 *    reaper or indexer ever revisited it. Hence `rivalsExcluded`: a receipt is a statement about
 *    whose money moved, and with a rival open the server cannot know, so it declines to name one
 *    and both rows stay `broadcast` -- which `broadcastNeverLanded` closes, and which the owner can
 *    close sooner by cancelling either (the veto stands down while a rival competes).
 *  - The reservation matched ONLY hashlessly, and `unattributedChainDebit` guards on
 *    `chain.observed_at >= withdrawal.created_at` -- the indexer PROCESS's wall clock compared
 *    against the database's `transaction_timestamp()`. A worker clock trailing the database by more
 *    than the observation delay (about a minute) made a settled withdrawal read `confirmed` off its
 *    own recorded hash while still reserving the amount its ledger debit had already charged:
 *    charged and held at once, exactly the failure `withdrawalHoldsReservation` says was
 *    eliminated, and released only by `broadcastNeverLanded` a day later. Reservations accumulate,
 *    so a wallet with a few settled withdrawals offered nothing at all. Matching the recorded hash
 *    here costs nothing -- the chain shows that very transfer and its ledger entry already charges
 *    the amount -- and needs no clock on either side.
 *
 * The rival guard is attribution's alone. Reservations deliberately over-release under ambiguity
 * (see `withdrawalHoldsReservation`): holding both siblings is the strand this family exists to
 * prevent, and every competing intent reads the same debit anyway, so none of them reserves.
 *
 * Expects the withdrawal side aliased `withdrawal` and the event side `chain`.
 */
const chainDebitSettlesIntent = (rivalsExcluded: boolean) => `${chainDebitMatchesIntent('withdrawal', 'chain')}
  AND (chain.transaction_hash = withdrawal.transaction_hash OR ((${unattributedChainDebit})${
    rivalsExcluded ? `
    AND NOT EXISTS (${rivalOpenIntent})` : ''}))`;

/**
 * The settlement evidence for an intent, and the hash the chain actually carried it under.
 *
 * The recorded hash is what the owner's wallet reported; the chain is what happened. A wallet that
 * replaces a transaction (speed-up, gas bump) lands the transfer under a different hash, and keying
 * only on the recorded one left the intent reading "awaiting confirmation" forever, with no code
 * path -- owner, reaper or indexer -- that could ever close it. So a hash-bearing intent also
 * settles on an unattributed canonical debit -- but only one no rival open intent could claim just
 * as well (`chainDebitSettlesIntent`), or one transfer becomes the receipt for two withdrawals --
 * and `withdrawalColumns` reports that debit's hash: otherwise the owner's BaseScan link points at
 * a transaction that does not exist. Its own recorded hash still wins when both match, and the
 * stored column keeps what the client reported.
 *
 * Hashless intents are deliberately excluded here -- `expireStaleWithdrawals` attributes their
 * debit durably instead, so the stored row, not just the projection, says what settled it.
 */
const withdrawalEvidenceJoins = `
  LEFT JOIN LATERAL (
    SELECT chain.transaction_hash, chain.observed_at
    FROM meowwa_wallet_chain_events AS chain
    WHERE ${chainDebitSettlesIntent(true)}
      AND chain.canonical_status = 'canonical'
      AND withdrawal.transaction_hash IS NOT NULL
    ORDER BY (chain.transaction_hash = withdrawal.transaction_hash) DESC, chain.observed_at, chain.log_index
    LIMIT 1
  ) AS canonical ON true
  LEFT JOIN LATERAL (
    SELECT chain.transaction_hash
    FROM meowwa_wallet_chain_events AS chain
    WHERE ${chainDebitMatchesIntent('withdrawal', 'chain')}
      AND chain.transaction_hash = withdrawal.transaction_hash
      AND chain.canonical_status = 'reorged'
    ORDER BY chain.log_index
    LIMIT 1
  ) AS reorged ON true`;

/**
 * A broadcast the chain has been scanned past and never showed: the transfer never landed.
 *
 * `broadcast` had exactly one closer, `recordWalletOutflow`, and it only ever fires for a transfer
 * that IS mined. A transfer that is dropped as underpriced, replaced by an abort, or mined-but-
 * reverted (a reverted ERC-20 or SPL transfer moves no balance) produces no debit, ever -- so the
 * intent stayed reserved for good, the dashboard read 0, and no owner action reached it: cancel
 * and expiry both require a hashless row, and re-broadcast refuses a second hash. The owner's whole
 * withdrawable balance became unreachable through the app with nothing adversarial anywhere in the
 * story. This is the second closer, and it needs no owner action at all.
 *
 * Two pieces of evidence, and BOTH are required, because "no debit" on its own is also what an
 * indexer that has not looked yet says. First, a day past the broadcast: an inclusion window wider
 * than any plausible mempool lifetime on either rail, and wide enough that a transfer landing after
 * it would be extraordinary rather than routine. Second -- and this is the condition the INDEXER must
 * confirm -- that the chain's scan cursor for this very token advanced after that window closed, which
 * is the only proof this server has that something actually looked at the chain in the meantime.
 * While the indexer is stopped the cursor stops with it and the reservation keeps holding, which is
 * the fail-closed direction: a stalled indexer must never be mistaken for an empty chain.
 *
 * Release is safe here for the same reason it is on the cancel path. If the transaction does land
 * afterwards, `recordWalletOutflow` writes the chain event and the ledger debit in one transaction,
 * so the amount is charged exactly once -- by the ledger, which needs no reservation -- and the row
 * reads `confirmed` again off the canonical evidence join. Every outflow from the wallet is an
 * on-chain transfer from that same wallet, so the worst an over-release can do is let the owner
 * authorize a transfer their own wallet has no balance for, which the chain refuses. Holding it
 * strands their money with no code path back, which nothing else does.
 *
 * Deliberately not gated on the reorg halt: the request path and the balance projection both fail
 * closed on an unresolved halt already (modules/core.ts), and a debit that WAS observed and then
 * reorged still matches `unattributedChainDebit`, which releases on any canonical status.
 *
 * Expects the withdrawal side to be aliased `withdrawal`.
 */
const broadcastNeverLanded = `withdrawal.broadcast_at IS NOT NULL
  AND withdrawal.broadcast_at < transaction_timestamp() - interval '24 hours'
  AND EXISTS (
    SELECT 1 FROM meowwa_chain_scan_cursors AS scan
    WHERE scan.chain_key = withdrawal.chain_key
      AND scan.contract_address = withdrawal.token_address
      AND scan.updated_at > withdrawal.broadcast_at + interval '24 hours'
  )`;

/**
 * Whether this intent still holds its amount against the wallet's withdrawable balance.
 *
 * Observed, not canonical, and hashless. A debit event and its ledger entry are written in the same
 * transaction, so once a matching debit exists the amount is already charged by the ledger and
 * reserving it again charges it twice. Filtering on canonical_status did exactly that after a
 * reorg: recordBaseReorgHalt flips the settled debit to 'reorged' but deliberately leaves the
 * ledger entry as the audit trail, so the reservation reappeared on top of it (10 USDC wallet, 2.5
 * withdrawn, 5.0 offered) and reorg_review is a status no in-process code path clears -- the amount
 * was stranded until an operator re-canonicalized. Keying on the *recorded hash* stranded it the
 * same way whenever the hash never reached the server, or the wallet replaced the transaction:
 * charged by the ledger, reserved forever, and cancellation refused because the very same debit
 * proved the transfer had happened. Reorged CREDITS still subtract, in their own term at each call
 * site: the chain no longer backs those funds.
 *
 * The hashless match is not unique -- two identical open intents both read a single debit as
 * theirs, so both release and the wallet is offered one amount too many. That direction is the
 * deliberate one: over-releasing can at worst let the owner authorize a transfer their own wallet
 * has no balance for, which the chain refuses, while under-releasing strands their money with no
 * code path back. Ranking the siblings would fix the offer and reintroduce the strand, because an
 * older intent stuck with no debit would then hold a younger one's settled amount hostage.
 *
 * Expects the withdrawal side to be aliased `withdrawal`.
 */
const withdrawalHoldsReservation = `withdrawal.cancelled_at IS NULL
  AND (withdrawal.expired_at IS NULL OR withdrawal.transaction_hash IS NOT NULL)
  AND NOT (${broadcastNeverLanded})
  AND NOT EXISTS (
    SELECT 1 FROM meowwa_wallet_chain_events AS chain
    WHERE ${chainDebitSettlesIntent(false)}
  )`;

/**
 * ponytail: the cancelled branches below resolve before any chain evidence, and a cancelled row
 * never gets a transaction hash, so the evidence laterals -- which key on one -- can never link a
 * debit indexed after the cancellation: the row keeps reporting provider_rejected. Reachable
 * whenever a transfer lands despite an EIP-1193 4001 decline, a window that widened from "never"
 * to "the indexer's scan lag" when cancelPreparedWithdrawal stopped gating the owner's report on a
 * clock -- the gate that made this unreachable was also what stranded the reservation forever, so
 * the narrative imprecision is the deliberate trade. The MONEY is right either way: the debit's
 * ledger entry is written with the chain event, a cancelled row reserves nothing, and
 * `holds_reservation` says so, so the amount is charged exactly once. Upgrade path unchanged: a
 * hashless lateral over unattributedChainDebit and a status meaning "cancelled, then a matching
 * debit appeared" -- which needs apps/web's withdrawal status union and record invariants widened
 * in the same change.
 *
 * `holds_reservation` is the row-level half of `inFlightWithdrawalReservation`, projected so a
 * client can name the amount its balance is missing without re-deriving the server's predicate --
 * the derivation that drifted, and offered a maximum the next request refused.
 */
const withdrawalColumns = `withdrawal.tenant_id::text, withdrawal.withdrawal_id, withdrawal.pet_id,
  withdrawal.wallet_id, withdrawal.binding_fingerprint, withdrawal.destination_id,
  withdrawal.destination_address::text, withdrawal.amount_atomic::text, withdrawal.chain_key,
  withdrawal.chain_id, withdrawal.token_address::text,
  CASE
    WHEN withdrawal.cancelled_at IS NOT NULL AND withdrawal.dispatched_at IS NULL THEN 'cancelled'
    WHEN withdrawal.cancelled_at IS NOT NULL THEN 'provider_rejected'
    WHEN withdrawal.expired_at IS NOT NULL AND withdrawal.transaction_hash IS NULL THEN 'expired'
    WHEN withdrawal.review_required_at IS NOT NULL AND withdrawal.transaction_hash IS NULL THEN 'dispatch_review'
    WHEN withdrawal.submission_status = 'awaiting_owner_signature' THEN 'awaiting_owner_signature'
    WHEN canonical.transaction_hash IS NOT NULL THEN 'confirmed'
    WHEN reorged.transaction_hash IS NOT NULL THEN 'reorg_review'
    ELSE 'broadcast'
  END AS effective_status,
  COALESCE(canonical.transaction_hash, withdrawal.transaction_hash)::text AS transaction_hash,
  (${withdrawalHoldsReservation}) AS holds_reservation,
  withdrawal.created_at, withdrawal.dispatched_at,
  withdrawal.expired_at, withdrawal.review_required_at,
  withdrawal.broadcast_at, withdrawal.cancelled_at,
  canonical.observed_at AS confirmed_at, withdrawal.updated_at`;

/**
 * The amount a wallet's open withdrawal intents hold against its reconciled balance.
 *
 * One definition, three readers, on purpose. `createPreparedWithdrawal` enforces it,
 * `getWalletLedgerBalance` reports it, and `withdrawalColumns` marks the individual rows holding it
 * so no client has to re-derive the predicate. While the report was missing this term the owner was
 * offered a maximum the very next request refused. Expects $1 = tenant id, $2 = wallet id.
 */
const inFlightWithdrawalReservation = `COALESCE((
  SELECT SUM(withdrawal.amount_atomic)
  FROM meowwa_withdrawals AS withdrawal
  WHERE withdrawal.tenant_id = $1 AND withdrawal.wallet_id = $2
    AND ${withdrawalHoldsReservation}
), 0)`;

function mapWithdrawalDestination(row: WithdrawalDestinationRow): TenantWithdrawalDestination {
  if (row.status !== 'active' && row.status !== 'retired') throw new Error('Tenant withdrawal destination is invalid');
  const chain = fundingChainOfRow(row.chain_key, row.chain_id, 'Tenant withdrawal destination is invalid');
  return {
    tenantId: row.tenant_id,
    destinationId: row.destination_id,
    chainKey: chain.key,
    chainId: evmChainId(chain),
    address: canonicalChainAddress(chain.key, row.address),
    label: row.label,
    status: row.status,
    registeredBy: row.registered_by,
    createdAt: new Date(row.created_at).toISOString(),
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at).toISOString(),
  };
}

function mapWithdrawal(row: WithdrawalRow): TenantWithdrawal {
  if (!isCanonicalTenantId(row.tenant_id) || !validIdentifier(row.withdrawal_id) ||
    !validIdentifier(row.pet_id) || !validIdentifier(row.wallet_id) || !validIdentifier(row.destination_id) ||
    !/^[0-9a-f]{64}$/.test(row.binding_fingerprint) || !isAtomicAmount(row.amount_atomic) ||
    parseAtomicAmount(row.amount_atomic) <= 0n ||
    !(tenantWithdrawalStatuses as readonly string[]).includes(row.effective_status) ||
    typeof row.holds_reservation !== 'boolean') {
    throw new Error('Tenant withdrawal row is invalid');
  }
  const chain = fundingChainOfRow(row.chain_key, row.chain_id, 'Tenant withdrawal row is invalid');
  if (row.transaction_hash !== null && !isChainTransactionId(chain, row.transaction_hash)) {
    throw new Error('Tenant withdrawal row is invalid');
  }
  return {
    tenantId: row.tenant_id,
    withdrawalId: row.withdrawal_id,
    petId: row.pet_id,
    walletId: row.wallet_id,
    bindingFingerprint: row.binding_fingerprint,
    destinationId: row.destination_id,
    destinationAddress: canonicalChainAddress(chain.key, row.destination_address),
    amountAtomic: row.amount_atomic,
    chainKey: chain.key,
    chainId: evmChainId(chain),
    tokenAddress: canonicalChainAddress(chain.key, row.token_address),
    status: row.effective_status as TenantWithdrawalStatus,
    transactionHash: row.transaction_hash === null ? null : canonicalChainTransactionId(chain.key, row.transaction_hash),
    holdsReservation: row.holds_reservation,
    createdAt: canonicalTimestamp(row.created_at),
    dispatchedAt: row.dispatched_at === null ? null : canonicalTimestamp(row.dispatched_at),
    expiredAt: row.expired_at === null ? null : canonicalTimestamp(row.expired_at),
    reviewRequiredAt: row.review_required_at === null ? null : canonicalTimestamp(row.review_required_at),
    broadcastAt: row.broadcast_at === null ? null : canonicalTimestamp(row.broadcast_at),
    cancelledAt: row.cancelled_at === null ? null : canonicalTimestamp(row.cancelled_at),
    confirmedAt: row.confirmed_at === null ? null : canonicalTimestamp(row.confirmed_at),
    updatedAt: canonicalTimestamp(row.updated_at),
  };
}

type FundingChainDescriptor = ChainDescriptor & { key: FundingChainKey };
type ControlChainDescriptor = ChainDescriptor & { key: ControlChainKey };

function evmChainId(chain: ChainDescriptor): number | null {
  return isEvmChain(chain) ? chain.chainId : null;
}

/**
 * The chain a stored row belongs to, from its `chain_key` and, where the row still carries one,
 * its `chain_id`. Both must agree with the registry: an EVM key needs its numeric id (or none), a
 * Solana key must have none. A row written by an image older than migration 053 has only the
 * numeric id, and the migration's BEFORE INSERT trigger derives the key from it the same way this
 * does, so both readers see the same chain for the same row.
 */
function chainOfRow(
  chainKey: string | null | undefined,
  chainId: number | string | null | undefined,
  label: string,
  fallback?: ChainKey,
): ChainDescriptor {
  const numericId = chainId === null || chainId === undefined ? null : Number(chainId);
  if (numericId !== null && !Number.isSafeInteger(numericId)) throw new Error(label);
  let chain: ChainDescriptor | undefined;
  if (typeof chainKey === 'string') chain = chainByKey(chainKey);
  else if (numericId !== null) chain = chainByEvmChainId(numericId);
  else if (fallback !== undefined) chain = CHAINS[fallback];
  if (!chain) throw new Error(label);
  if (numericId !== null && (!isEvmChain(chain) || chain.chainId !== numericId)) throw new Error(label);
  return chain;
}

function fundingChainOfRow(
  chainKey: string | null | undefined,
  chainId: number | string | null | undefined,
  label: string,
): FundingChainDescriptor {
  const chain = chainOfRow(chainKey, chainId, label);
  if (!isFundingChainKey(chain.key)) throw new Error(label);
  return chain as FundingChainDescriptor;
}

function controlChainOfRow(
  chainKey: string | null | undefined,
  chainId: number | string | null | undefined,
  label: string,
  fallback?: ControlChainKey,
): ControlChainDescriptor {
  const chain = chainOfRow(chainKey, chainId, label, fallback);
  if (!isControlChainKey(chain.key)) throw new Error(label);
  return chain as ControlChainDescriptor;
}

function requireFundingChain(chainKey: string, label: string): FundingChainDescriptor {
  if (!isFundingChainKey(chainKey)) throw new Error(label);
  return CHAINS[chainKey];
}

function requireControlChain(chainKey: string, label: string): ControlChainDescriptor {
  if (!isControlChainKey(chainKey)) throw new Error(label);
  return CHAINS[chainKey];
}

/** The wallet id of a pet's Solana binding, derived from its EVM binding's id. */
export function solanaWalletId(evmWalletId: string): string {
  return `${evmWalletId}_solana`;
}

/**
 * Validate, then format — and the only copy. `postgres-repository.ts` had a second one that
 * formatted first, so an unparseable database timestamp escaped as a raw `RangeError: Invalid time
 * value` from `toISOString` and that copy's own `Date.parse` guard could never run: by the time it
 * was reached the string was always a well-formed ISO 8601 value. Same result for every valid
 * input, one named error for every invalid one.
 */
export function canonicalTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Tenant timestamp is invalid');
  return date.toISOString();
}

function safePositiveInteger(value: number | string | null, label: string): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Tenant ${label} is invalid`);
  return parsed;
}

function mapFunding(row: FundingRow): TenantFundingTransaction {
  const chain = fundingChainOfRow(row.chain_key, row.chain_id, 'Tenant funding row is invalid');
  if (!isCanonicalTenantId(row.tenant_id) || !validIdentifier(row.funding_id) || !validIdentifier(row.pet_id) ||
    !validIdentifier(row.wallet_id) || !fundingStatuses.has(row.status) ||
    !reconciliationStatuses.has(row.reconciliation_status) || row.destination_currency !== 'usdc' ||
    (row.source_currency !== null && row.source_currency !== 'usd') ||
    (row.destination_amount_atomic !== null && !isAtomicAmount(row.destination_amount_atomic)) ||
    (row.transaction_hash !== null && !isChainTransactionId(chain, row.transaction_hash))) {
    throw new Error('Tenant funding row is invalid');
  }
  return {
    tenantId: row.tenant_id,
    fundingId: row.funding_id,
    petId: row.pet_id,
    walletId: row.wallet_id,
    walletAddress: canonicalChainAddress(chain.key, row.wallet_address),
    rail: row.rail,
    status: row.status,
    reconciliationStatus: row.reconciliation_status,
    sourceCurrency: row.source_currency,
    sourceAmountMinor: safePositiveInteger(row.source_amount_minor, 'funding source amount'),
    destinationCurrency: 'usdc',
    destinationAmountAtomic: row.destination_amount_atomic,
    chainKey: chain.key,
    chainId: evmChainId(chain),
    providerSessionId: row.provider_session_id,
    transactionHash: row.transaction_hash === null ? null : canonicalChainTransactionId(chain.key, row.transaction_hash),
    failureCode: row.failure_code,
    createdAt: canonicalTimestamp(row.created_at),
    updatedAt: canonicalTimestamp(row.updated_at),
  };
}

function mapWallet(row: WalletRow, expectedTenantId: string): TenantWalletBinding {
  const tenantId = row.tenant_id ?? expectedTenantId;
  const invalid = 'Tenant wallet binding row is invalid';
  // A binding row written before migration 053 carries only `chain_id` (84532), and one whose
  // query did not project the chain columns carries neither: both are the Base Sepolia control
  // binding, exactly as they were read before a second family existed.
  const chain = controlChainOfRow(row.chain_key, row.chain_id, invalid, 'base_sepolia');
  const control = [row.agent_signer_id, row.agent_policy_id, row.policy_digest, row.policy_valid_until, row.control_verified_at]
    .map((value) => value ?? null);
  const controlled = control.every((value) => value !== null);
  // The attested funding rail: its key, or (pre-053 rows) the numeric id the key derives from. A
  // Solana attestation has a key and no numeric id, so the all-or-none set is keyed on the rail
  // identity rather than on `funding_chain_id` alone.
  const fundingChain = row.funding_chain_key == null && row.funding_chain_id == null
    ? null
    : fundingChainOfRow(row.funding_chain_key, row.funding_chain_id, invalid);
  const funding = [fundingChain, row.funding_environment, row.custody_classification, row.funding_verified_at]
    .map((value) => value ?? null);
  const productionFunding = funding.every((value) => value !== null);
  if (!isCanonicalTenantId(tenantId) || tenantId !== expectedTenantId || !validIdentifier(row.wallet_id) ||
    !validIdentifier(row.pet_id) || row.provider !== 'privy' || !validIdentifier(row.privy_embedded_wallet_id ?? '') ||
    !['provisioning', 'active', 'failed', 'disabled', 'revoked', 'drifted'].includes(row.status) ||
    row.created_at === undefined || row.updated_at === undefined || (!controlled && control.some((value) => value !== null)) ||
    (!productionFunding && funding.some((value) => value !== null)) ||
    (productionFunding && (fundingChain === null || fundingChain.key !== fundingChainFor(chain.key) ||
      row.funding_environment !== 'production' ||
      row.custody_classification !== 'owner_controlled' || !Number.isFinite(Date.parse(String(row.funding_verified_at))))) ||
    (controlled && (!validIdentifier(row.agent_signer_id!) || !validIdentifier(row.agent_policy_id!) ||
      !/^[0-9a-f]{64}$/.test(row.policy_digest!) ||
      Date.parse(String(row.policy_valid_until)) <= Date.parse(String(row.control_verified_at))))) {
    throw new Error(invalid);
  }
  return {
    tenantId,
    walletId: row.wallet_id,
    petId: row.pet_id,
    provider: 'privy',
    privyEmbeddedWalletId: row.privy_embedded_wallet_id!,
    smartWalletAddress: canonicalChainAddress(chain.key, row.smart_wallet_address),
    ownerQuorumId: row.owner_quorum_id ?? null,
    ownerPrivyUserId: null,
    revocationReason: row.revocation_reason ?? null,
    agentSignerId: row.agent_signer_id ?? null,
    agentPolicyId: row.agent_policy_id ?? null,
    policyDigest: row.policy_digest ?? null,
    policyValidUntil: row.policy_valid_until == null ? null : canonicalTimestamp(row.policy_valid_until),
    controlVerifiedAt: row.control_verified_at == null ? null : canonicalTimestamp(row.control_verified_at),
    chainKey: chain.key,
    chainId: evmChainId(chain),
    ...(productionFunding && fundingChain !== null ? {
      fundingChainKey: fundingChain.key,
      fundingChainId: evmChainId(fundingChain),
      fundingEnvironment: 'production' as const,
      custodyClassification: 'owner_controlled' as const,
      fundingVerifiedAt: canonicalTimestamp(row.funding_verified_at!),
    } : {}),
    status: row.status,
    createdAt: canonicalTimestamp(row.created_at),
    updatedAt: canonicalTimestamp(row.updated_at),
  };
}

/**
 * The identity a withdrawal pins its binding to. Version 1 is the Base Sepolia fingerprint exactly
 * as it has always been computed (lowercased address, numeric funding chain id), so every
 * fingerprint stored on an open Base withdrawal keeps verifying. A Solana binding gets version 2:
 * its base58 address is case-significant and must not be lowercased, and its rail has no numeric
 * id, so the chain keys name it instead.
 */
export function tenantWalletBindingFingerprint(binding: TenantWalletBinding): string {
  if (binding.chainKey !== 'base_sepolia') {
    return createHash('sha256').update(JSON.stringify({
      version: 2,
      tenantId: binding.tenantId,
      walletId: binding.walletId,
      petId: binding.petId,
      provider: binding.provider,
      privyEmbeddedWalletId: binding.privyEmbeddedWalletId,
      chainKey: binding.chainKey,
      smartWalletAddress: binding.smartWalletAddress,
      ownerQuorumId: binding.ownerQuorumId,
      agentSignerId: binding.agentSignerId,
      agentPolicyId: binding.agentPolicyId,
      policyDigest: binding.policyDigest,
      policyValidUntil: binding.policyValidUntil,
      controlVerifiedAt: binding.controlVerifiedAt,
      fundingChainKey: binding.fundingChainKey ?? null,
      fundingEnvironment: binding.fundingEnvironment ?? null,
      custodyClassification: binding.custodyClassification ?? null,
      fundingVerifiedAt: binding.fundingVerifiedAt ?? null,
      status: binding.status,
      updatedAt: binding.updatedAt,
    })).digest('hex');
  }
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    tenantId: binding.tenantId,
    walletId: binding.walletId,
    petId: binding.petId,
    provider: binding.provider,
    privyEmbeddedWalletId: binding.privyEmbeddedWalletId,
    smartWalletAddress: binding.smartWalletAddress.toLowerCase(),
    ownerQuorumId: binding.ownerQuorumId,
    agentSignerId: binding.agentSignerId,
    agentPolicyId: binding.agentPolicyId,
    policyDigest: binding.policyDigest,
    policyValidUntil: binding.policyValidUntil,
    controlVerifiedAt: binding.controlVerifiedAt,
    fundingChainId: binding.fundingChainId ?? null,
    fundingEnvironment: binding.fundingEnvironment ?? null,
    custodyClassification: binding.custodyClassification ?? null,
    fundingVerifiedAt: binding.fundingVerifiedAt ?? null,
    status: binding.status,
    updatedAt: binding.updatedAt,
  })).digest('hex');
}

function mapWalletExecution(row: WalletExecutionRow, expectedTenantId: string): TenantWalletExecutionSubmission {
  // Agent execution is a Base Sepolia rail only (a Solana execution rail is deferred, and the
  // table's CHECK says so), so a row on any other chain is corrupt rather than merely unsupported.
  const chain = chainOfRow(row.chain_key, row.chain_id, 'Tenant wallet execution row is invalid');
  const version = Number(row.version);
  const blockNumber = row.block_number === null ? null : Number(row.block_number);
  const logIndex = row.log_index === null ? null : Number(row.log_index);
  if (!isCanonicalTenantId(row.tenant_id) || row.tenant_id !== expectedTenantId || chain.key !== 'base_sepolia' ||
    !walletExecutionStatuses.has(row.status) || !Number.isSafeInteger(version) || version < 1 ||
    !validIdentifier(row.submission_id) || !validIdentifier(row.request_id) || !validIdentifier(row.owner_subject, 512) ||
    !validIdentifier(row.pet_id) || !validIdentifier(row.wallet_id) || !validIdentifier(row.provider_wallet_id) ||
    !validIdentifier(row.owner_quorum_id) || !validIdentifier(row.agent_signer_id) || !validIdentifier(row.agent_policy_id) ||
    !/^[0-9a-f]{64}$/.test(row.policy_digest) || !/^[0-9a-f]{64}$/.test(row.intent_hash) ||
    !/^mw_[0-9a-f]{61}$/.test(row.reference_id) || !isCanonicalUsdcAsset(chain, row.contract) ||
    !isEvmAddress(row.sender) || !isEvmAddress(row.recipient) || !isAtomicAmount(row.amount_atomic) || row.amount_atomic === '0' ||
    row.value_atomic !== '0' ||
    !/^0x[0-9a-f]{136}$/.test(row.calldata) ||
    (row.provider_transaction_id !== null && !validIdentifier(row.provider_transaction_id)) ||
    (row.user_operation_hash !== null && !isEvmTransactionHash(row.user_operation_hash)) ||
    (row.transaction_hash !== null && !isEvmTransactionHash(row.transaction_hash)) ||
    (row.block_hash !== null && !isEvmTransactionHash(row.block_hash)) ||
    (blockNumber !== null && (!Number.isSafeInteger(blockNumber) || blockNumber < 0)) ||
    (logIndex !== null && (!Number.isSafeInteger(logIndex) || logIndex < 0)) ||
    (row.failure_code !== null && !validIdentifier(row.failure_code)) ||
    Date.parse(String(row.policy_valid_until)) <= Date.parse(String(row.control_verified_at))) {
    throw new Error('Tenant wallet execution row is invalid');
  }
  return {
    tenantId: row.tenant_id,
    submissionId: row.submission_id,
    requestId: row.request_id,
    ownerSubject: row.owner_subject,
    petId: row.pet_id,
    walletId: row.wallet_id,
    providerWalletId: row.provider_wallet_id,
    ownerQuorumId: row.owner_quorum_id,
    agentSignerId: row.agent_signer_id,
    agentPolicyId: row.agent_policy_id,
    policyDigest: row.policy_digest,
    policyValidUntil: canonicalTimestamp(row.policy_valid_until),
    controlVerifiedAt: canonicalTimestamp(row.control_verified_at),
    intentHash: row.intent_hash,
    referenceId: row.reference_id,
    chainKey: 'base_sepolia',
    chainId: 84532,
    contract: canonicalChainAddress('base_sepolia', row.contract),
    sender: canonicalChainAddress('base_sepolia', row.sender),
    recipient: canonicalChainAddress('base_sepolia', row.recipient),
    amountAtomic: row.amount_atomic,
    valueAtomic: '0',
    calldata: row.calldata as `0x${string}`,
    status: row.status,
    providerTransactionId: row.provider_transaction_id,
    userOperationHash: row.user_operation_hash === null ? null : row.user_operation_hash.toLowerCase() as `0x${string}`,
    transactionHash: row.transaction_hash === null ? null : row.transaction_hash.toLowerCase() as `0x${string}`,
    blockHash: row.block_hash === null ? null : row.block_hash.toLowerCase() as `0x${string}`,
    blockNumber,
    logIndex,
    blindSubmitAttempts: Number(row.blind_submit_attempts ?? 0),
    failureCode: row.failure_code,
    confirmedAt: row.confirmed_at === null ? null : canonicalTimestamp(row.confirmed_at),
    applicationSettledAt: row.application_settled_at === null ? null : canonicalTimestamp(row.application_settled_at),
    createdAt: canonicalTimestamp(row.created_at),
    updatedAt: canonicalTimestamp(row.updated_at),
    version,
  };
}

function executionIdentity(input: PrepareTenantWalletExecutionInput | TenantWalletExecutionSubmission): string {
  return JSON.stringify({
    tenantId: input.tenantId, submissionId: input.submissionId, requestId: input.requestId,
    ownerSubject: input.ownerSubject, petId: input.petId, walletId: input.walletId,
    providerWalletId: input.providerWalletId, ownerQuorumId: input.ownerQuorumId,
    agentSignerId: input.agentSignerId, agentPolicyId: input.agentPolicyId, policyDigest: input.policyDigest,
    policyValidUntil: input.policyValidUntil, controlVerifiedAt: input.controlVerifiedAt,
    intentHash: input.intentHash, referenceId: input.referenceId, chainKey: input.chainKey, chainId: input.chainId,
    contract: input.contract.toLowerCase(), sender: input.sender.toLowerCase(), recipient: input.recipient.toLowerCase(),
    amountAtomic: input.amountAtomic, valueAtomic: input.valueAtomic, calldata: input.calldata.toLowerCase(),
  });
}

function hashIdempotencyKey(value: string): string {
  return createHash('sha256').update('meowwa:funding-idempotency:v1\0', 'utf8').update(value, 'utf8').digest('hex');
}

/**
 * The content address of a ledger entry: the replay-idempotency key for every chain credit and
 * debit ever written. Base rows have always been namespaced by the literal '8453' segment, and
 * every existing entry_id/source_id on every Base ledger derives from it, so that segment stays
 * exactly as it was; any other rail is namespaced by its chain key, which no numeric id collides
 * with.
 */
function ledgerIdentity(input: {
  tenantId: string;
  chainKey: FundingChainKey;
  transactionHash: string;
  logIndex: number;
  walletId: string;
  direction?: 'credit' | 'debit';
}): { entryId: string; sourceId: string } {
  const chainSegment = input.chainKey === 'base' ? '8453' : input.chainKey;
  const identity = `${chainSegment}:${input.transactionHash}:${input.logIndex}:${input.walletId}:${input.direction ?? 'credit'}`;
  const digest = createHash('sha256').update(`meowwa:ledger:v2\0${input.tenantId}\0${identity}`, 'utf8').digest('hex');
  return { entryId: `ledger_${digest.slice(0, 48)}`, sourceId: `chain_${digest}` };
}

/** Same discipline as `ledgerIdentity`: the Base preimage is unchanged; other rails append their key. */
function directFundingId(input: {
  tenantId: string;
  chainKey: FundingChainKey;
  transactionHash: string;
  logIndex: number;
  walletId: string;
}): string {
  const chainSuffix = input.chainKey === 'base' ? '' : `\0${input.chainKey}`;
  const digest = createHash('sha256')
    .update(`meowwa:direct-funding:v1\0${input.tenantId}\0${input.transactionHash}\0${input.logIndex}\0${input.walletId}${chainSuffix}`, 'utf8')
    .digest('hex');
  return `funding_direct_${digest.slice(0, 48)}`;
}

function safeNonNegativeInteger(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Tenant ${label} is invalid`);
  return parsed;
}

type DatabaseRole = 'meowwa_app' | 'meowwa_wallet_provisioner' | 'meowwa_financial_worker';

class TenantRoleRepository {
  readonly #statementTimeout: string;
  readonly #lockTimeout: string;

  constructor(
    protected readonly pool: PgPoolLike,
    options: { statementTimeoutMs?: number; lockTimeoutMs?: number } = {},
  ) {
    const statementTimeoutMs = options.statementTimeoutMs ?? 5_000;
    const lockTimeoutMs = options.lockTimeoutMs ?? 1_000;
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 100 || statementTimeoutMs > 30_000 ||
      !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 100 || lockTimeoutMs > statementTimeoutMs) {
      throw new Error('Tenant financial database timeout configuration is invalid');
    }
    this.#statementTimeout = `${statementTimeoutMs}ms`;
    this.#lockTimeout = `${lockTimeoutMs}ms`;
  }

  protected async withRole<T>(
    role: DatabaseRole,
    tenantId: string | undefined,
    operation: (client: PgClientLike) => Promise<T>,
    options: { readOnly?: boolean; serializable?: boolean } = {},
  ): Promise<T> {
    if (tenantId !== undefined && !isCanonicalTenantId(tenantId)) throw new Error('Canonical tenant ID is required');
    const attempts = options.serializable ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const client = await this.pool.connect();
      let began = false;
      try {
        await client.query('BEGIN');
        began = true;
        if (options.serializable) await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        if (options.readOnly) await client.query('SET TRANSACTION READ ONLY');
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('search_path', 'pg_catalog, public', true)");
        if (tenantId !== undefined) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query("SELECT set_config('statement_timeout', $1, true)", [this.#statementTimeout]);
        await client.query("SELECT set_config('lock_timeout', $1, true)", [this.#lockTimeout]);
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (began) {
          try { await client.query('ROLLBACK'); } catch { /* retain the original operation error */ }
        }
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
        if (options.serializable && (code === '40001' || code === '40P01') && attempt + 1 < attempts) continue;
        throw error;
      } finally {
        client.release();
      }
    }
    throw new Error('Tenant financial transaction retry exhausted');
  }

  async close(): Promise<void> { await this.pool.end?.(); }
}

export class PostgresTenantFundingRepository extends TenantRoleRepository {
  /** A pet has at most one active binding per control network; Base Sepolia is the default rail. */
  async getActiveWalletBinding(
    tenantId: string,
    petId: string,
    chainKey: ControlChainKey = 'base_sepolia',
  ): Promise<TenantWalletBinding | undefined> {
    if (!validIdentifier(petId)) throw new Error('Tenant pet wallet reference is invalid');
    const chain = requireControlChain(chainKey, 'Tenant pet wallet chain is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND chain_key = $3 AND status = 'active'`,
        [tenantId, petId, chain.key],
      );
      if (result.rows.length > 1) throw new Error('Tenant pet wallet binding is ambiguous');
      return result.rows[0] ? mapWallet(result.rows[0], tenantId) : undefined;
    }, { readOnly: true });
  }

  /** Every active binding of a pet across both families, in chain-key order. */
  async listActiveWalletBindings(tenantId: string, petId: string): Promise<TenantWalletBinding[]> {
    if (!validIdentifier(petId)) throw new Error('Tenant pet wallet reference is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND status = 'active'
         ORDER BY chain_key`,
        [tenantId, petId],
      );
      const bindings = result.rows.map((row) => mapWallet(row, tenantId));
      if (new Set(bindings.map((binding) => binding.chainKey)).size !== bindings.length) {
        throw new Error('Tenant pet wallet binding is ambiguous');
      }
      return bindings;
    }, { readOnly: true });
  }

  /**
   * Records that the owner put this pet aside, or brought it back.
   *
   * Deliberately the only write the request path can make to this table: migration 042 grants
   * meowwa_app UPDATE on `archived_at` alone, so this cannot disable a binding, move an address,
   * or otherwise put the owner's balance out of reach even if this method were wrong.
   */
  async setPetArchived(tenantId: string, petId: string, archivedAt: string | null): Promise<boolean> {
    if (!validIdentifier(petId)) throw new Error('Tenant pet wallet reference is invalid');
    if (archivedAt !== null && !Number.isFinite(Date.parse(archivedAt))) {
      throw new Error('Tenant pet archive timestamp is invalid');
    }
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query(
        `UPDATE meowwa_pet_wallet_bindings
         SET archived_at = $3
         WHERE tenant_id = $1 AND pet_id = $2`,
        [tenantId, petId, archivedAt],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async inspectPetDeletion(tenantId: string, petId: string): Promise<{
    blockers: TenantPetDeletionBlocker[];
    deletedAt: string | null;
    deletionReceiptId: string | null;
  }> {
    if (!isCanonicalTenantId(tenantId) || !validIdentifier(petId)) {
      throw new Error('Tenant pet deletion reference is invalid');
    }
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<{
        blockers: unknown; pet_deleted_at: Date | string | null; deletion_receipt_id: string | null;
      }>(
        // A pet may hold one binding per family; the deletion markers are stamped on all of them,
        // so one lateral row (the stamped one first) keeps this a single-row read.
        `SELECT meowwa_pet_deletion_blockers($1, $2) AS blockers,
                binding.pet_deleted_at, binding.deletion_receipt_id
         FROM (SELECT 1) AS singleton
         LEFT JOIN LATERAL (
           SELECT pet_deleted_at, deletion_receipt_id
           FROM meowwa_pet_wallet_bindings
           WHERE tenant_id = $1 AND pet_id = $2
           ORDER BY pet_deleted_at DESC NULLS LAST, chain_key
           LIMIT 1
         ) AS binding ON true`,
        [tenantId, petId],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || !Array.isArray(row.blockers) ||
        row.blockers.some((blocker) => typeof blocker !== 'string' ||
          !(tenantPetDeletionBlockers as readonly string[]).includes(blocker)) ||
        (row.deletion_receipt_id !== null && !/^[0-9a-f]{64}$/.test(row.deletion_receipt_id))) {
        throw new Error('Tenant pet deletion inspection is invalid');
      }
      const deletedAt = row.pet_deleted_at === null ? null : canonicalTimestamp(row.pet_deleted_at);
      if ((deletedAt === null) !== (row.deletion_receipt_id === null)) {
        throw new Error('Tenant pet deletion inspection is invalid');
      }
      return {
        blockers: row.blockers as TenantPetDeletionBlocker[],
        deletedAt,
        deletionReceiptId: row.deletion_receipt_id,
      };
    }, { readOnly: true });
  }

  async finalizePetDeletion(input: {
    tenantId: string; petId: string; deletionReceiptId: string;
  }): Promise<{ deletedAt: string; deletionReceiptId: string; newlyDeleted: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.petId) ||
      !/^[0-9a-f]{64}$/.test(input.deletionReceiptId)) {
      throw new Error('Tenant pet deletion finalization is invalid');
    }
    return this.withRole('meowwa_app', input.tenantId, async (client) => {
      const result = await client.query<{
        deleted_at: Date | string; deletion_receipt_id: string; newly_deleted: boolean;
      }>(
        `SELECT deleted_at, deletion_receipt_id, newly_deleted
         FROM meowwa_finalize_pet_deletion($1, $2, $3::char(64))`,
        [input.tenantId, input.petId, input.deletionReceiptId],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || !/^[0-9a-f]{64}$/.test(row.deletion_receipt_id) ||
        typeof row.newly_deleted !== 'boolean') {
        throw new Error('Tenant pet deletion finalization returned invalid evidence');
      }
      return {
        deletedAt: canonicalTimestamp(row.deleted_at),
        deletionReceiptId: row.deletion_receipt_id,
        newlyDeleted: row.newly_deleted,
      };
    }, { serializable: true });
  }

  async getWalletLedgerBalance(tenantId: string, walletId: string): Promise<string> {
    if (!validIdentifier(walletId)) throw new Error('Tenant wallet ledger reference is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      // Reorged credit events subtract from the reported balance: the ledger entry still exists,
      // but the chain no longer backs the funds, and fail-closed means the owner cannot spend or
      // withdraw against them until an operator re-canonicalizes the window. Reorged debits are
      // deliberately not added back -- that would raise the balance on unverified evidence.
      //
      // In-flight withdrawal reservations subtract too, and this is the only projection of them an
      // owner ever sees. `createPreparedWithdrawal` measures a new withdrawal against ledger minus
      // reorged credits minus reservations; this read used to stop one term short, so the panel
      // offered a maximum -- and a second device offered the whole balance again -- that the server
      // then refused with `withdrawal-insufficient-funds`, with nothing on any screen accounting
      // for the difference. Same three terms, same number, one answer.
      //
      // No chain predicate: a wallet id names one binding, and a binding is attested to exactly
      // one funding rail, so every chain event of a wallet is on that wallet's chain already.
      const result = await client.query<{ balance_atomic: string }>(
        `SELECT (
           COALESCE((
             SELECT SUM(CASE direction WHEN 'credit' THEN amount_atomic ELSE -amount_atomic END)
             FROM meowwa_wallet_ledger_entries
             WHERE tenant_id = $1 AND wallet_id = $2
           ), 0)
           - COALESCE((
             SELECT SUM(amount_atomic)
             FROM meowwa_wallet_chain_events
             WHERE tenant_id = $1 AND wallet_id = $2
               AND direction = 'credit' AND canonical_status = 'reorged'
           ), 0)
           - ${inFlightWithdrawalReservation}
         )::text AS balance_atomic`,
        [tenantId, walletId],
      );
      const balance = result.rows[0]?.balance_atomic;
      if (result.rows.length !== 1 || typeof balance !== 'string' || !/^-?[0-9]+$/.test(balance)) {
        throw new Error('Tenant wallet ledger balance is invalid');
      }
      // Negative is reachable once reorged credits subtract from a partially withdrawn ledger.
      // Zero is the fail-closed floor: nothing is spendable, and nothing is owed to the display.
      const value = BigInt(balance);
      return (value > 0n ? value : 0n).toString();
    }, { readOnly: true });
  }

  async createPendingFunding(input: {
    tenantId: string;
    operation: string;
    idempotencyKey: string;
    requestFingerprint: string;
    fundingId: string;
    petId: string;
    walletId: string;
    chainKey: FundingChainKey;
    walletAddress: string;
    rail: TenantFundingRail;
    sourceAmountMinor: number | null;
  }): Promise<{ transaction: TenantFundingTransaction; reused: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validOperation(input.operation) ||
      input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 || input.idempotencyKey.trim() !== input.idempotencyKey ||
      !/^[0-9a-f]{64}$/.test(input.requestFingerprint) || !validIdentifier(input.fundingId) ||
      !validIdentifier(input.petId) || !validIdentifier(input.walletId) ||
      !['stripe_onramp', 'direct_usdc'].includes(input.rail) ||
      (input.rail === 'stripe_onramp' && input.sourceAmountMinor !== null &&
        (!Number.isSafeInteger(input.sourceAmountMinor) || input.sourceAmountMinor <= 0)) ||
      (input.rail === 'direct_usdc' && input.sourceAmountMinor !== null)) {
      throw new Error('Tenant pending funding request is invalid');
    }
    const chain = requireFundingChain(input.chainKey, 'Tenant pending funding request is invalid');
    const walletAddress = canonicalChainAddress(chain.key, input.walletAddress);
    const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);
    return this.withRole('meowwa_app', input.tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `meowwa:funding-idempotency:${input.tenantId}:${input.operation}:${idempotencyKeyHash}`,
      ]);
      const existing = await client.query<{ request_fingerprint: string; funding_id: string }>(
        `SELECT request_fingerprint, funding_id
         FROM meowwa_funding_idempotency
         WHERE tenant_id = $1 AND operation = $2 AND idempotency_key_hash = $3`,
        [input.tenantId, input.operation, idempotencyKeyHash],
      );
      if (existing.rows.length > 1) throw new Error('Tenant funding idempotency row is invalid');
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_fingerprint !== input.requestFingerprint) throw new TenantFundingIdempotencyConflictError();
        const funding = await this.getFundingInTransaction(client, input.tenantId, prior.funding_id);
        if (!funding) throw new Error('Tenant funding idempotency row is inconsistent');
        return { transaction: funding, reused: true };
      }

      const binding = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND wallet_id = $2 AND pet_id = $3 AND status = 'active'`,
        [input.tenantId, input.walletId, input.petId],
      );
      if (binding.rows.length !== 1) throw new Error('Tenant funding wallet binding is invalid');
      const wallet = mapWallet(binding.rows[0]!, input.tenantId);
      if (wallet.fundingChainKey !== chain.key || !sameAddressOn(chain.key, wallet.smartWalletAddress, walletAddress)) {
        throw new Error('Tenant funding wallet binding is invalid');
      }
      const reconciliationStatus = input.rail === 'stripe_onramp' ? 'awaiting_provider' : 'awaiting_chain';
      const inserted = await client.query<FundingRow>(
        `INSERT INTO meowwa_funding_transactions (
           tenant_id, funding_id, pet_id, wallet_id, wallet_address, rail, status,
           reconciliation_status, source_currency, source_amount_minor, destination_currency,
           destination_amount_atomic, chain_key, chain_id, provider, provider_session_id, transaction_hash, failure_code
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, 'usdc', NULL, $11, $12, $10, NULL, NULL, NULL
         )
         RETURNING ${fundingColumns}`,
        [
          input.tenantId, input.fundingId, input.petId, input.walletId, walletAddress, input.rail,
          reconciliationStatus, input.rail === 'stripe_onramp' ? 'usd' : null, input.sourceAmountMinor,
          input.rail === 'stripe_onramp' ? 'stripe' : null, chain.key, evmChainId(chain),
        ],
      );
      if (inserted.rows.length !== 1) throw new Error('Tenant funding request was not created');
      const idempotency = await client.query(
        `INSERT INTO meowwa_funding_idempotency (
           tenant_id, operation, idempotency_key_hash, request_fingerprint, funding_id
         ) VALUES ($1, $2, $3, $4, $5)`,
        [input.tenantId, input.operation, idempotencyKeyHash, input.requestFingerprint, input.fundingId],
      );
      if (idempotency.rowCount !== 1) throw new Error('Tenant funding idempotency was not created');
      return { transaction: mapFunding(inserted.rows[0]!), reused: false };
    }, { serializable: true });
  }

  async getFunding(tenantId: string, fundingId: string): Promise<TenantFundingTransaction | undefined> {
    if (!validIdentifier(fundingId)) throw new Error('Tenant funding ID is invalid');
    return this.withRole('meowwa_app', tenantId, (client) => this.getFundingInTransaction(client, tenantId, fundingId), { readOnly: true });
  }

  async listFunding(tenantId: string, limit = 100): Promise<TenantFundingTransaction[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Tenant funding list limit is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1
         ORDER BY created_at DESC, funding_id DESC
         LIMIT $2`,
        [tenantId, limit],
      );
      return result.rows.map(mapFunding);
    }, { readOnly: true });
  }

  async registerWithdrawalDestination(input: {
    tenantId: string;
    destinationId: string;
    chainKey: FundingChainKey;
    address: string;
    label: string;
    registeredBy: string;
  }): Promise<TenantWithdrawalDestination> {
    if (!validIdentifier(input.destinationId) || !validIdentifier(input.registeredBy) ||
      input.label.length < 1 || input.label.length > 120) throw new Error('Tenant withdrawal destination is invalid');
    const chain = requireFundingChain(input.chainKey, 'Tenant withdrawal destination is invalid');
    const address = canonicalChainAddress(chain.key, input.address);
    return this.withRole('meowwa_app', input.tenantId, async (client) => {
      const result = await client.query<WithdrawalDestinationRow>(
        `INSERT INTO meowwa_withdrawal_destinations (
           tenant_id, destination_id, chain_key, chain_id, address, label, status, registered_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
         RETURNING ${withdrawalDestinationColumns}`,
        [input.tenantId, input.destinationId, chain.key, evmChainId(chain), address, input.label, input.registeredBy],
      );
      if (result.rows.length !== 1) throw new Error('Tenant withdrawal destination was not registered');
      return mapWithdrawalDestination(result.rows[0]!);
    });
  }

  async listWithdrawalDestinations(tenantId: string): Promise<TenantWithdrawalDestination[]> {
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<WithdrawalDestinationRow>(
        `SELECT ${withdrawalDestinationColumns}
         FROM meowwa_withdrawal_destinations
         WHERE tenant_id = $1
         ORDER BY created_at DESC, destination_id DESC
         LIMIT 100`,
        [tenantId],
      );
      return result.rows.map(mapWithdrawalDestination);
    }, { readOnly: true });
  }

  async retireWithdrawalDestination(tenantId: string, destinationId: string): Promise<TenantWithdrawalDestination | undefined> {
    if (!validIdentifier(destinationId)) throw new Error('Tenant withdrawal destination is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<WithdrawalDestinationRow>(
        `UPDATE meowwa_withdrawal_destinations
         SET status = 'retired', retired_at = transaction_timestamp(), updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND destination_id = $2 AND status = 'active'
         RETURNING ${withdrawalDestinationColumns}`,
        [tenantId, destinationId],
      );
      return result.rows[0] ? mapWithdrawalDestination(result.rows[0]) : undefined;
    });
  }

  async createPreparedWithdrawal(input: {
    tenantId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    withdrawalId: string;
    ownerSubject: string;
    petId: string;
    walletId: string;
    chainKey: FundingChainKey;
    walletAddress: string;
    bindingFingerprint: string;
    destinationId: string;
    destinationAddress: string;
    amountAtomic: string;
    tokenAddress: string;
  }): Promise<{ withdrawal: TenantWithdrawal; reused: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 200 || input.idempotencyKey.trim() !== input.idempotencyKey ||
      !/^[0-9a-f]{64}$/.test(input.requestFingerprint) || !/^[0-9a-f]{64}$/.test(input.bindingFingerprint) ||
      !validIdentifier(input.withdrawalId) || !validIdentifier(input.ownerSubject) ||
      !validIdentifier(input.petId) || !validIdentifier(input.walletId) || !validIdentifier(input.destinationId) ||
      !isAtomicAmount(input.amountAtomic) || parseAtomicAmount(input.amountAtomic) <= 0n) {
      throw new Error('Tenant withdrawal request is invalid');
    }
    const chain = requireFundingChain(input.chainKey, 'Tenant withdrawal request is invalid');
    const walletAddress = canonicalChainAddress(chain.key, input.walletAddress);
    const destinationAddress = canonicalChainAddress(chain.key, input.destinationAddress);
    const tokenAddress = canonicalChainAddress(chain.key, input.tokenAddress);
    // Only the rail's canonical USDC may leave a pet wallet: the ERC-20 contract on Base, the SPL
    // mint on Solana. The table's CHECK says the same; refusing here names the request instead.
    if (!isCanonicalUsdcAsset(chain, tokenAddress)) throw new Error('Tenant withdrawal request is invalid');
    const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);
    return this.withRole('meowwa_app', input.tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `meowwa:withdrawal-idempotency:${input.tenantId}:${idempotencyKeyHash}`,
      ]);
      const existing = await client.query<{ request_fingerprint: string; withdrawal_id: string }>(
        `SELECT request_fingerprint, withdrawal_id
         FROM meowwa_withdrawals
         WHERE tenant_id = $1 AND idempotency_key_hash = $2`,
        [input.tenantId, idempotencyKeyHash],
      );
      if (existing.rows.length > 1) throw new Error('Tenant withdrawal idempotency row is invalid');
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_fingerprint !== input.requestFingerprint) throw new TenantWithdrawalIdempotencyConflictError();
        const selected = await client.query<WithdrawalRow>(
          `SELECT ${withdrawalColumns}
           FROM meowwa_withdrawals AS withdrawal
           ${withdrawalEvidenceJoins}
           WHERE withdrawal.tenant_id = $1 AND withdrawal.withdrawal_id = $2`,
          [input.tenantId, prior.withdrawal_id],
        );
        if (selected.rows.length !== 1) throw new Error('Tenant withdrawal idempotency row is inconsistent');
        return { withdrawal: mapWithdrawal(selected.rows[0]!), reused: true };
      }

      const bindingResult = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND wallet_id = $2 AND pet_id = $3 AND status = 'active'`,
        [input.tenantId, input.walletId, input.petId],
      );
      if (bindingResult.rows.length !== 1) throw new Error('Tenant withdrawal wallet binding is invalid');
      const binding = mapWallet(bindingResult.rows[0]!, input.tenantId);
      if (!sameAddressOn(chain.key, binding.smartWalletAddress, walletAddress) || binding.fundingChainKey !== chain.key ||
        tenantWalletBindingFingerprint(binding) !== input.bindingFingerprint) {
        throw new Error('Tenant withdrawal wallet binding changed before authorization');
      }
      const destinationResult = await client.query<WithdrawalDestinationRow>(
        `SELECT ${withdrawalDestinationColumns}
         FROM meowwa_withdrawal_destinations
         WHERE tenant_id = $1 AND destination_id = $2 AND chain_key = $3 AND status = 'active'`,
        [input.tenantId, input.destinationId, chain.key],
      );
      const destination = destinationResult.rows[0] ? mapWithdrawalDestination(destinationResult.rows[0]) : undefined;
      if (destinationResult.rows.length !== 1 || !destination || destination.chainKey !== chain.key ||
        destination.address !== destinationAddress) {
        throw new Error('Tenant withdrawal destination changed before authorization');
      }
      // The reconciled ledger only debits a withdrawal once the chain confirms it, so a second
      // withdrawal authorized while the first is still in flight would be offered the same USDC
      // twice. Reserve in-flight amounts here, inside the serializable transaction that inserts the
      // intent, so two concurrent authorizations cannot both pass. A client-side subtraction cannot
      // do this: the number it reserves against lives in the browser.
      const funds = await client.query<{ available_atomic: string }>(
        `SELECT (
           COALESCE((
             SELECT SUM(CASE direction WHEN 'credit' THEN amount_atomic ELSE -amount_atomic END)
             FROM meowwa_wallet_ledger_entries
             WHERE tenant_id = $1 AND wallet_id = $2
           ), 0)
           - COALESCE((
             SELECT SUM(reorged_credit.amount_atomic)
             FROM meowwa_wallet_chain_events AS reorged_credit
             WHERE reorged_credit.tenant_id = $1 AND reorged_credit.wallet_id = $2
               AND reorged_credit.chain_key = $3
               AND reorged_credit.direction = 'credit' AND reorged_credit.canonical_status = 'reorged'
           ), 0)
           - ${inFlightWithdrawalReservation}
         )::text AS available_atomic`,
        [input.tenantId, input.walletId, chain.key],
      );
      const availableAtomic = funds.rows[0]?.available_atomic;
      if (funds.rows.length !== 1 || typeof availableAtomic !== 'string' || !/^-?[0-9]+$/.test(availableAtomic)) {
        throw new Error('Tenant wallet withdrawable balance is invalid');
      }
      const available = BigInt(availableAtomic);
      if (available < parseAtomicAmount(input.amountAtomic)) {
        throw new TenantWithdrawalInsufficientFundsError((available > 0n ? available : 0n).toString());
      }
      const inserted = await client.query(
        `INSERT INTO meowwa_withdrawals (
           tenant_id, withdrawal_id, idempotency_key_hash, request_fingerprint, owner_subject,
           pet_id, wallet_id, binding_fingerprint, destination_id, destination_address,
           amount_atomic, chain_key, chain_id, token_address, submission_status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'awaiting_owner_signature')`,
        [
          input.tenantId, input.withdrawalId, idempotencyKeyHash, input.requestFingerprint,
          input.ownerSubject, input.petId, input.walletId, input.bindingFingerprint,
          input.destinationId, destinationAddress, input.amountAtomic, chain.key, evmChainId(chain), tokenAddress,
        ],
      );
      if (inserted.rowCount !== 1) throw new Error('Tenant withdrawal intent was not created');
      const selected = await client.query<WithdrawalRow>(
        `SELECT ${withdrawalColumns}
         FROM meowwa_withdrawals AS withdrawal
         ${withdrawalEvidenceJoins}
         WHERE withdrawal.tenant_id = $1 AND withdrawal.withdrawal_id = $2`,
        [input.tenantId, input.withdrawalId],
      );
      if (selected.rows.length !== 1) throw new Error('Tenant withdrawal intent was not readable');
      return { withdrawal: mapWithdrawal(selected.rows[0]!), reused: false };
    }, { serializable: true });
  }

  async listWithdrawals(tenantId: string, limit = 100): Promise<TenantWithdrawal[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Tenant withdrawal list limit is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<WithdrawalRow>(
        `SELECT ${withdrawalColumns}
         FROM meowwa_withdrawals AS withdrawal
         ${withdrawalEvidenceJoins}
         WHERE withdrawal.tenant_id = $1
         ORDER BY withdrawal.created_at DESC, withdrawal.withdrawal_id DESC
         LIMIT $2`,
        [tenantId, limit],
      );
      return result.rows.map(mapWithdrawal);
    }, { readOnly: true });
  }

  /**
   * Records that the transfer was handed to the provider, before it is. Everything between this
   * point and a recorded transaction hash is a window in which the owner's funds may already be
   * moving, so no later transition may claim that nothing was sent.
   */
  /**
   * Settles, closes or flags withdrawal intents that have reserved funds with no broadcast.
   *
   * Three populations, three different truths. A dispatched intent the chain already shows paying
   * this destination this amount is SETTLED, not stale: its debit is attributed to it, so the row
   * reads `confirmed` instead of asking the owner to resolve an outcome the server can see. A
   * never-dispatched intent provably moved nothing: it expires, and expiry is what releases its
   * reservation. A dispatched intent with no observed outcome may have moved funds -- the owner
   * might have signed in the provider and the acknowledgement was lost -- so it is flagged for
   * review: the reservation stays held until provider or chain evidence resolves it (a late
   * broadcast acknowledgement, an owner-reported provider decline, or an operator). Releasing it
   * would let a second withdrawal spend the same funds. A transaction hash, a broadcast, a
   * cancellation, or a matching canonical debit disqualify a row from expiry or review.
   *
   * The review window stays wide, so an owner still sitting in the provider's signature prompt is
   * never flagged out from under them and a broadcast made just before the cut-off is already
   * indexed. The expiry window is short, because its population is the one that provably never
   * reached a prompt at all.
   */
  async expireStaleWithdrawals(tenantId: string, walletId: string): Promise<TenantWithdrawal[]> {
    if (!validIdentifier(walletId)) throw new Error('Tenant wallet reference is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      // Attribution first: a dispatched intent whose transfer the chain already shows is settled,
      // not stale. Recording that debit's hash is what turns "outcome unknown, amount reserved"
      // into `confirmed` with a working explorer link, and it claims the debit so a second intent
      // can never read as settled by the same transfer. Only an unambiguous match is claimed --
      // one open intent for that (amount, destination) -- because a claim is a statement about
      // whose money moved, and no schema change is needed: this is exactly the transition
      // `app_broadcast_withdrawals` already allows a hashless intent to make.
      const attributed = await client.query<{ withdrawal_id: string }>(
        `UPDATE meowwa_withdrawals AS withdrawal
         SET transaction_hash = (
               SELECT chain.transaction_hash
               FROM meowwa_wallet_chain_events AS chain
               WHERE ${unattributedChainDebit} AND chain.canonical_status = 'canonical'
               ORDER BY chain.observed_at, chain.log_index
               LIMIT 1
             ),
             submission_status = 'broadcast',
             broadcast_at = transaction_timestamp(),
             updated_at = transaction_timestamp(),
             version = version + 1
         WHERE withdrawal.tenant_id = $1 AND withdrawal.wallet_id = $2
           AND withdrawal.submission_status = 'awaiting_owner_signature'
           AND withdrawal.transaction_hash IS NULL AND withdrawal.broadcast_at IS NULL
           AND withdrawal.cancelled_at IS NULL AND withdrawal.expired_at IS NULL
           AND withdrawal.dispatched_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM meowwa_wallet_chain_events AS chain
             WHERE ${unattributedChainDebit} AND chain.canonical_status = 'canonical'
           )
           AND NOT EXISTS (${rivalOpenIntent})
         RETURNING withdrawal_id`,
        [tenantId, walletId],
      );
      const expired = await client.query<{ withdrawal_id: string }>(
        `UPDATE meowwa_withdrawals AS withdrawal
         SET expired_at = transaction_timestamp(), updated_at = transaction_timestamp(),
             version = version + 1
         WHERE tenant_id = $1 AND wallet_id = $2
           AND submission_status = 'awaiting_owner_signature'
           AND transaction_hash IS NULL AND broadcast_at IS NULL
           AND cancelled_at IS NULL AND expired_at IS NULL
           AND dispatched_at IS NULL
           -- Five minutes, not sixty. The dispatch marker is written before the wallet provider is
           -- ever opened, so a hashless intent that never reached it cannot be an owner still
           -- sitting in a signature prompt -- only a client that died between authorizing and
           -- dispatching, which is one HTTP call. An hour of that is an hour in which the owner
           -- cannot withdraw their own money and is not told for how long. The dispatched
           -- population below keeps the wide window: there, the prompt really may still be open.
           AND created_at < transaction_timestamp() - interval '5 minutes'
           AND NOT EXISTS (
             SELECT 1 FROM meowwa_wallet_chain_events AS chain
             WHERE ${unattributedChainDebit}
           )
         RETURNING withdrawal_id`,
        [tenantId, walletId],
      );
      const flagged = await client.query<{ withdrawal_id: string }>(
        `UPDATE meowwa_withdrawals
         SET review_required_at = transaction_timestamp(), updated_at = transaction_timestamp(),
             version = version + 1
         WHERE tenant_id = $1 AND wallet_id = $2
           AND submission_status = 'awaiting_owner_signature'
           AND transaction_hash IS NULL AND broadcast_at IS NULL
           AND cancelled_at IS NULL AND expired_at IS NULL
           AND dispatched_at IS NOT NULL AND review_required_at IS NULL
           AND created_at < transaction_timestamp() - interval '60 minutes'
         RETURNING withdrawal_id`,
        [tenantId, walletId],
      );
      const touched = [...attributed.rows, ...expired.rows, ...flagged.rows].map((row) => row.withdrawal_id);
      if (touched.length === 0) return [];
      const selected = await client.query<WithdrawalRow>(
        `SELECT ${withdrawalColumns}
         FROM meowwa_withdrawals AS withdrawal
         ${withdrawalEvidenceJoins}
         WHERE withdrawal.tenant_id = $1 AND withdrawal.withdrawal_id = ANY($2::text[])`,
        [tenantId, touched],
      );
      return selected.rows.map(mapWithdrawal);
    }, { serializable: true });
  }

  async markWithdrawalDispatched(
    tenantId: string,
    withdrawalId: string,
  ): Promise<{ withdrawal: TenantWithdrawal; applied: boolean } | undefined> {
    if (!validIdentifier(withdrawalId)) throw new Error('Tenant withdrawal ID is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE meowwa_withdrawals
         SET dispatched_at = transaction_timestamp(), updated_at = transaction_timestamp(),
             version = version + 1
         WHERE tenant_id = $1 AND withdrawal_id = $2
           AND submission_status = 'awaiting_owner_signature'
           AND transaction_hash IS NULL AND broadcast_at IS NULL
           AND cancelled_at IS NULL AND expired_at IS NULL AND dispatched_at IS NULL`,
        [tenantId, withdrawalId],
      );
      const selected = await client.query<WithdrawalRow>(
        `SELECT ${withdrawalColumns}
         FROM meowwa_withdrawals AS withdrawal
         ${withdrawalEvidenceJoins}
         WHERE withdrawal.tenant_id = $1 AND withdrawal.withdrawal_id = $2`,
        [tenantId, withdrawalId],
      );
      if (selected.rows.length === 0) return undefined;
      if (selected.rows.length !== 1) throw new Error('Tenant withdrawal is ambiguous');
      const withdrawal = mapWithdrawal(selected.rows[0]!);
      if (updated.rowCount === 0 && withdrawal.dispatchedAt === null) {
        throw new TenantWithdrawalDispatchConflictError();
      }
      if (updated.rowCount !== 0 && updated.rowCount !== 1) throw new Error('Tenant withdrawal dispatch update is invalid');
      return { withdrawal, applied: updated.rowCount === 1 };
    }, { serializable: true });
  }

  /**
   * Whether an unresolved chain reorganization halt exists, read from the request path's own role.
   *
   * The worker's fail-close (marking the divergent window's events reorged, which removes them
   * from balances) only takes effect once its halt record commits, and the API never consulted
   * halt state at all -- so between detection and that commit, and during any window where the
   * flip is incomplete, spend and withdrawal paths kept treating chain-unbacked funds as
   * spendable. This lets every financially-requiring route refuse directly on the halt.
   *
   * With no chain named, a halt on ANY rail answers true: the fail-closed direction for a caller
   * that has not said which rail it is about to move money on.
   */
  async unresolvedChainHalt(chainKey?: FundingChainKey): Promise<boolean> {
    const chain = chainKey === undefined ? undefined : requireFundingChain(chainKey, 'Chain halt lookup is invalid');
    return this.withRole('meowwa_app', undefined, async (client) => {
      const result = await client.query<{ halted: boolean }>(
        chain === undefined
          ? `SELECT EXISTS (
               SELECT 1 FROM meowwa_chain_reorg_halts WHERE resolved_at IS NULL
             ) AS halted`
          : `SELECT EXISTS (
               SELECT 1 FROM meowwa_chain_reorg_halts WHERE chain_key = $1 AND resolved_at IS NULL
             ) AS halted`,
        chain === undefined ? [] : [chain.key],
      );
      const halted = result.rows[0]?.halted;
      if (result.rows.length !== 1 || typeof halted !== 'boolean') {
        throw new Error('Chain halt lookup is invalid');
      }
      return halted;
    }, { readOnly: true });
  }

  async cancelPreparedWithdrawal(
    tenantId: string,
    withdrawalId: string,
  ): Promise<{ withdrawal: TenantWithdrawal; applied: boolean } | undefined> {
    if (!validIdentifier(withdrawalId)) throw new Error('Tenant withdrawal ID is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      // Defence in depth behind the dispatch marker: if the chain already shows this wallet paying
      // this destination this amount, no cancellation of any wording is truthful. The indexer only
      // sees a transfer after it lands, so this cannot replace the marker -- it catches the case
      // where the acknowledgement was lost long enough for the debit to be observed.
      //
      // Unless a rival open intent matches that debit just as well, in which case the veto is a
      // statement the server cannot make: with two identical dispatched intents and one debit, at
      // most one of them is that transfer, so refusing both is refusing at least one truthful
      // cancellation -- and the sweep will not attribute the debit while they compete either, so
      // both rows sat in `dispatch_review` for good under a notice naming this exact call as the
      // remedy. Nothing about the money changes: every competing intent already reads that debit
      // hashlessly, so none of them reserves anything to release.
      const settled = await client.query<{ transaction_hash: string }>(
        `SELECT chain.transaction_hash
         FROM meowwa_withdrawals AS withdrawal
         JOIN meowwa_wallet_chain_events AS chain
           ON ${unattributedChainDebit}
          AND chain.canonical_status = 'canonical'
         WHERE withdrawal.tenant_id = $1 AND withdrawal.withdrawal_id = $2
           AND NOT EXISTS (${rivalOpenIntent})
         LIMIT 1`,
        [tenantId, withdrawalId],
      );
      if (settled.rows.length > 0) throw new TenantWithdrawalSettledError();
      // The owner tapping Reject in Privy is the most common non-success ending of a withdrawal,
      // and this transition is its only closer: the client issues /cancel exactly once, inline,
      // with no retry. So a refusal here is not a retry -- it is permanent. This used to require
      // that the indexer had scanned past `dispatched_at + 15 minutes` (and that no reorg halt
      // was open), which no decline can ever satisfy: the amount stayed reserved against the
      // reconciled balance forever, the reaper later relabelled the row `dispatch_review`, and
      // the owner had no way to release their own money. A control that fails closed onto the
      // owner's balance is the failure.
      //
      // The margin was answering the wrong question. "Has the indexer looked?" only qualifies the
      // VETO -- an unattributed canonical debit, checked without a clock immediately above, which
      // is what makes any cancellation untruthful. It is not a precondition of the CLAIM:
      // `provider_rejected` says the cancellation arrived after dispatch and this server observed
      // no broadcast, and both halves are true the instant the call arrives. Only `cancelled`
      // claims nothing was sent, and only a never-dispatched intent may reach it.
      //
      // Nor is the caller's WORDING a precondition. A dispatched intent used to need
      // `reason: 'provider_user_rejected'` on the wire, a literal only one code path in the web
      // client ever sent -- inside the same in-memory call that had already failed. So the closer
      // existed and no owner could reach it: every interrupted decline (tab closed, laptop asleep,
      // Wi-Fi dropped) left the reservation held, and 60 minutes later the reaper relabelled it
      // `dispatch_review`, which nothing else clears. The reason is metadata; the derived status
      // already distinguishes the two claims from `dispatched_at` alone, which the caller cannot
      // forge. An owner asking to close their own intent is now enough for both.
      //
      // If a matching debit does land afterwards, `recordWalletOutflow` writes the chain event and
      // the ledger debit in one transaction, so the amount is charged exactly once -- by the
      // ledger, which needs no reservation. The reservation only ever covered the window before
      // that, and a released reservation cannot double-charge; over-releasing it can at worst let
      // the owner authorize a second transfer their own wallet has no balance for, which the chain
      // refuses. Under-releasing it strands their money with no code path back, which nothing does.
      const updated = await client.query(
        `UPDATE meowwa_withdrawals
         SET cancelled_at = transaction_timestamp(), updated_at = transaction_timestamp(),
             version = version + 1
         WHERE tenant_id = $1 AND withdrawal_id = $2
           AND submission_status = 'awaiting_owner_signature'
           AND transaction_hash IS NULL AND broadcast_at IS NULL AND cancelled_at IS NULL
           AND expired_at IS NULL`,
        [tenantId, withdrawalId],
      );
      const selected = await client.query<WithdrawalRow>(
        `SELECT ${withdrawalColumns}
         FROM meowwa_withdrawals AS withdrawal
         ${withdrawalEvidenceJoins}
         WHERE withdrawal.tenant_id = $1 AND withdrawal.withdrawal_id = $2`,
        [tenantId, withdrawalId],
      );
      if (selected.rows.length === 0) return undefined;
      if (selected.rows.length !== 1) throw new Error('Tenant withdrawal is ambiguous');
      if (updated.rowCount !== 0 && updated.rowCount !== 1) {
        throw new Error('Tenant withdrawal cancellation update is invalid');
      }
      return { withdrawal: mapWithdrawal(selected.rows[0]!), applied: updated.rowCount === 1 };
    }, { serializable: true });
  }

  async acknowledgeWithdrawalBroadcast(
    tenantId: string,
    withdrawalId: string,
    transactionHashValue: string,
  ): Promise<{ withdrawal: TenantWithdrawal; applied: boolean } | undefined> {
    if (!validIdentifier(withdrawalId)) throw new Error('Tenant withdrawal ID is invalid');
    if (!validIdentifier(transactionHashValue)) throw new Error('Tenant withdrawal transaction hash is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      // The hash is validated against the rail the intent was prepared on: an EVM hash on Base,
      // a base58 signature on Solana. That rail is the row's, so it is read before the update.
      const intent = await client.query<{ chain_key: string | null; chain_id: number | string | null }>(
        `SELECT chain_key, chain_id FROM meowwa_withdrawals WHERE tenant_id = $1 AND withdrawal_id = $2`,
        [tenantId, withdrawalId],
      );
      if (intent.rows.length === 0) return undefined;
      if (intent.rows.length !== 1) throw new Error('Tenant withdrawal is ambiguous');
      const chain = fundingChainOfRow(intent.rows[0]!.chain_key, intent.rows[0]!.chain_id, 'Tenant withdrawal row is invalid');
      if (!isChainTransactionId(chain, transactionHashValue)) throw new Error('Tenant withdrawal transaction hash is invalid');
      const transactionHash = canonicalChainTransactionId(chain.key, transactionHashValue);
      const updated = await client.query(
        `UPDATE meowwa_withdrawals
         SET submission_status = 'broadcast', transaction_hash = $3,
             broadcast_at = transaction_timestamp(), updated_at = transaction_timestamp(), version = version + 1
         WHERE tenant_id = $1 AND withdrawal_id = $2
           AND submission_status = 'awaiting_owner_signature' AND transaction_hash IS NULL
           AND broadcast_at IS NULL AND cancelled_at IS NULL AND dispatched_at IS NOT NULL`,
        [tenantId, withdrawalId, transactionHash],
      );
      const selected = await client.query<WithdrawalRow>(
        `SELECT ${withdrawalColumns}
         FROM meowwa_withdrawals AS withdrawal
         ${withdrawalEvidenceJoins}
         WHERE withdrawal.tenant_id = $1 AND withdrawal.withdrawal_id = $2`,
        [tenantId, withdrawalId],
      );
      if (selected.rows.length === 0) return undefined;
      if (selected.rows.length !== 1) throw new Error('Tenant withdrawal is ambiguous');
      const withdrawal = mapWithdrawal(selected.rows[0]!);
      if (updated.rowCount === 0 && (withdrawal.status === 'cancelled' || withdrawal.status === 'provider_rejected')) {
        throw new Error('Tenant withdrawal was cancelled before broadcast');
      }
      // A hash can only belong to a dispatched intent. Refusing here keeps the acknowledgement
      // retryable (an unchanged hash replays as applied:false) without letting a caller skip the
      // dispatch marker that makes the cancel path honest.
      if (updated.rowCount === 0 && withdrawal.dispatchedAt === null) {
        throw new Error('Tenant withdrawal was never dispatched to the provider');
      }
      // A settled withdrawal has nothing left to acknowledge, so any hash replays as a no-op rather
      // than a conflict. The wallet that replaced its transaction is exactly the case: the intent
      // recorded one hash, the chain carried another, and both the owner posting the landed hash and a
      // client replaying the one it stored used to be answered "already references another
      // transaction" -- a refusal about a transfer that had already completed, on a row nothing
      // else could close either.
      if (updated.rowCount === 0 && withdrawal.transactionHash !== transactionHash &&
        withdrawal.status !== 'confirmed') {
        throw new Error('Tenant withdrawal already references a different transaction');
      }
      if (updated.rowCount !== 0 && updated.rowCount !== 1) throw new Error('Tenant withdrawal broadcast update is invalid');
      return { withdrawal, applied: updated.rowCount === 1 };
    }, { serializable: true });
  }

  async attachProviderSession(tenantId: string, fundingId: string, providerSessionId: string): Promise<TenantFundingTransaction> {
    if (!validIdentifier(fundingId) || !validIdentifier(providerSessionId)) throw new Error('Tenant funding session is invalid');
    return this.withRole('meowwa_app', tenantId, async (client) => {
      const result = await client.query<FundingRow>(
        `UPDATE meowwa_funding_transactions
         SET provider_session_id = $3, updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND funding_id = $2 AND rail = 'stripe_onramp' AND status = 'pending'
           AND reconciliation_status = 'awaiting_provider'
           AND (provider_session_id IS NULL OR provider_session_id = $3)
         RETURNING ${fundingColumns}`,
        [tenantId, fundingId, providerSessionId],
      );
      if (result.rows.length !== 1) throw new Error('Tenant funding session was not attached');
      return mapFunding(result.rows[0]!);
    }, { serializable: true });
  }

  private async getFundingInTransaction(
    client: PgClientLike,
    tenantId: string,
    fundingId: string,
  ): Promise<TenantFundingTransaction | undefined> {
    const result = await client.query<FundingRow>(
      `SELECT ${fundingColumns}
       FROM meowwa_funding_transactions
       WHERE tenant_id = $1 AND funding_id = $2`,
      [tenantId, fundingId],
    );
    if (result.rows.length > 1) throw new Error('Tenant funding row is invalid');
    return result.rows[0] ? mapFunding(result.rows[0]) : undefined;
  }
}

export class PostgresWalletProvisioningRepository extends TenantRoleRepository {
  /** Encrypts the owner DID at rest. Absent until MEOWWA_WALLET_IDENTITY_ENCRYPTION_KEY is configured,
   *  in which case attestation keeps failing closed rather than attesting on shape alone. */
  #identityKey?: Buffer;

  useIdentityKey(key: Buffer): void {
    this.#identityKey = key;
  }

  #identityAad(tenantId: string, petId: string): string {
    return `meowwa:wallet-owner-identity:${tenantId}:${petId}`;
  }

  async ready(): Promise<boolean> {
    return this.withRole('meowwa_wallet_provisioner', undefined, async (client) => {
      const result = await client.query<{ ready: number }>('SELECT 1 AS ready');
      return result.rows.length === 1 && Number(result.rows[0]?.ready) === 1;
    }, { readOnly: true });
  }

  async getVerifiedBinding(
    tenantId: string,
    petId: string,
    chainKey: ControlChainKey = 'base_sepolia',
  ): Promise<TenantWalletBinding | undefined> {
    if (!validIdentifier(petId)) throw new Error('Verified tenant wallet reference is invalid');
    const chain = requireControlChain(chainKey, 'Verified tenant wallet chain is invalid');
    return this.withRole('meowwa_wallet_provisioner', tenantId, async (client) => {
      const result = await client.query<WalletRow>(
        // The one query that adds the sealed owner DID, because it is the one that decrypts it.
        `SELECT ${walletBindingColumns}, owner_identity_ciphertext
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND chain_key = $3`,
        [tenantId, petId, chain.key],
      );
      if (result.rows.length > 1) throw new Error('Verified tenant wallet binding is ambiguous');
      const row = result.rows[0];
      if (!row) return undefined;
      const binding = mapWallet(row, tenantId);
      const ciphertext = row.owner_identity_ciphertext ?? null;
      if (!ciphertext || !this.#identityKey) return binding;
      // A key mismatch or tampered row must not attest. Leave it null and let the caller fail closed.
      try {
        return { ...binding, ownerPrivyUserId: decryptTenantJson(this.#identityKey, this.#identityAad(tenantId, petId), ciphertext) };
      } catch { return binding; }
    }, { readOnly: true });
  }

  async stageExpiredPolicyRotation(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    chainKey: ControlChainKey;
    privyEmbeddedWalletId: string;
    smartWalletAddress: string;
    agentSignerId: string;
    proposedPolicyDigest: string;
    proposedPolicyValidUntil: string;
    plannedAt: string;
  }): Promise<TenantWalletBinding> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.walletId) || !validIdentifier(input.petId) ||
      !validIdentifier(input.privyEmbeddedWalletId) || !validIdentifier(input.agentSignerId) ||
      !/^[0-9a-f]{64}$/.test(input.proposedPolicyDigest) ||
      !Number.isFinite(Date.parse(input.proposedPolicyValidUntil)) || !Number.isFinite(Date.parse(input.plannedAt)) ||
      Date.parse(input.proposedPolicyValidUntil) <= Date.parse(input.plannedAt)) {
      throw new Error('Tenant wallet policy rotation plan is invalid');
    }
    const chain = requireControlChain(input.chainKey, 'Tenant wallet policy rotation plan is invalid');
    const address = canonicalChainAddress(chain.key, input.smartWalletAddress);
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `meowwa:wallet-provisioning:${input.tenantId}:${input.petId}`,
      ]);
      const existing = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3
         FOR UPDATE`,
        [input.tenantId, input.petId, input.walletId],
      );
      if (existing.rows.length !== 1) throw new Error('Tenant wallet policy rotation binding was not found');
      const binding = mapWallet(existing.rows[0]!, input.tenantId);
      if (binding.privyEmbeddedWalletId !== input.privyEmbeddedWalletId || binding.chainKey !== chain.key ||
        !sameAddressOn(chain.key, binding.smartWalletAddress, address) || binding.agentSignerId !== input.agentSignerId ||
        binding.agentPolicyId === null || binding.policyDigest === null || binding.policyValidUntil === null ||
        binding.controlVerifiedAt === null || !['active', 'provisioning'].includes(binding.status)) {
        throw new Error('Tenant wallet policy rotation binding is invalid');
      }
      if (binding.status === 'provisioning' && Date.parse(binding.policyValidUntil) > Date.parse(input.plannedAt)) {
        return binding;
      }
      const staged = await client.query<WalletRow>(
        `UPDATE meowwa_pet_wallet_bindings
         SET status = 'provisioning', policy_digest = $4, policy_valid_until = $5,
             updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3
           AND agent_signer_id = $6
           AND (status = 'provisioning' OR (status = 'active' AND policy_valid_until <= transaction_timestamp()))
         RETURNING ${walletBindingColumns}`,
        [input.tenantId, input.petId, input.walletId, input.proposedPolicyDigest,
          input.proposedPolicyValidUntil, input.agentSignerId],
      );
      if (staged.rows.length !== 1) throw new Error('Tenant wallet policy rotation is not due');
      return mapWallet(staged.rows[0]!, input.tenantId);
    }, { serializable: true });
  }

  async recordPolicyRotationTarget(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    expectedPolicyId: string;
    targetPolicyId: string;
    policyDigest: string;
    policyValidUntil: string;
  }): Promise<TenantWalletBinding> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.walletId) || !validIdentifier(input.petId) ||
      !validIdentifier(input.expectedPolicyId) || !validIdentifier(input.targetPolicyId) ||
      !/^[0-9a-f]{64}$/.test(input.policyDigest) || !Number.isFinite(Date.parse(input.policyValidUntil))) {
      throw new Error('Tenant wallet policy rotation target is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      const updated = await client.query<WalletRow>(
        `UPDATE meowwa_pet_wallet_bindings
         SET agent_policy_id = $4, updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3 AND status = 'provisioning'
           AND agent_policy_id = $5 AND policy_digest = $6 AND policy_valid_until = $7
         RETURNING ${walletBindingColumns}`,
        [input.tenantId, input.petId, input.walletId, input.targetPolicyId, input.expectedPolicyId,
          input.policyDigest, input.policyValidUntil],
      );
      if (updated.rows.length === 1) return mapWallet(updated.rows[0]!, input.tenantId);
      const existing = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3
         FOR UPDATE`,
        [input.tenantId, input.petId, input.walletId],
      );
      if (existing.rows.length !== 1) throw new Error('Tenant wallet policy rotation target was not saved');
      const binding = mapWallet(existing.rows[0]!, input.tenantId);
      if (binding.status !== 'provisioning' || binding.agentPolicyId !== input.targetPolicyId ||
        binding.policyDigest !== input.policyDigest ||
        binding.policyValidUntil !== new Date(input.policyValidUntil).toISOString()) {
        throw new Error('Tenant wallet policy rotation target lost a race');
      }
      return binding;
    }, { serializable: true });
  }

  async activateVerifiedPolicyRotation(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    chainKey: ControlChainKey;
    ownerQuorumId: string;
    agentSignerId: string;
    targetPolicyId: string;
    policyDigest: string;
    policyValidUntil: string;
    controlVerifiedAt: string;
    productionFunding?: boolean;
  }): Promise<TenantWalletBinding> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.walletId) || !validIdentifier(input.petId) ||
      !validIdentifier(input.ownerQuorumId) || !validIdentifier(input.agentSignerId) ||
      !validIdentifier(input.targetPolicyId) || !/^[0-9a-f]{64}$/.test(input.policyDigest) ||
      !Number.isFinite(Date.parse(input.policyValidUntil)) || !Number.isFinite(Date.parse(input.controlVerifiedAt)) ||
      Date.parse(input.policyValidUntil) <= Date.parse(input.controlVerifiedAt) ||
      (input.productionFunding !== undefined && typeof input.productionFunding !== 'boolean')) {
      throw new Error('Verified tenant wallet policy rotation is invalid');
    }
    const chain = requireControlChain(input.chainKey, 'Verified tenant wallet policy rotation is invalid');
    const fundingChain = CHAINS[fundingChainFor(chain.key)];
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      // Production attestation names the rail this binding's family funds: Base for a Base Sepolia
      // binding, Solana for a Solana Devnet one. The numeric id is written only where the rail has
      // one; a Solana rail is identified by its key alone.
      const updated = await client.query<WalletRow>(
        `UPDATE meowwa_pet_wallet_bindings
         SET status = 'active', owner_quorum_id = $4, control_verified_at = $5,
             funding_chain_key = CASE WHEN $10::boolean THEN $11::text ELSE funding_chain_key END,
             funding_chain_id = CASE WHEN $10::boolean THEN $12::integer ELSE funding_chain_id END,
             funding_environment = CASE WHEN $10::boolean THEN 'production' ELSE funding_environment END,
             custody_classification = CASE WHEN $10::boolean THEN 'owner_controlled' ELSE custody_classification END,
             funding_verified_at = CASE WHEN $10::boolean THEN $5::timestamptz ELSE funding_verified_at END,
             updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3 AND chain_key = $13 AND status = 'provisioning'
           AND agent_signer_id = $6 AND agent_policy_id = $7 AND policy_digest = $8 AND policy_valid_until = $9
         RETURNING ${walletBindingColumns}`,
        [input.tenantId, input.petId, input.walletId, input.ownerQuorumId, input.controlVerifiedAt,
          input.agentSignerId, input.targetPolicyId, input.policyDigest, input.policyValidUntil,
          input.productionFunding === true, fundingChain.key, evmChainId(fundingChain), chain.key],
      );
      if (updated.rows.length === 1) return mapWallet(updated.rows[0]!, input.tenantId);
      const existing = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3
         FOR UPDATE`,
        [input.tenantId, input.petId, input.walletId],
      );
      if (existing.rows.length !== 1) throw new Error('Verified tenant wallet policy rotation was not activated');
      const binding = mapWallet(existing.rows[0]!, input.tenantId);
      if (binding.status !== 'active' || binding.chainKey !== chain.key || binding.ownerQuorumId !== input.ownerQuorumId ||
        binding.agentSignerId !== input.agentSignerId || binding.agentPolicyId !== input.targetPolicyId ||
        binding.policyDigest !== input.policyDigest ||
        binding.policyValidUntil !== new Date(input.policyValidUntil).toISOString() ||
        (input.productionFunding === true && (binding.fundingChainKey !== fundingChain.key ||
          binding.fundingEnvironment !== 'production' || binding.custodyClassification !== 'owner_controlled' ||
          binding.controlVerifiedAt === null || binding.fundingVerifiedAt === undefined ||
          Date.parse(binding.fundingVerifiedAt) < Date.parse(binding.controlVerifiedAt)))) {
        throw new Error('Verified tenant wallet policy rotation lost a race');
      }
      return binding;
    }, { serializable: true });
  }

  async saveVerifiedBinding(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    chainKey: ControlChainKey;
    privyEmbeddedWalletId: string;
    smartWalletAddress: string;
    ownerQuorumId: string;
    /** Already encrypted by the caller: the raw DID must never cross this boundary. */
    ownerIdentityCiphertext: string;
    agentSignerId: string;
    agentPolicyId: string;
    policyDigest: string;
    policyValidUntil: string;
    controlVerifiedAt: string;
    productionFunding?: boolean;
  }): Promise<TenantWalletBinding> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.walletId) || !validIdentifier(input.petId) ||
      !validIdentifier(input.privyEmbeddedWalletId) || !validIdentifier(input.ownerQuorumId) || !validIdentifier(input.agentSignerId) ||
      !validIdentifier(input.agentPolicyId) || !/^[0-9a-f]{64}$/.test(input.policyDigest) ||
      !input.ownerIdentityCiphertext.startsWith('enc:v2:') ||
      !Number.isFinite(Date.parse(input.policyValidUntil)) || !Number.isFinite(Date.parse(input.controlVerifiedAt)) ||
      Date.parse(input.policyValidUntil) <= Date.parse(input.controlVerifiedAt) ||
      (input.productionFunding !== undefined && typeof input.productionFunding !== 'boolean')) {
      throw new Error('Verified tenant wallet binding is invalid');
    }
    const chain = requireControlChain(input.chainKey, 'Verified tenant wallet binding is invalid');
    // A pet's Solana binding is named after its EVM one, so the two ids can never collide and a
    // reader can tell the family from the id alone.
    if (chain.key === 'solana_devnet' && !input.walletId.endsWith('_solana')) {
      throw new Error('Verified tenant wallet binding is invalid');
    }
    const fundingChain = CHAINS[fundingChainFor(chain.key)];
    const address = canonicalChainAddress(chain.key, input.smartWalletAddress);
    const ownerIdentity = input.ownerIdentityCiphertext;
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `meowwa:wallet-provisioning:${input.tenantId}:${input.petId}`,
      ]);
      // One binding per pet per control network: the other family's binding is a sibling, not a
      // conflict, so the lookup is keyed on the chain as well as the pet.
      const existing = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND chain_key = $3
         FOR UPDATE`,
        [input.tenantId, input.petId, chain.key],
      );
      if (existing.rows.length > 1) throw new Error('Verified tenant wallet binding is invalid');
      if (existing.rows[0]) {
        const binding = mapWallet(existing.rows[0], input.tenantId);
        if (binding.walletId !== input.walletId || binding.privyEmbeddedWalletId !== input.privyEmbeddedWalletId ||
          binding.chainKey !== chain.key || !sameAddressOn(chain.key, binding.smartWalletAddress, address) ||
          binding.status !== 'active' ||
          (binding.ownerQuorumId !== null && binding.ownerQuorumId !== input.ownerQuorumId) ||
          (binding.agentSignerId !== null && (binding.agentSignerId !== input.agentSignerId ||
            binding.agentPolicyId !== input.agentPolicyId || binding.policyDigest !== input.policyDigest ||
            binding.policyValidUntil !== new Date(input.policyValidUntil).toISOString()))) {
          throw new Error('Pet already has a different verified wallet binding');
        }
        const updated = await client.query<WalletRow>(
          `UPDATE meowwa_pet_wallet_bindings
           SET owner_quorum_id = $4, agent_signer_id = $5, agent_policy_id = $6, policy_digest = $7,
               policy_valid_until = $8, control_verified_at = $9, owner_identity_ciphertext = $11,
               funding_chain_key = CASE WHEN $10::boolean THEN $12::text ELSE funding_chain_key END,
               funding_chain_id = CASE WHEN $10::boolean THEN $13::integer ELSE funding_chain_id END,
               funding_environment = CASE WHEN $10::boolean THEN 'production' ELSE funding_environment END,
               custody_classification = CASE WHEN $10::boolean THEN 'owner_controlled' ELSE custody_classification END,
               funding_verified_at = CASE WHEN $10::boolean THEN $9::timestamptz ELSE funding_verified_at END,
               updated_at = transaction_timestamp()
           WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3 AND chain_key = $14 AND status = 'active'
           RETURNING ${walletBindingColumns}`,
          [input.tenantId, input.petId, input.walletId, input.ownerQuorumId, input.agentSignerId, input.agentPolicyId,
            input.policyDigest, input.policyValidUntil, input.controlVerifiedAt, input.productionFunding === true,
            ownerIdentity, fundingChain.key, evmChainId(fundingChain), chain.key],
        );
        if (updated.rows.length !== 1) throw new Error('Verified tenant wallet control was not saved');
        return mapWallet(updated.rows[0]!, input.tenantId);
      }
      const inserted = await client.query<WalletRow>(
        `INSERT INTO meowwa_pet_wallet_bindings (
           tenant_id, wallet_id, pet_id, provider, privy_embedded_wallet_id,
           smart_wallet_address, owner_quorum_id, agent_signer_id, agent_policy_id, policy_digest,
           policy_valid_until, control_verified_at, chain_key, chain_id, status,
           funding_chain_key, funding_chain_id, funding_environment, custody_classification, funding_verified_at,
           owner_identity_ciphertext
         ) VALUES ($1, $2, $3, 'privy', $4, $5, $6, $7, $8, $9, $10, $11, $14, $15, 'active',
           CASE WHEN $12::boolean THEN $16::text END,
           CASE WHEN $12::boolean THEN $17::integer END,
           CASE WHEN $12::boolean THEN 'production' END,
           CASE WHEN $12::boolean THEN 'owner_controlled' END,
           CASE WHEN $12::boolean THEN $11::timestamptz END,
           $13)
         RETURNING ${walletBindingColumns}`,
        [input.tenantId, input.walletId, input.petId, input.privyEmbeddedWalletId, address,
          input.ownerQuorumId, input.agentSignerId, input.agentPolicyId, input.policyDigest,
          input.policyValidUntil, input.controlVerifiedAt, input.productionFunding === true, ownerIdentity,
          chain.key, evmChainId(chain), fundingChain.key, evmChainId(fundingChain)],
      );
      if (inserted.rows.length !== 1) throw new Error('Verified tenant wallet binding was not saved');
      return mapWallet(inserted.rows[0]!, input.tenantId);
    }, { serializable: true });
  }

  async prepareExecution(input: PrepareTenantWalletExecutionInput): Promise<TenantWalletExecutionSubmission> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.submissionId) || !validIdentifier(input.requestId) ||
      !validIdentifier(input.ownerSubject, 512) || !validIdentifier(input.petId) || !validIdentifier(input.walletId) ||
      !validIdentifier(input.providerWalletId) || !validIdentifier(input.ownerQuorumId) ||
      !validIdentifier(input.agentSignerId) || !validIdentifier(input.agentPolicyId) ||
      !/^[0-9a-f]{64}$/.test(input.policyDigest) || !/^[0-9a-f]{64}$/.test(input.intentHash) ||
      !/^mw_[0-9a-f]{61}$/.test(input.referenceId) || input.chainKey !== 'base_sepolia' || input.chainId !== 84532 ||
      !isCanonicalUsdcAsset(CHAINS.base_sepolia, input.contract) ||
      !isEvmAddress(input.sender) || !isEvmAddress(input.recipient) || !isAtomicAmount(input.amountAtomic) ||
      input.amountAtomic === '0' || input.valueAtomic !== '0' || !/^0x[0-9a-fA-F]{136}$/.test(input.calldata) ||
      !Number.isFinite(Date.parse(input.policyValidUntil)) || !Number.isFinite(Date.parse(input.controlVerifiedAt)) ||
      Date.parse(input.policyValidUntil) <= Date.parse(input.controlVerifiedAt)) {
      throw new Error('Tenant wallet execution request is invalid');
    }
    const normalized = {
      ...input,
      contract: canonicalChainAddress('base_sepolia', input.contract),
      sender: canonicalChainAddress('base_sepolia', input.sender),
      recipient: canonicalChainAddress('base_sepolia', input.recipient),
      calldata: input.calldata.toLowerCase() as `0x${string}`,
      policyValidUntil: new Date(input.policyValidUntil).toISOString(),
      controlVerifiedAt: new Date(input.controlVerifiedAt).toISOString(),
    };
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `meowwa:wallet-execution:${input.tenantId}:${input.requestId}`,
      ]);
      const existing = await client.query<WalletExecutionRow>(
        `SELECT ${walletExecutionColumns}
         FROM meowwa_wallet_execution_submissions
         WHERE tenant_id = $1 AND request_id = $2`,
        [input.tenantId, input.requestId],
      );
      if (existing.rows.length > 1) throw new Error('Tenant wallet execution row is ambiguous');
      if (existing.rows[0]) {
        const submission = mapWalletExecution(existing.rows[0], input.tenantId);
        if (executionIdentity(submission) !== executionIdentity(normalized)) throw new TenantWalletExecutionConflictError();
        return submission;
      }
      const wallet = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3 AND status = 'active'
         FOR UPDATE`,
        [input.tenantId, input.petId, input.walletId],
      );
      if (wallet.rows.length !== 1) throw new Error('Tenant wallet execution binding is invalid');
      const binding = mapWallet(wallet.rows[0]!, input.tenantId);
      if (binding.privyEmbeddedWalletId !== normalized.providerWalletId || binding.chainKey !== normalized.chainKey ||
        binding.smartWalletAddress !== normalized.sender || binding.ownerQuorumId !== normalized.ownerQuorumId ||
        binding.agentSignerId !== normalized.agentSignerId || binding.agentPolicyId !== normalized.agentPolicyId ||
        binding.policyDigest !== normalized.policyDigest || binding.policyValidUntil !== normalized.policyValidUntil ||
        binding.controlVerifiedAt !== normalized.controlVerifiedAt) {
        throw new Error('Tenant wallet execution binding changed before submission');
      }
      const inserted = await client.query<WalletExecutionRow>(
        `INSERT INTO meowwa_wallet_execution_submissions (
           tenant_id, submission_id, request_id, owner_subject, pet_id, wallet_id,
           provider_wallet_id, owner_quorum_id, agent_signer_id, agent_policy_id, policy_digest,
           policy_valid_until, control_verified_at, intent_hash, reference_id, chain_key, chain_id, contract,
           sender, recipient, amount_atomic, value_atomic, calldata, status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           $21, $22, $16, $17, $18, $19, 0, $20, 'prepared'
         ) RETURNING ${walletExecutionColumns}`,
        [
          normalized.tenantId, normalized.submissionId, normalized.requestId, normalized.ownerSubject,
          normalized.petId, normalized.walletId, normalized.providerWalletId, normalized.ownerQuorumId,
          normalized.agentSignerId, normalized.agentPolicyId, normalized.policyDigest,
          normalized.policyValidUntil, normalized.controlVerifiedAt, normalized.intentHash, normalized.referenceId,
          normalized.contract, normalized.sender, normalized.recipient, normalized.amountAtomic, normalized.calldata,
          normalized.chainKey, normalized.chainId,
        ],
      );
      if (inserted.rows.length !== 1) throw new Error('Tenant wallet execution was not prepared');
      await this.insertExecutionEvent(client, input.tenantId, input.submissionId, 1, 'submission_prepared', null, 'prepared', null);
      return mapWalletExecution(inserted.rows[0]!, input.tenantId);
    }, { serializable: true });
  }

  async markExecutionSubmitting(
    tenantId: string,
    submissionId: string,
    expectedVersion: number,
  ): Promise<TenantWalletExecutionSubmission> {
    return this.transitionExecution({
      tenantId, submissionId, expectedVersion, allowed: ['prepared'], to: 'submitting',
      kind: 'provider_submission_started', assignment: 'failure_code = NULL', values: [],
    });
  }

  async markExecutionSubmitted(input: {
    tenantId: string;
    submissionId: string;
    expectedVersion: number;
    providerTransactionId: string;
    userOperationHash: `0x${string}` | null;
    transactionHash: `0x${string}` | null;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }): Promise<TenantWalletExecutionSubmission> {
    if (!validIdentifier(input.providerTransactionId) ||
      (input.userOperationHash !== null && !isEvmTransactionHash(input.userOperationHash)) ||
      (input.transactionHash !== null && !isEvmTransactionHash(input.transactionHash))) {
      throw new Error('Tenant wallet execution provider result is invalid');
    }
    return this.transitionExecution({
      tenantId: input.tenantId, submissionId: input.submissionId, expectedVersion: input.expectedVersion,
      allowed: ['submitting', 'unknown'], to: 'submitted', kind: 'provider_submission_accepted',
      assignment: 'provider_transaction_id = $5, user_operation_hash = $6, transaction_hash = $7, failure_code = NULL',
      values: [input.providerTransactionId, input.userOperationHash?.toLowerCase() ?? null, input.transactionHash?.toLowerCase() ?? null],
      claim: input.claim,
      validateCurrent: (current) => {
        if ((current.providerTransactionId && current.providerTransactionId !== input.providerTransactionId) ||
          (current.userOperationHash && current.userOperationHash.toLowerCase() !== input.userOperationHash?.toLowerCase()) ||
          (current.transactionHash && current.transactionHash.toLowerCase() !== input.transactionHash?.toLowerCase())) {
          throw new TenantWalletExecutionConflictError('Tenant wallet execution provider evidence conflicts');
        }
      },
    });
  }

  async markExecutionUnknown(
    tenantId: string,
    submissionId: string,
    expectedVersion: number,
    reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission> {
    if (!validIdentifier(reason)) throw new Error('Tenant wallet execution unknown reason is invalid');
    return this.transitionExecution({
      tenantId, submissionId, expectedVersion, allowed: ['submitting', 'submitted'], to: 'unknown',
      kind: 'submission_outcome_unknown', detail: reason, assignment: 'failure_code = $5', values: [reason],
      claim,
    });
  }

  async resolveExecutionTenant(input: {
    referenceId: string | null;
    providerTransactionId: string;
  }): Promise<string | undefined> {
    if ((input.referenceId !== null && !/^mw_[0-9a-f]{61}$/.test(input.referenceId)) ||
      !validIdentifier(input.providerTransactionId)) {
      throw new Error('Tenant wallet execution provider identity is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', undefined, async (client) => {
      const resolved = new Set<string>();
      if (input.referenceId !== null) {
        const byReference = await client.query<{ tenant_id: string | null }>(
          'SELECT meowwa_resolve_wallet_execution_reference($1)::text AS tenant_id',
          [input.referenceId],
        );
        if (byReference.rows.length !== 1) throw new Error('Tenant wallet execution reference resolution is invalid');
        if (byReference.rows[0]?.tenant_id) resolved.add(byReference.rows[0].tenant_id);
      }
      const byProvider = await client.query<{ tenant_id: string | null }>(
        'SELECT meowwa_resolve_wallet_execution_provider($1)::text AS tenant_id',
        [input.providerTransactionId],
      );
      if (byProvider.rows.length !== 1) throw new Error('Tenant wallet execution provider resolution is invalid');
      if (byProvider.rows[0]?.tenant_id) resolved.add(byProvider.rows[0].tenant_id);
      if (resolved.size > 1) throw new TenantWalletExecutionConflictError('Provider identities resolve to different tenants');
      const tenantId = [...resolved][0];
      if (tenantId !== undefined && !isCanonicalTenantId(tenantId)) {
        throw new Error('Tenant wallet execution provider resolution is invalid');
      }
      return tenantId;
    }, { readOnly: true });
  }

  async getExecutionById(tenantId: string, submissionId: string): Promise<TenantWalletExecutionSubmission | undefined> {
    if (!validIdentifier(submissionId)) throw new Error('Tenant wallet execution submission ID is invalid');
    return this.withRole('meowwa_wallet_provisioner', tenantId, async (client) => {
      const result = await client.query<WalletExecutionRow>(
        `SELECT ${walletExecutionColumns}
         FROM meowwa_wallet_execution_submissions
         WHERE tenant_id = $1 AND submission_id = $2`,
        [tenantId, submissionId],
      );
      if (result.rows.length > 1) throw new Error('Tenant wallet execution row is ambiguous');
      return result.rows[0] ? mapWalletExecution(result.rows[0], tenantId) : undefined;
    }, { readOnly: true });
  }

  async findExecutionByProviderIdentity(input: {
    tenantId: string;
    referenceId: string | null;
    providerTransactionId: string;
  }): Promise<TenantWalletExecutionSubmission | undefined> {
    if ((input.referenceId !== null && !/^mw_[0-9a-f]{61}$/.test(input.referenceId)) ||
      !validIdentifier(input.providerTransactionId)) {
      throw new Error('Tenant wallet execution provider identity is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      const result = await client.query<WalletExecutionRow>(
        `SELECT ${walletExecutionColumns}
         FROM meowwa_wallet_execution_submissions
         WHERE tenant_id = $1
           AND (($2::text IS NOT NULL AND reference_id = $2) OR provider_transaction_id = $3)`,
        [input.tenantId, input.referenceId, input.providerTransactionId],
      );
      if (result.rows.length > 1) throw new TenantWalletExecutionConflictError('Provider identities match different submissions');
      return result.rows[0] ? mapWalletExecution(result.rows[0], input.tenantId) : undefined;
    }, { readOnly: true });
  }

  async claimExecutionReconciliation(input: {
    workerId: string;
    leaseSeconds: number;
  }): Promise<TenantWalletExecutionReconciliationClaim | undefined> {
    if (!validIdentifier(input.workerId, 128) || input.workerId.length < 8 ||
      !Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300) {
      throw new Error('Tenant wallet reconciliation claim is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', undefined, async (client) => {
      const result = await client.query<WalletExecutionClaimRow>(
        `SELECT tenant_id::text, submission_id, locked_until, fence_token
         FROM meowwa_claim_wallet_execution_reconcile($1, $2)`,
        [input.workerId, input.leaseSeconds],
      );
      if (result.rows.length > 1) throw new Error('Tenant wallet reconciliation claim is ambiguous');
      const row = result.rows[0];
      if (!row) return undefined;
      const fenceToken = Number(row.fence_token);
      if (!isCanonicalTenantId(row.tenant_id) || !validIdentifier(row.submission_id) ||
        !Number.isSafeInteger(fenceToken) || fenceToken < 1) {
        throw new Error('Tenant wallet reconciliation claim is invalid');
      }
      return {
        tenantId: row.tenant_id,
        submissionId: row.submission_id,
        workerId: input.workerId,
        lockedUntil: canonicalTimestamp(row.locked_until),
        fenceToken,
      };
    });
  }

  async renewExecutionReconciliationClaim(
    claim: TenantWalletExecutionReconciliationClaim,
    leaseSeconds: number,
  ): Promise<boolean> {
    this.validateExecutionReconciliationClaim(claim, 'renewal');
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
      throw new Error('Tenant wallet reconciliation renewal is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', undefined, async (client) => {
      const result = await client.query<{ renewed: boolean }>(
        `SELECT meowwa_renew_wallet_execution_reconcile($1, $2, $3, $4, $5) AS renewed`,
        [claim.tenantId, claim.submissionId, claim.workerId, claim.fenceToken, leaseSeconds],
      );
      if (result.rows.length !== 1 || typeof result.rows[0]?.renewed !== 'boolean') {
        throw new Error('Tenant wallet reconciliation renewal is invalid');
      }
      return result.rows[0].renewed;
    });
  }

  async releaseExecutionReconciliationClaim(
    claim: TenantWalletExecutionReconciliationClaim,
  ): Promise<boolean> {
    this.validateExecutionReconciliationClaim(claim, 'release');
    return this.withRole('meowwa_wallet_provisioner', undefined, async (client) => {
      const result = await client.query<{ released: boolean }>(
        `SELECT meowwa_release_wallet_execution_reconcile($1, $2, $3, $4) AS released`,
        [claim.tenantId, claim.submissionId, claim.workerId, claim.fenceToken],
      );
      if (result.rows.length !== 1 || typeof result.rows[0]?.released !== 'boolean') {
        throw new Error('Tenant wallet reconciliation release is invalid');
      }
      return result.rows[0].released;
    });
  }

  async recordExecutionWebhook(input: {
    tenantId: string;
    deliveryId: string;
    eventType: string;
    payloadSha256: string;
  }): Promise<'inserted' | 'duplicate'> {
    if (!validIdentifier(input.deliveryId) || !validIdentifier(input.eventType) ||
      !/^[0-9a-f]{64}$/.test(input.payloadSha256)) {
      throw new Error('Tenant wallet execution webhook is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO meowwa_wallet_execution_webhooks (
           tenant_id, delivery_id, event_type, payload_sha256
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (delivery_id) DO NOTHING`,
        [input.tenantId, input.deliveryId, input.eventType, input.payloadSha256],
      );
      const existing = await client.query<{
        tenant_id: string; event_type: string; payload_sha256: string; processed_at: Date | string | null;
      }>(
        `SELECT tenant_id::text, event_type, payload_sha256, processed_at
         FROM meowwa_wallet_execution_webhooks
         WHERE tenant_id = $1 AND delivery_id = $2`,
        [input.tenantId, input.deliveryId],
      );
      if (existing.rows.length !== 1 || existing.rows[0]?.tenant_id !== input.tenantId ||
        existing.rows[0].event_type !== input.eventType || existing.rows[0].payload_sha256 !== input.payloadSha256) {
        throw new TenantWalletExecutionConflictError('Wallet webhook delivery identity conflicts');
      }
      return inserted.rowCount === 1 ? 'inserted' : 'duplicate';
    }, { serializable: true });
  }

  async executionWebhookProcessed(tenantId: string, deliveryId: string): Promise<boolean> {
    if (!validIdentifier(deliveryId)) throw new Error('Tenant wallet execution webhook ID is invalid');
    return this.withRole('meowwa_wallet_provisioner', tenantId, async (client) => {
      const result = await client.query<{ processed_at: Date | string | null }>(
        `SELECT processed_at FROM meowwa_wallet_execution_webhooks
         WHERE tenant_id = $1 AND delivery_id = $2`,
        [tenantId, deliveryId],
      );
      if (result.rows.length !== 1) throw new Error('Tenant wallet execution webhook was not found');
      return result.rows[0]?.processed_at !== null;
    }, { readOnly: true });
  }

  async markExecutionWebhookProcessed(tenantId: string, deliveryId: string): Promise<void> {
    if (!validIdentifier(deliveryId)) throw new Error('Tenant wallet execution webhook ID is invalid');
    await this.withRole('meowwa_wallet_provisioner', tenantId, async (client) => {
      const result = await client.query(
        `UPDATE meowwa_wallet_execution_webhooks
         SET processed_at = COALESCE(processed_at, transaction_timestamp())
         WHERE tenant_id = $1 AND delivery_id = $2`,
        [tenantId, deliveryId],
      );
      if (result.rowCount !== 1) throw new Error('Tenant wallet execution webhook was not processed');
    });
  }

  async markExecutionProviderConfirmed(input: {
    tenantId: string;
    submissionId: string;
    expectedVersion: number;
    providerTransactionId: string;
    transactionHash: `0x${string}`;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }): Promise<TenantWalletExecutionSubmission> {
    if (!validIdentifier(input.providerTransactionId) || !isEvmTransactionHash(input.transactionHash)) {
      throw new Error('Tenant wallet provider confirmation is invalid');
    }
    return this.transitionExecution({
      tenantId: input.tenantId, submissionId: input.submissionId, expectedVersion: input.expectedVersion,
      allowed: ['submitting', 'submitted', 'unknown'], to: 'provider_confirmed', kind: 'provider_confirmation_verified',
      assignment: 'provider_transaction_id = $5, transaction_hash = $6, failure_code = NULL',
      values: [input.providerTransactionId, input.transactionHash.toLowerCase()],
      claim: input.claim,
      validateCurrent: (current) => {
        if ((current.providerTransactionId && current.providerTransactionId !== input.providerTransactionId) ||
          (current.transactionHash && current.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase())) {
          throw new TenantWalletExecutionConflictError('Tenant wallet execution provider evidence conflicts');
        }
      },
    });
  }

  async markExecutionFailed(
    tenantId: string,
    submissionId: string,
    expectedVersion: number,
    reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission> {
    if (!validIdentifier(reason)) throw new Error('Tenant wallet execution failure reason is invalid');
    return this.transitionExecution({
      tenantId, submissionId, expectedVersion, allowed: ['submitting', 'submitted', 'unknown'], to: 'failed',
      kind: 'provider_execution_failed', detail: reason, assignment: 'failure_code = $5', values: [reason],
      claim,
    });
  }

  /**
   * Records the outcome of an owner-authorized signer revocation, after the provider has been asked
   * whether the signer is actually gone. `drifted` is kept distinct from `revoked` on purpose: it
   * means something unexpected is still attached, which is an alert, not a clean revocation.
   */
  async recordBindingRevocation(input: {
    tenantId: string;
    petId: string;
    expectedWalletId: string;
    status: 'revoked' | 'drifted';
    reason: string;
    revokedAt: string;
  }): Promise<TenantWalletBinding> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.petId) ||
      !validIdentifier(input.expectedWalletId) || !validIdentifier(input.reason, 255) ||
      !Number.isFinite(Date.parse(input.revokedAt))) {
      throw new Error('Tenant wallet binding revocation input is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      const result = await client.query<WalletRow>(
        `UPDATE meowwa_pet_wallet_bindings
         SET status = $4, revocation_reason = $5, revoked_at = $6::timestamptz, updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND pet_id = $2 AND wallet_id = $3
           AND status NOT IN ('revoked', 'drifted')
         RETURNING ${walletBindingColumns}`,
        [input.tenantId, input.petId, input.expectedWalletId, input.status, input.reason, input.revokedAt],
      );
      if (result.rows.length !== 1) throw new Error('Tenant wallet binding revocation was not recorded');
      return mapWallet(result.rows[0]!, input.tenantId);
    });
  }

  /** Records one blind re-submission before it is attempted, so a crash mid-attempt still counts. */
  async recordBlindSubmitAttempt(tenantId: string, submissionId: string): Promise<number> {
    if (!isCanonicalTenantId(tenantId) || !validIdentifier(submissionId)) {
      throw new Error('Tenant wallet execution blind attempt reference is invalid');
    }
    return this.withRole('meowwa_wallet_provisioner', tenantId, async (client) => {
      const result = await client.query<{ blind_submit_attempts: number | string }>(
        `UPDATE meowwa_wallet_execution_submissions
         SET blind_submit_attempts = blind_submit_attempts + 1
         WHERE tenant_id = $1 AND submission_id = $2
         RETURNING blind_submit_attempts`,
        [tenantId, submissionId],
      );
      return Number(result.rows[0]?.blind_submit_attempts ?? 0);
    });
  }

  async markExecutionReviewRequired(
    tenantId: string,
    submissionId: string,
    expectedVersion: number,
    reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission> {
    if (!validIdentifier(reason)) throw new Error('Tenant wallet execution review reason is invalid');
    return this.transitionExecution({
      tenantId, submissionId, expectedVersion,
      allowed: ['submitting', 'submitted', 'provider_confirmed', 'unknown'], to: 'review_required',
      kind: 'wallet_execution_review_required', detail: reason, assignment: 'failure_code = $5', values: [reason],
      claim,
    });
  }

  async recordExecutionEvidenceConflict(
    tenantId: string,
    submissionId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<TenantWalletExecutionSubmission> {
    if (!validIdentifier(reason)) throw new Error('Tenant wallet execution evidence conflict is invalid');
    const current = await this.getExecutionById(tenantId, submissionId);
    if (!current || (current.status !== 'confirmed' && current.status !== 'failed')) {
      throw new TenantWalletExecutionConflictError('Tenant wallet execution evidence conflict is not terminal');
    }
    if (current.failureCode === reason) return current;
    return this.transitionExecution({
      tenantId, submissionId, expectedVersion,
      allowed: ['confirmed', 'failed'], to: current.status,
      kind: 'wallet_execution_evidence_conflict', detail: reason,
      assignment: 'failure_code = $5', values: [reason],
    });
  }

  async confirmExecutionChain(input: {
    tenantId: string;
    submissionId: string;
    expectedVersion: number;
    transactionHash: `0x${string}`;
    blockHash: `0x${string}`;
    blockNumber: number;
    logIndex: number;
    confirmedAt: string;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }): Promise<TenantWalletExecutionSubmission> {
    if (!isEvmTransactionHash(input.transactionHash) || !isEvmTransactionHash(input.blockHash) ||
      !Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 ||
      !Number.isSafeInteger(input.logIndex) || input.logIndex < 0 || !Number.isFinite(Date.parse(input.confirmedAt))) {
      throw new Error('Tenant wallet chain confirmation is invalid');
    }
    return this.transitionExecution({
      tenantId: input.tenantId, submissionId: input.submissionId, expectedVersion: input.expectedVersion,
      allowed: ['provider_confirmed'], to: 'confirmed', kind: 'chain_transfer_confirmed',
      assignment: 'transaction_hash = $5, block_hash = $6, block_number = $7, log_index = $8, confirmed_at = $9, failure_code = NULL',
      values: [input.transactionHash.toLowerCase(), input.blockHash.toLowerCase(), input.blockNumber, input.logIndex,
        new Date(input.confirmedAt).toISOString()],
      claim: input.claim,
      validateCurrent: (current) => {
        if (current.transactionHash?.toLowerCase() !== input.transactionHash.toLowerCase()) {
          throw new TenantWalletExecutionConflictError('Tenant wallet execution chain evidence conflicts');
        }
      },
    });
  }

  async markExecutionApplicationSettled(
    tenantId: string,
    submissionId: string,
    expectedVersion: number,
    settledAt: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ): Promise<TenantWalletExecutionSubmission> {
    if (!Number.isFinite(Date.parse(settledAt))) throw new Error('Tenant wallet application settlement time is invalid');
    return this.transitionExecution({
      tenantId, submissionId, expectedVersion, allowed: ['confirmed'], to: 'confirmed',
      kind: 'application_settlement_applied', assignment: 'application_settled_at = $5',
      values: [new Date(settledAt).toISOString()],
      claim,
      validateCurrent: (current) => current.applicationSettledAt !== null,
    });
  }

  private validateExecutionReconciliationClaim(
    claim: TenantWalletExecutionReconciliationClaim,
    operation: string,
  ): void {
    if (!isCanonicalTenantId(claim.tenantId) || !validIdentifier(claim.submissionId) ||
      !validIdentifier(claim.workerId, 128) || claim.workerId.length < 8 ||
      !Number.isSafeInteger(claim.fenceToken) || claim.fenceToken < 1 ||
      !Number.isFinite(Date.parse(claim.lockedUntil))) {
      throw new Error(`Tenant wallet reconciliation ${operation} is invalid`);
    }
  }

  private async transitionExecution(input: {
    tenantId: string;
    submissionId: string;
    expectedVersion: number;
    allowed: TenantWalletExecutionStatus[];
    to: TenantWalletExecutionStatus;
    kind: string;
    detail?: string;
    assignment: string;
    values: readonly unknown[];
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
    validateCurrent?: (current: TenantWalletExecutionSubmission) => boolean | void;
  }): Promise<TenantWalletExecutionSubmission> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.submissionId) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('Tenant wallet execution transition is invalid');
    }
    if (input.claim) {
      this.validateExecutionReconciliationClaim(input.claim, 'transition claim');
      if (input.claim.tenantId !== input.tenantId || input.claim.submissionId !== input.submissionId) {
        throw new Error('Tenant wallet reconciliation transition claim is invalid');
      }
    }
    return this.withRole('meowwa_wallet_provisioner', input.tenantId, async (client) => {
      const claimPredicate = input.claim
        ? ` AND reconcile_locked_by = $3 AND reconcile_fence_token = $4
            AND reconcile_locked_until > clock_timestamp()`
        : '';
      const currentRows = await client.query<WalletExecutionRow>(
        `SELECT ${walletExecutionColumns}
         FROM meowwa_wallet_execution_submissions
         WHERE tenant_id = $1 AND submission_id = $2${claimPredicate}
         FOR UPDATE`,
        input.claim
          ? [input.tenantId, input.submissionId, input.claim.workerId, input.claim.fenceToken]
          : [input.tenantId, input.submissionId],
      );
      if (currentRows.rows.length !== 1) {
        throw new TenantWalletExecutionConflictError(input.claim
          ? 'Tenant wallet execution reconciliation claim is stale'
          : 'Tenant wallet execution was not found');
      }
      const current = mapWalletExecution(currentRows.rows[0]!, input.tenantId);
      if (current.version !== input.expectedVersion || !input.allowed.includes(current.status)) {
        throw new TenantWalletExecutionConflictError('Tenant wallet execution transition lost a race');
      }
      if (input.validateCurrent?.(current) === true) return current;
      const updateValues: unknown[] = [
        input.tenantId, input.submissionId, input.to, input.expectedVersion, ...input.values,
      ];
      let updateClaimPredicate = '';
      if (input.claim) {
        const workerParameter = updateValues.length + 1;
        const fenceParameter = workerParameter + 1;
        updateClaimPredicate = ` AND reconcile_locked_by = $${workerParameter}
          AND reconcile_fence_token = $${fenceParameter}
          AND reconcile_locked_until > clock_timestamp()`;
        updateValues.push(input.claim.workerId, input.claim.fenceToken);
      }
      const updated = await client.query<WalletExecutionRow>(
        `UPDATE meowwa_wallet_execution_submissions
         SET status = $3, ${input.assignment}, updated_at = transaction_timestamp(), version = version + 1
         WHERE tenant_id = $1 AND submission_id = $2 AND version = $4${updateClaimPredicate}
         RETURNING ${walletExecutionColumns}`,
        updateValues,
      );
      if (updated.rows.length !== 1) throw new TenantWalletExecutionConflictError('Tenant wallet execution transition lost a race');
      const next = mapWalletExecution(updated.rows[0]!, input.tenantId);
      await this.insertExecutionEvent(
        client, input.tenantId, input.submissionId, next.version, input.kind, current.status, input.to, input.detail ?? null,
      );
      return next;
    }, { serializable: true });
  }

  private async insertExecutionEvent(
    client: PgClientLike,
    tenantId: string,
    submissionId: string,
    version: number,
    kind: string,
    fromStatus: TenantWalletExecutionStatus | null,
    toStatus: TenantWalletExecutionStatus,
    detail: string | null,
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO meowwa_wallet_execution_events (
         tenant_id, submission_id, version, kind, from_status, to_status, detail
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, submissionId, version, kind, fromStatus, toStatus, detail],
    );
    if (inserted.rowCount !== 1) throw new Error('Tenant wallet execution event was not recorded');
  }
}

export class PostgresFinancialWorkerRepository extends TenantRoleRepository {
  /**
   * The durable response to a detected chain reorganization -- or, on a finalized-only reader such
   * as Solana's, a checkpoint whose blockhash the chain no longer reports. One halt row per
   * divergence (deduplicated on the checkpoint identity, so the poll loop re-detecting the same
   * halt cannot multiply it), and every canonical event of THAT chain at or beyond the divergent
   * block (slot, on Solana) is marked reorged in the same transaction -- the fail-closed direction
   * the worker's policy permits. The reservation and balance queries subtract reorged credits, so
   * funds the chain no longer backs stop being spendable the moment this commits. Scoped by chain:
   * one rail's divergence must not freeze the other's settled money. Putting events back on the
   * canonical chain is an operator decision made through the migration authority
   * (docs/runbooks/BASE_REORG.md), never this role.
   */
  async recordChainReorgHalt(input: {
    chainKey: FundingChainKey;
    blockNumber: number;
    blockHash: string;
  }): Promise<{ recorded: boolean; reorgedEvents: number }> {
    const chain = requireFundingChain(input.chainKey, 'Chain reorg checkpoint is invalid');
    if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 ||
      !isChainBlockHash(chain, input.blockHash)) {
      throw new Error('Chain reorg checkpoint is invalid');
    }
    const blockHash = canonicalChainBlockHash(chain.key, input.blockHash);
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      // Dedup scopes to OPEN halts only: a resolved row must never silently absorb a fresh
      // detection of the same divergence, or resolving without fixing masks a live halt.
      const inserted = await client.query(
        `INSERT INTO meowwa_chain_reorg_halts (chain_key, chain_id, checkpoint_block_number, checkpoint_block_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chain_key, checkpoint_block_number, checkpoint_block_hash)
           WHERE resolved_at IS NULL DO NOTHING`,
        [chain.key, evmChainId(chain), input.blockNumber, blockHash],
      );
      const flipped = await client.query(
        `UPDATE meowwa_wallet_chain_events
         SET canonical_status = 'reorged', reorged_at = transaction_timestamp()
         WHERE chain_key = $1 AND block_number >= $2 AND canonical_status = 'canonical'`,
        [chain.key, input.blockNumber],
      );
      return { recorded: inserted.rowCount === 1, reorgedEvents: flipped.rowCount ?? 0 };
    }, { serializable: true });
  }

  /** The Base rail's halt, for callers that predate the second rail. */
  async recordBaseReorgHalt(input: { blockNumber: number; blockHash: string }): Promise<{ recorded: boolean; reorgedEvents: number }> {
    return this.recordChainReorgHalt({ chainKey: 'base', ...input });
  }

  /**
   * The funding rail a wallet is attested to, for the worker paths that are handed a wallet id and
   * no chain. A wallet with no production attestation has no rail to reconcile against, which is
   * an error here rather than a default: guessing Base for a Solana wallet would compare its ledger
   * against the wrong chain's events.
   */
  private async fundingChainOfWallet(client: PgClientLike, tenantId: string, walletId: string): Promise<FundingChainDescriptor> {
    const result = await client.query<{ funding_chain_key: string | null; funding_chain_id: number | string | null }>(
      `SELECT funding_chain_key, funding_chain_id
       FROM meowwa_pet_wallet_bindings
       WHERE tenant_id = $1 AND wallet_id = $2`,
      [tenantId, walletId],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || (row.funding_chain_key == null && row.funding_chain_id == null)) {
      throw new Error('Tenant wallet funding chain is unknown');
    }
    return fundingChainOfRow(row.funding_chain_key, row.funding_chain_id, 'Tenant wallet funding chain is unknown');
  }

  /**
   * Independent comparison of what each source of truth says a wallet holds. The ledger, the
   * canonical chain events, the reorged credits, and the in-flight withdrawals are summed
   * separately -- none derived from another -- and `consistent` asserts the one invariant that
   * must always hold: the ledger equals canonical chain flow, because every ledger entry is
   * written in the same transaction as its chain event. Reorged credits explain why a reported
   * balance is lower than the ledger; in-flight withdrawals explain reservations. A false verdict
   * is a financial incident, not a display problem.
   */
  async reconcileWalletLedger(
    tenantId: string,
    walletId: string,
    chainKey?: FundingChainKey,
  ): Promise<TenantLedgerReconciliation> {
    if (!isCanonicalTenantId(tenantId)) throw new Error('Canonical tenant ID is required');
    if (!validIdentifier(walletId)) throw new Error('Tenant wallet reference is invalid');
    const requested = chainKey === undefined ? undefined : requireFundingChain(chainKey, 'Tenant wallet chain is invalid');
    return this.withRole('meowwa_financial_worker', tenantId, async (client) => {
      const chain = requested ?? await this.fundingChainOfWallet(client, tenantId, walletId);
      const result = await client.query<{
        ledger_atomic: string; canonical_chain_atomic: string;
        reorged_credit_atomic: string; reorged_debit_atomic: string;
        inflight_withdrawal_atomic: string;
      }>(
        `SELECT
           COALESCE((
             SELECT SUM(CASE direction WHEN 'credit' THEN amount_atomic ELSE -amount_atomic END)
             FROM meowwa_wallet_ledger_entries
             WHERE tenant_id = $1 AND wallet_id = $2
           ), 0)::text AS ledger_atomic,
           COALESCE((
             SELECT SUM(CASE direction WHEN 'credit' THEN amount_atomic ELSE -amount_atomic END)
             FROM meowwa_wallet_chain_events
             WHERE tenant_id = $1 AND wallet_id = $2 AND chain_key = $3
               AND canonical_status = 'canonical'
           ), 0)::text AS canonical_chain_atomic,
           COALESCE((
             SELECT SUM(amount_atomic)
             FROM meowwa_wallet_chain_events
             WHERE tenant_id = $1 AND wallet_id = $2 AND chain_key = $3
               AND direction = 'credit' AND canonical_status = 'reorged'
           ), 0)::text AS reorged_credit_atomic,
           COALESCE((
             SELECT SUM(amount_atomic)
             FROM meowwa_wallet_chain_events
             WHERE tenant_id = $1 AND wallet_id = $2 AND chain_key = $3
               AND direction = 'debit' AND canonical_status = 'reorged'
           ), 0)::text AS reorged_debit_atomic,
           -- The same predicate the balance is net of. This used to be a fourth hand-copy
           -- (transaction_hash IS NULL, no never-landed term, no chain-debit term), so the one
           -- durable record an operator reads during a money incident reported 0 for a broadcast
           -- intent genuinely holding the owner's funds -- contradicting the balance it exists to
           -- explain. It moves no money and the consistency verdict does not depend on it.
           ${inFlightWithdrawalReservation}::text AS inflight_withdrawal_atomic`,
        [tenantId, walletId, chain.key],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row ||
        ![row.ledger_atomic, row.canonical_chain_atomic, row.reorged_credit_atomic,
          row.reorged_debit_atomic, row.inflight_withdrawal_atomic]
          .every((value) => typeof value === 'string' && /^-?[0-9]+$/.test(value))) {
        throw new Error('Tenant wallet reconciliation is invalid');
      }
      // The ledger records every chain event exactly once and reorged entries deliberately
      // remain as the audit trail of the correction, so the identity nets both directions:
      // a reorged credit left a +amount entry the canonical sum no longer carries, and a
      // reorged debit left a -amount entry the canonical sum no longer carries. Without the
      // debit term, flipping a debit event to reorged broke `consistent` with no explaining sum.
      const consistent = BigInt(row.ledger_atomic) ===
        BigInt(row.canonical_chain_atomic) + BigInt(row.reorged_credit_atomic) -
        BigInt(row.reorged_debit_atomic);
      return {
        tenantId, walletId, chainKey: chain.key,
        ledgerAtomic: row.ledger_atomic,
        canonicalChainAtomic: row.canonical_chain_atomic,
        reorgedCreditAtomic: row.reorged_credit_atomic,
        reorgedDebitAtomic: row.reorged_debit_atomic,
        inFlightWithdrawalAtomic: row.inflight_withdrawal_atomic,
        consistent,
      };
    }, { readOnly: true });
  }

  /**
   * The canonical chain net up to and including a block, for comparison against the on-chain
   * balance read at that same block. Bounding both sides to one height is what makes the
   * comparison exact instead of racy: the caller only compares when the scan cursor has already
   * indexed past the height, so neither side can be missing events the other has.
   */
  async canonicalChainNetAtBlock(
    tenantId: string,
    walletId: string,
    blockNumber: number,
    chainKey?: FundingChainKey,
  ): Promise<string> {
    if (!isCanonicalTenantId(tenantId)) throw new Error('Canonical tenant ID is required');
    if (!validIdentifier(walletId)) throw new Error('Tenant wallet reference is invalid');
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('Comparison block is invalid');
    const requested = chainKey === undefined ? undefined : requireFundingChain(chainKey, 'Tenant wallet chain is invalid');
    return this.withRole('meowwa_financial_worker', tenantId, async (client) => {
      const chain = requested ?? await this.fundingChainOfWallet(client, tenantId, walletId);
      const result = await client.query<{ net_atomic: string }>(
        `SELECT COALESCE((
           SELECT SUM(CASE direction WHEN 'credit' THEN amount_atomic ELSE -amount_atomic END)
           FROM meowwa_wallet_chain_events
           WHERE tenant_id = $1 AND wallet_id = $2 AND chain_key = $4
             AND canonical_status = 'canonical' AND block_number <= $3
         ), 0)::text AS net_atomic`,
        [tenantId, walletId, blockNumber, chain.key],
      );
      const value = result.rows[0]?.net_atomic;
      if (result.rows.length !== 1 || typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) {
        throw new Error('Tenant wallet chain net is invalid');
      }
      return value;
    }, { readOnly: true });
  }

  /**
   * Appends a durable discrepancy record. Idempotent per open (tenant, wallet, kind): the sweep
   * re-detecting the same mismatch every pass cannot multiply the record, and resolving one
   * (an operator action through the migration authority) re-arms detection for that wallet.
   */
  async recordLedgerDiscrepancy(input: {
    tenantId: string; walletId: string; chainKey: FundingChainKey; kind: 'internal_mismatch' | 'onchain_mismatch';
    ledgerAtomic: string; canonicalChainAtomic: string; reorgedCreditAtomic: string;
    reorgedDebitAtomic: string; inFlightWithdrawalAtomic: string;
    chainBalanceAtomic?: string; comparisonBlockNumber?: number;
  }): Promise<{ recorded: boolean }> {
    if (!isCanonicalTenantId(input.tenantId)) throw new Error('Canonical tenant ID is required');
    if (!validIdentifier(input.walletId)) throw new Error('Tenant wallet reference is invalid');
    const chain = requireFundingChain(input.chainKey, 'Ledger discrepancy record is invalid');
    const sums = [input.ledgerAtomic, input.canonicalChainAtomic, input.reorgedCreditAtomic,
      input.reorgedDebitAtomic, input.inFlightWithdrawalAtomic];
    if (!sums.every((value) => /^-?[0-9]+$/.test(value)) ||
      (input.kind === 'onchain_mismatch') !==
        (typeof input.chainBalanceAtomic === 'string' && Number.isSafeInteger(input.comparisonBlockNumber)) ||
      (input.chainBalanceAtomic !== undefined && !/^-?[0-9]+$/.test(input.chainBalanceAtomic))) {
      throw new Error('Ledger discrepancy record is invalid');
    }
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO meowwa_ledger_discrepancies (
           tenant_id, wallet_id, chain_key, kind, ledger_atomic, canonical_chain_atomic,
           reorged_credit_atomic, reorged_debit_atomic, in_flight_withdrawal_atomic,
           chain_balance_atomic, comparison_block_number
         ) VALUES ($1, $2, $11, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, wallet_id, kind) WHERE resolved_at IS NULL DO NOTHING`,
        [input.tenantId, input.walletId, input.kind, input.ledgerAtomic, input.canonicalChainAtomic,
          input.reorgedCreditAtomic, input.reorgedDebitAtomic, input.inFlightWithdrawalAtomic,
          input.chainBalanceAtomic ?? null, input.comparisonBlockNumber ?? null, chain.key],
      );
      return { recorded: inserted.rowCount === 1 };
    });
  }

  async openLedgerDiscrepancyCount(): Promise<number> {
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const result = await client.query<{ open_count: number | string }>(
        'SELECT count(*) AS open_count FROM meowwa_ledger_discrepancies WHERE resolved_at IS NULL',
      );
      const count = Number(result.rows[0]?.open_count);
      if (result.rows.length !== 1 || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('Ledger discrepancy count is invalid');
      }
      return count;
    }, { readOnly: true });
  }

  async listOpenLedgerDiscrepancies(limit: number): Promise<Array<{
    tenantId: string; walletId: string; chainKey: FundingChainKey; kind: string; detectedAt: string;
    ledgerAtomic: string; canonicalChainAtomic: string; reorgedCreditAtomic: string;
    reorgedDebitAtomic: string; inFlightWithdrawalAtomic: string;
    chainBalanceAtomic: string | null; comparisonBlockNumber: number | null;
  }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Ledger discrepancy page limit is invalid');
    }
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const result = await client.query<{
        tenant_id: string; wallet_id: string; chain_key: string; kind: string; detected_at: Date | string;
        ledger_atomic: string; canonical_chain_atomic: string; reorged_credit_atomic: string;
        reorged_debit_atomic: string; in_flight_withdrawal_atomic: string;
        chain_balance_atomic: string | null; comparison_block_number: number | string | null;
      }>(
        `SELECT tenant_id::text, wallet_id, chain_key, kind, detected_at,
                ledger_atomic::text, canonical_chain_atomic::text, reorged_credit_atomic::text,
                reorged_debit_atomic::text, in_flight_withdrawal_atomic::text,
                chain_balance_atomic::text, comparison_block_number
         FROM meowwa_ledger_discrepancies
         WHERE resolved_at IS NULL
         ORDER BY detected_at
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        tenantId: row.tenant_id,
        walletId: row.wallet_id,
        chainKey: requireFundingChain(row.chain_key, 'Ledger discrepancy row is invalid').key,
        kind: row.kind,
        detectedAt: canonicalTimestamp(row.detected_at),
        ledgerAtomic: row.ledger_atomic,
        canonicalChainAtomic: row.canonical_chain_atomic,
        reorgedCreditAtomic: row.reorged_credit_atomic,
        reorgedDebitAtomic: row.reorged_debit_atomic,
        inFlightWithdrawalAtomic: row.in_flight_withdrawal_atomic,
        chainBalanceAtomic: row.chain_balance_atomic,
        comparisonBlockNumber: row.comparison_block_number === null ? null : Number(row.comparison_block_number),
      }));
    }, { readOnly: true });
  }

  /**
   * The oldest unresolved halt on one rail, or -- with no rail named -- on any rail. The any-chain
   * reading is the fail-closed one for a caller that gates all settlement on "is anything halted".
   */
  async unresolvedChainHalt(chainKey?: FundingChainKey): Promise<
    { chainKey: FundingChainKey; checkpointBlockNumber: number; checkpointBlockHash: string; detectedAt: string } | undefined
  > {
    const chain = chainKey === undefined ? undefined : requireFundingChain(chainKey, 'Chain halt lookup is invalid');
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const result = await client.query<{
        chain_key: string; checkpoint_block_number: number | string; checkpoint_block_hash: string; detected_at: Date | string;
      }>(
        chain === undefined
          ? `SELECT chain_key, checkpoint_block_number, checkpoint_block_hash, detected_at
             FROM meowwa_chain_reorg_halts
             WHERE resolved_at IS NULL
             ORDER BY detected_at
             LIMIT 1`
          : `SELECT chain_key, checkpoint_block_number, checkpoint_block_hash, detected_at
             FROM meowwa_chain_reorg_halts
             WHERE chain_key = $1 AND resolved_at IS NULL
             ORDER BY detected_at
             LIMIT 1`,
        chain === undefined ? [] : [chain.key],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        chainKey: requireFundingChain(row.chain_key, 'Chain halt row is invalid').key,
        checkpointBlockNumber: Number(row.checkpoint_block_number),
        checkpointBlockHash: row.checkpoint_block_hash,
        detectedAt: canonicalTimestamp(row.detected_at),
      };
    }, { readOnly: true });
  }

  /** Any-chain halt lookup, for callers that predate the second rail. */
  async unresolvedBaseReorgHalt(): Promise<
    { chainKey: FundingChainKey; checkpointBlockNumber: number; checkpointBlockHash: string; detectedAt: string } | undefined
  > {
    return this.unresolvedChainHalt();
  }

  async ready(): Promise<boolean> {
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const result = await client.query<{ ready: number }>('SELECT 1 AS ready');
      return result.rows.length === 1 && Number(result.rows[0]?.ready) === 1;
    }, { readOnly: true });
  }

  async resolveFundingTenant(fundingId: string): Promise<string | undefined> {
    if (!validIdentifier(fundingId)) throw new Error('Funding reference is invalid');
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const result = await client.query<{ tenant_id: string | null }>(
        'SELECT meowwa_resolve_funding_tenant($1)::text AS tenant_id',
        [fundingId],
      );
      if (result.rows.length !== 1) throw new Error('Funding tenant resolution is invalid');
      const tenantId = result.rows[0]?.tenant_id;
      if (tenantId === null || tenantId === undefined) return undefined;
      if (!isCanonicalTenantId(tenantId)) throw new Error('Funding tenant resolution is invalid');
      return tenantId;
    }, { readOnly: true });
  }

  async resolveWalletTenant(chainKey: FundingChainKey, walletAddress: string): Promise<string | undefined> {
    const chain = requireFundingChain(chainKey, 'Wallet tenant network is invalid');
    const address = canonicalChainAddress(chain.key, walletAddress);
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const result = await client.query<{ tenant_id: string | null }>(
        'SELECT meowwa_resolve_wallet_tenant($1::text, $2::text)::text AS tenant_id',
        [chain.key, address],
      );
      if (result.rows.length !== 1) throw new Error('Wallet tenant resolution is invalid');
      const tenantId = result.rows[0]?.tenant_id;
      if (tenantId === null || tenantId === undefined) return undefined;
      if (!isCanonicalTenantId(tenantId)) throw new Error('Wallet tenant resolution is invalid');
      return tenantId;
    }, { readOnly: true });
  }

  /**
   * One page of the production wallet set on a rail, strictly ascending. The SQL function orders
   * by `COLLATE "C"` (bytewise), which is what the JS code-unit comparison below checks: for
   * lowercase hex the two orders were trivially the same, but mixed-case base58 sorts differently
   * under a locale collation, and a page that disagrees with the cursor would skip wallets.
   */
  async listActiveWalletAddressesPage(chainKey: FundingChainKey, afterAddress: string | null, limit: number): Promise<string[]> {
    const chain = requireFundingChain(chainKey, 'Active wallet address page chain is invalid');
    const after = afterAddress === null ? null : canonicalChainAddress(chain.key, afterAddress);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Active wallet address page limit is invalid');
    }
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const result = await client.query<{ wallet_address: string }>(
        `SELECT wallet_address::text
         FROM meowwa_list_active_wallet_addresses($1::text, $2::text, $3::integer)`,
        [chain.key, after, limit],
      );
      if (result.rows.length > limit) throw new Error('Active wallet address page is invalid');
      let previous = after ?? '';
      return result.rows.map((row) => {
        const address = canonicalChainAddress(chain.key, row.wallet_address);
        if (address <= previous) throw new Error('Active wallet address page is not strictly ordered');
        previous = address;
        return address;
      });
    }, { readOnly: true });
  }

  async getWalletForWorker(tenantId: string, chainKey: FundingChainKey, walletAddress: string): Promise<TenantWalletBinding | undefined> {
    if (!isCanonicalTenantId(tenantId)) throw new Error('Financial worker tenant is invalid');
    const chain = requireFundingChain(chainKey, 'Financial worker wallet chain is invalid');
    const address = canonicalChainAddress(chain.key, walletAddress);
    return this.withRole('meowwa_financial_worker', tenantId, async (client) => {
      const result = await client.query<WalletRow>(
        `SELECT ${walletBindingColumns}
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND chain_key = $2 AND funding_chain_key = $3
           AND funding_environment = 'production' AND custody_classification = 'owner_controlled'
           AND funding_verified_at IS NOT NULL AND smart_wallet_address = $4
           AND status IN ('active', 'provisioning')`,
        [tenantId, controlChainFor(chain.key), chain.key, address],
      );
      if (result.rows.length > 1) throw new Error('Financial worker wallet binding is invalid');
      return result.rows[0] ? mapWallet(result.rows[0], tenantId) : undefined;
    }, { readOnly: true });
  }

  async findAwaitingFundingByTransactionHash(
    tenantId: string,
    walletId: string,
    chainKey: FundingChainKey,
    transactionHashValue: string,
  ): Promise<TenantFundingTransaction | undefined> {
    if (!isCanonicalTenantId(tenantId) || !validIdentifier(walletId)) {
      throw new Error('Awaiting funding reference is invalid');
    }
    const chain = requireFundingChain(chainKey, 'Awaiting funding reference is invalid');
    const transactionHash = canonicalChainTransactionId(chain.key, transactionHashValue);
    return this.withRole('meowwa_financial_worker', tenantId, async (client) => {
      const result = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND wallet_id = $2 AND chain_key = $4 AND transaction_hash = $3
           AND rail = 'stripe_onramp' AND status = 'pending'
           AND reconciliation_status IN ('awaiting_chain', 'chargeback_review')`,
        [tenantId, walletId, transactionHash, chain.key],
      );
      if (result.rows.length > 1) throw new Error('Multiple funding records claim the same chain transfer');
      return result.rows[0] ? mapFunding(result.rows[0]) : undefined;
    }, { readOnly: true });
  }

  /**
   * The scan cursor for one asset on one rail. `block_number`, `next_block` and the checkpoint's
   * block hash keep their names on Solana, where they are the slot and the blockhash.
   */
  async getChainScanCursor(input: {
    chainKey: FundingChainKey;
    contractAddress: string;
    scanStartBlock: number;
  }): Promise<{
    nextBlock: number;
    walletSetRevision: number;
    checkpoint: { blockNumber: number; blockHash: string } | null;
  }> {
    const chain = requireFundingChain(input.chainKey, 'Tenant chain scan cursor request is invalid');
    if (!Number.isSafeInteger(input.scanStartBlock) || input.scanStartBlock < 0) {
      throw new Error('Tenant chain scan cursor request is invalid');
    }
    const contractAddress = canonicalChainAddress(chain.key, input.contractAddress);
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      await client.query(
        `INSERT INTO meowwa_chain_scan_cursors (chain_key, chain_id, contract_address, next_block)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [chain.key, evmChainId(chain), contractAddress, input.scanStartBlock],
      );
      const result = await client.query<{
        next_block: number | string;
        wallet_set_revision: number | string;
        block_number: number | string | null;
        block_hash: string | null;
      }>(
        `SELECT cursor.next_block, wallet_set.revision AS wallet_set_revision,
                checkpoint.block_number, checkpoint.block_hash::text
         FROM meowwa_chain_scan_cursors AS cursor
         CROSS JOIN meowwa_wallet_set_revision AS wallet_set
         LEFT JOIN LATERAL (
           SELECT block_number, block_hash
           FROM meowwa_chain_scan_checkpoints
           WHERE chain_key = cursor.chain_key AND contract_address = cursor.contract_address
           ORDER BY block_number DESC
           LIMIT 1
         ) AS checkpoint ON true
         WHERE cursor.chain_key = $1 AND cursor.contract_address = $2 AND wallet_set.singleton = true`,
        [chain.key, contractAddress],
      );
      if (result.rows.length !== 1) throw new Error('Tenant chain scan cursor is invalid');
      const row = result.rows[0]!;
      const nextBlock = safeNonNegativeInteger(row.next_block, 'chain scan cursor');
      const walletSetRevision = safeNonNegativeInteger(row.wallet_set_revision, 'wallet set revision');
      if (walletSetRevision < 1) throw new Error('Tenant wallet set revision is invalid');
      if (row.block_number === null && row.block_hash === null) return { nextBlock, walletSetRevision, checkpoint: null };
      if (row.block_number === null || row.block_hash === null) throw new Error('Tenant chain scan checkpoint is invalid');
      return {
        nextBlock,
        walletSetRevision,
        checkpoint: {
          blockNumber: safeNonNegativeInteger(row.block_number, 'chain checkpoint block'),
          blockHash: canonicalChainBlockHash(chain.key, row.block_hash),
        },
      };
    }, { serializable: true });
  }

  async advanceChainScanCursor(input: {
    chainKey: FundingChainKey;
    contractAddress: string;
    expectedNextBlock: number;
    nextBlock: number;
    checkpointBlock: number;
    checkpointHash: string;
    expectedWalletSetRevision: number;
  }): Promise<boolean> {
    const chain = requireFundingChain(input.chainKey, 'Tenant chain scan cursor advance is invalid');
    if (!Number.isSafeInteger(input.expectedNextBlock) || input.expectedNextBlock < 0 ||
      !Number.isSafeInteger(input.nextBlock) || !Number.isSafeInteger(input.checkpointBlock) ||
      !Number.isSafeInteger(input.expectedWalletSetRevision) || input.expectedWalletSetRevision < 1 ||
      input.nextBlock !== input.checkpointBlock + 1 || input.nextBlock <= input.expectedNextBlock) {
      throw new Error('Tenant chain scan cursor advance is invalid');
    }
    const contractAddress = canonicalChainAddress(chain.key, input.contractAddress);
    const checkpointHash = canonicalChainBlockHash(chain.key, input.checkpointHash);
    return this.withRole('meowwa_financial_worker', undefined, async (client) => {
      const locked = await client.query<{ next_block: number | string }>(
        `SELECT next_block
         FROM meowwa_chain_scan_cursors
         WHERE chain_key = $1 AND contract_address = $2
         FOR UPDATE`,
        [chain.key, contractAddress],
      );
      if (locked.rows.length !== 1) throw new Error('Tenant chain scan cursor was not initialized');
      if (safeNonNegativeInteger(locked.rows[0]!.next_block, 'chain scan cursor') !== input.expectedNextBlock) return false;
      const walletSet = await client.query<{ revision: number | string }>(
        `SELECT revision FROM meowwa_wallet_set_revision WHERE singleton = true`,
      );
      if (walletSet.rows.length !== 1) throw new Error('Tenant wallet set revision is invalid');
      if (safeNonNegativeInteger(walletSet.rows[0]!.revision, 'wallet set revision') !== input.expectedWalletSetRevision) return false;
      const checkpoint = await client.query(
        `INSERT INTO meowwa_chain_scan_checkpoints (
           chain_key, chain_id, contract_address, block_number, block_hash
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [chain.key, evmChainId(chain), contractAddress, input.checkpointBlock, checkpointHash],
      );
      if (checkpoint.rowCount === 0) {
        const existing = await client.query<{ block_hash: string }>(
          `SELECT block_hash::text
           FROM meowwa_chain_scan_checkpoints
           WHERE chain_key = $1 AND contract_address = $2 AND block_number = $3`,
          [chain.key, contractAddress, input.checkpointBlock],
        );
        if (existing.rows.length !== 1 || canonicalChainBlockHash(chain.key, existing.rows[0]!.block_hash) !== checkpointHash) {
          throw new Error('Tenant chain checkpoint conflicts with stored evidence');
        }
      } else if (checkpoint.rowCount !== 1) {
        throw new Error('Tenant chain checkpoint is invalid');
      }
      const updated = await client.query<{ next_block: number | string }>(
        `UPDATE meowwa_chain_scan_cursors
         SET next_block = $3, updated_at = transaction_timestamp()
         WHERE chain_key = $1 AND contract_address = $2 AND next_block = $4
         RETURNING next_block`,
        [chain.key, contractAddress, input.nextBlock, input.expectedNextBlock],
      );
      if (updated.rows.length !== 1 || safeNonNegativeInteger(updated.rows[0]!.next_block, 'chain scan cursor') !== input.nextBlock) {
        throw new Error('Tenant chain scan cursor was not advanced');
      }
      return true;
    }, { serializable: true });
  }

  async getFundingForWorker(tenantId: string, fundingId: string): Promise<TenantFundingTransaction | undefined> {
    if (!isCanonicalTenantId(tenantId) || !validIdentifier(fundingId)) {
      throw new Error('Financial worker funding reference is invalid');
    }
    return this.withRole('meowwa_financial_worker', tenantId, async (client) => {
      const result = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND funding_id = $2`,
        [tenantId, fundingId],
      );
      if (result.rows.length > 1) throw new Error('Financial worker funding row is invalid');
      return result.rows[0] ? mapFunding(result.rows[0]) : undefined;
    }, { readOnly: true });
  }

  async markOnrampAwaitingChain(input: {
    tenantId: string;
    fundingId: string;
    providerSessionId: string;
    transactionHash: string;
    destinationAmountAtomic: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.fundingId) ||
      !validIdentifier(input.providerSessionId) || !isAtomicAmount(input.destinationAmountAtomic) ||
      parseAtomicAmount(input.destinationAmountAtomic) <= 0n || !validIdentifier(input.transactionHash)) {
      throw new Error('Tenant Onramp fulfillment is invalid');
    }
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const locked = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND funding_id = $2
         FOR UPDATE`,
        [input.tenantId, input.fundingId],
      );
      if (locked.rows.length !== 1) throw new Error('Tenant Onramp fulfillment target was not found');
      const prior = mapFunding(locked.rows[0]!);
      if (prior.rail !== 'stripe_onramp' || prior.providerSessionId !== input.providerSessionId) {
        throw new Error('Tenant Onramp fulfillment session does not match');
      }
      // Stripe reports the destination hash in the rail's own form (an EVM hash for Base, a base58
      // signature for Solana), so it is validated against the funding row's chain, not a shape.
      if (!isChainTransactionId(CHAINS[prior.chainKey], input.transactionHash)) {
        throw new Error('Tenant Onramp fulfillment is invalid');
      }
      const transactionHash = canonicalChainTransactionId(prior.chainKey, input.transactionHash);
      const exactEvidence = prior.transactionHash === transactionHash &&
        prior.destinationAmountAtomic === input.destinationAmountAtomic;
      const conflictEvidence =
        `stored_tx=${prior.transactionHash ?? 'none'};` +
        `stored_amount=${prior.destinationAmountAtomic ?? 'none'};` +
        `observed_tx=${transactionHash};` +
        `observed_amount=${input.destinationAmountAtomic}`;
      const terminalConflictEvidence =
        `stored_status=${prior.status};stored_reconciliation=${prior.reconciliationStatus};` +
        `stored_failure=${prior.failureCode ?? 'none'};` +
        `observed_status=fulfillment_complete;observed_tx=${transactionHash};` +
        `observed_amount=${input.destinationAmountAtomic}`;
      if (prior.status === 'settled' || prior.status === 'refunded') {
        if (!exactEvidence) {
          throw new TenantOnrampEvidenceConflictError('provider_fulfillment_conflict', conflictEvidence);
        }
        return { transaction: prior, applied: false };
      }
      if (prior.status === 'failed') {
        throw new TenantOnrampEvidenceConflictError('provider_terminal_state_conflict', terminalConflictEvidence);
      }
      if (prior.status !== 'pending') throw new Error('Tenant Onramp funding is not awaiting fulfillment');
      if ((prior.transactionHash !== null && prior.transactionHash !== transactionHash) ||
        (prior.destinationAmountAtomic !== null && prior.destinationAmountAtomic !== input.destinationAmountAtomic)) {
        throw new TenantOnrampEvidenceConflictError('provider_fulfillment_conflict', conflictEvidence);
      }
      if (prior.reconciliationStatus === 'awaiting_chain' && exactEvidence) {
        return { transaction: prior, applied: false };
      }
      if (prior.reconciliationStatus === 'chargeback_review' && exactEvidence) {
        return { transaction: prior, applied: false };
      }
      if (prior.reconciliationStatus === 'manual_review' && exactEvidence) {
        return { transaction: prior, applied: false };
      }
      if (!['awaiting_provider', 'awaiting_chain', 'chargeback_review'].includes(prior.reconciliationStatus)) {
        throw new TenantOnrampEvidenceConflictError('provider_fulfillment_conflict', conflictEvidence);
      }
      const reconciliationStatus: TenantFundingReconciliation = prior.reconciliationStatus === 'chargeback_review'
        ? 'chargeback_review'
        : 'awaiting_chain';
      const updated = await client.query<FundingRow>(
        `UPDATE meowwa_funding_transactions
         SET reconciliation_status = $6, destination_amount_atomic = $4,
             transaction_hash = $5, failure_code = NULL, updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND funding_id = $2 AND provider_session_id = $3 AND status = 'pending'
           AND reconciliation_status IN ('awaiting_provider', 'awaiting_chain', 'chargeback_review')
         RETURNING ${fundingColumns}`,
        [input.tenantId, input.fundingId, input.providerSessionId, input.destinationAmountAtomic, transactionHash,
          reconciliationStatus],
      );
      if (updated.rows.length !== 1) throw new Error('Tenant Onramp fulfillment was not recorded');
      return { transaction: mapFunding(updated.rows[0]!), applied: true };
    }, { serializable: true });
  }

  async markOnrampFailed(input: {
    tenantId: string;
    fundingId: string;
    providerSessionId: string;
    failureCode: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.fundingId) ||
      !validIdentifier(input.providerSessionId) || !validOperation(input.failureCode)) {
      throw new Error('Tenant Onramp failure is invalid');
    }
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const locked = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND funding_id = $2
         FOR UPDATE`,
        [input.tenantId, input.fundingId],
      );
      if (locked.rows.length !== 1) throw new Error('Tenant Onramp failure target was not found');
      const prior = mapFunding(locked.rows[0]!);
      if (prior.rail !== 'stripe_onramp' || prior.providerSessionId !== input.providerSessionId) {
        throw new Error('Tenant Onramp failure session does not match');
      }
      if (prior.status === 'failed' && prior.reconciliationStatus === 'manual_review' &&
        prior.failureCode === input.failureCode) return { transaction: prior, applied: false };
      if (prior.status !== 'pending' || prior.reconciliationStatus !== 'awaiting_provider' ||
        prior.transactionHash !== null || prior.destinationAmountAtomic !== null) {
        throw new TenantOnrampEvidenceConflictError(
          'provider_terminal_state_conflict',
          `stored_status=${prior.status};stored_reconciliation=${prior.reconciliationStatus};` +
          `stored_tx=${prior.transactionHash ?? 'none'};stored_amount=${prior.destinationAmountAtomic ?? 'none'};` +
          `stored_failure=${prior.failureCode ?? 'none'};` +
          `observed_status=rejected;observed_failure=${input.failureCode}`,
        );
      }
      const updated = await client.query<FundingRow>(
        `UPDATE meowwa_funding_transactions
         SET status = 'failed', reconciliation_status = 'manual_review', failure_code = $4,
             updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND funding_id = $2 AND provider_session_id = $3
           AND status = 'pending' AND reconciliation_status = 'awaiting_provider'
         RETURNING ${fundingColumns}`,
        [input.tenantId, input.fundingId, input.providerSessionId, input.failureCode],
      );
      if (updated.rows.length !== 1) throw new Error('Tenant Onramp failure was not recorded');
      return { transaction: mapFunding(updated.rows[0]!), applied: true };
    }, { serializable: true });
  }

  async recordVerifiedProviderEvent(input: {
    tenantId: string;
    provider: 'stripe';
    eventId: string;
    eventType: string;
    payloadSha256: string;
  }): Promise<'inserted' | 'duplicate'> {
    if (!isCanonicalTenantId(input.tenantId) || input.provider !== 'stripe' || !validIdentifier(input.eventId) ||
      !validIdentifier(input.eventType) || !/^[0-9a-f]{64}$/.test(input.payloadSha256)) {
      throw new Error('Verified provider event is invalid');
    }
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO meowwa_funding_provider_events (
           tenant_id, provider, event_id, event_type, payload_sha256
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [input.tenantId, input.provider, input.eventId, input.eventType, input.payloadSha256],
      );
      if (inserted.rowCount === 1) return 'inserted';
      if (inserted.rowCount !== 0) throw new Error('Verified provider event insert is invalid');
      const prior = await client.query<{ event_type: string; payload_sha256: string }>(
        `SELECT event_type, payload_sha256
         FROM meowwa_funding_provider_events
         WHERE tenant_id = $1 AND provider = $2 AND event_id = $3`,
        [input.tenantId, input.provider, input.eventId],
      );
      const row = prior.rows[0];
      if (prior.rows.length !== 1 || !row || row.event_type !== input.eventType || row.payload_sha256 !== input.payloadSha256) {
        throw new Error('Verified provider event identity conflicts with stored evidence');
      }
      return 'duplicate';
    }, { serializable: true });
  }

  async isVerifiedProviderEventProcessed(input: {
    tenantId: string;
    provider: 'stripe';
    eventId: string;
  }): Promise<boolean> {
    if (!isCanonicalTenantId(input.tenantId) || input.provider !== 'stripe' || !validIdentifier(input.eventId)) {
      throw new Error('Verified provider event lookup is invalid');
    }
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const result = await client.query<{ processed_at: Date | string | null }>(
        `SELECT processed_at
         FROM meowwa_funding_provider_events
         WHERE tenant_id = $1 AND provider = $2 AND event_id = $3`,
        [input.tenantId, input.provider, input.eventId],
      );
      if (result.rows.length > 1) throw new Error('Verified provider event lookup is invalid');
      const processedAt = result.rows[0]?.processed_at;
      if (processedAt === null || processedAt === undefined) return false;
      canonicalTimestamp(processedAt);
      return true;
    }, { readOnly: true });
  }

  async markVerifiedProviderEventProcessed(input: {
    tenantId: string;
    provider: 'stripe';
    eventId: string;
  }): Promise<boolean> {
    if (!isCanonicalTenantId(input.tenantId) || input.provider !== 'stripe' || !validIdentifier(input.eventId)) {
      throw new Error('Verified provider event completion is invalid');
    }
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const processed = await client.query<{ processed_at: Date | string }>(
        `UPDATE meowwa_funding_provider_events
         SET processed_at = transaction_timestamp()
         WHERE tenant_id = $1 AND provider = $2 AND event_id = $3 AND processed_at IS NULL
         RETURNING processed_at`,
        [input.tenantId, input.provider, input.eventId],
      );
      if (processed.rows.length === 1) return true;
      const existing = await client.query<{ processed_at: Date | string | null }>(
        `SELECT processed_at
         FROM meowwa_funding_provider_events
         WHERE tenant_id = $1 AND provider = $2 AND event_id = $3`,
        [input.tenantId, input.provider, input.eventId],
      );
      if (existing.rows.length !== 1 || existing.rows[0]?.processed_at == null) {
        throw new Error('Verified provider event was not recorded');
      }
      canonicalTimestamp(existing.rows[0].processed_at);
      return false;
    }, { serializable: true });
  }

  async recordReconciliation(input: {
    tenantId: string;
    fundingId: string;
    kind: 'refund' | 'chargeback' | 'manual_review' | 'dispute_won' | 'dispute_lost';
    evidenceReference: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.fundingId) ||
      !['refund', 'chargeback', 'manual_review', 'dispute_won', 'dispute_lost'].includes(input.kind) ||
      !validIdentifier(input.evidenceReference, 512)) {
      throw new Error('Tenant funding reconciliation is invalid');
    }
    const digest = createHash('sha256')
      .update(`meowwa:funding-reconciliation:v1\0${input.tenantId}\0${input.fundingId}\0${input.kind}\0${input.evidenceReference}`, 'utf8')
      .digest('hex');
    const reconciliationEventId = `reconciliation_${digest.slice(0, 48)}`;
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const locked = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND funding_id = $2
         FOR UPDATE`,
        [input.tenantId, input.fundingId],
      );
      if (locked.rows.length !== 1) throw new Error('Tenant funding reconciliation target was not found');
      const prior = mapFunding(locked.rows[0]!);
      if (prior.rail !== 'stripe_onramp' || !prior.providerSessionId) {
        throw new Error('Tenant funding reconciliation must reference Stripe Onramp funding');
      }
      if (input.kind === 'refund' && prior.status !== 'settled' && prior.status !== 'refunded') {
        // 'pending' still converges: the chain credit can settle the funding, so keep throwing
        // and let Stripe retry. Any other status never becomes settled, and a plain throw there
        // is never acked — it poisons this tenant's Stripe webhook forever. Surface those as a
        // typed conflict so the processor records durable manual_review evidence instead.
        if (prior.status !== 'pending') {
          throw new TenantOnrampEvidenceConflictError(
            'provider_terminal_state_conflict',
            `stored_status=${prior.status};stored_reconciliation=${prior.reconciliationStatus};observed_kind=refund`,
          );
        }
        throw new Error('Stripe Onramp funding must be settled before refund evidence is accepted');
      }
      const evidence = await client.query(
        `INSERT INTO meowwa_funding_reconciliation_events (
           tenant_id, reconciliation_event_id, funding_id, kind, evidence_reference
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [input.tenantId, reconciliationEventId, input.fundingId, input.kind, input.evidenceReference],
      );
      if (evidence.rowCount === 0) {
        const existing = await client.query<{
          reconciliation_event_id: string;
          funding_id: string;
          kind: string;
          evidence_reference: string;
        }>(
          `SELECT reconciliation_event_id, funding_id, kind, evidence_reference
           FROM meowwa_funding_reconciliation_events
           WHERE tenant_id = $1 AND funding_id = $2 AND kind = $3 AND evidence_reference = $4`,
          [input.tenantId, input.fundingId, input.kind, input.evidenceReference],
        );
        const row = existing.rows[0];
        if (existing.rows.length !== 1 || !row || row.reconciliation_event_id !== reconciliationEventId ||
          row.funding_id !== input.fundingId || row.kind !== input.kind || row.evidence_reference !== input.evidenceReference) {
          throw new Error('Tenant funding reconciliation evidence conflicts');
        }
        return { transaction: prior, applied: false };
      }
      if (evidence.rowCount !== 1) throw new Error('Tenant funding reconciliation evidence is invalid');
      // Deliberately after the duplicate check above. A dispute verdict moves the funding out of
      // chargeback_review, so re-checking the transition on a Stripe redelivery would reject the
      // replay of a verdict this very method already applied, and the processor would park a
      // healthy funding in manual_review. A replay returns above; only a first delivery gets here.
      if (input.kind === 'dispute_won' || input.kind === 'dispute_lost') {
        // A verdict on a funding that was never disputed, or one that never settled, is not a
        // state this can reach honestly — and 'dispute_won' would otherwise be a way to launder
        // any funding into 'confirmed'.
        if (prior.reconciliationStatus !== 'chargeback_review' || prior.status !== 'settled') {
          throw new TenantOnrampEvidenceConflictError(
            'provider_terminal_state_conflict',
            `stored_status=${prior.status};stored_reconciliation=${prior.reconciliationStatus};observed_kind=${input.kind}`,
          );
        }
      }
      const nextStatus: TenantFundingStatus = input.kind === 'refund' ? 'refunded' : prior.status;
      const nextReconciliation: TenantFundingReconciliation = input.kind === 'refund'
        ? 'provider_refunded'
        // A won dispute is the exit: the charge stood, so the funding returns to where it would
        // have been had the dispute never opened. A lost one stays flagged — Stripe is merchant of
        // record and absorbs it, so there is nothing to reverse and nothing to take from the owner.
        : input.kind === 'dispute_won' ? 'confirmed'
        : input.kind === 'dispute_lost' ? 'chargeback_review'
        : input.kind === 'chargeback' ? 'chargeback_review' : 'manual_review';
      const updated = await client.query<FundingRow>(
        `UPDATE meowwa_funding_transactions
         SET status = $3, reconciliation_status = $4, updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND funding_id = $2
         RETURNING ${fundingColumns}`,
        [input.tenantId, input.fundingId, nextStatus, nextReconciliation],
      );
      if (updated.rows.length !== 1) throw new Error('Tenant funding reconciliation was not committed');
      return { transaction: mapFunding(updated.rows[0]!), applied: true };
    }, { serializable: true });
  }

  async settleDirectDeposit(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    chainKey: FundingChainKey;
    walletAddress: string;
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    amountAtomic: string;
    observedAt: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.walletId) || !validIdentifier(input.petId) ||
      !Number.isSafeInteger(input.logIndex) || input.logIndex < 0 || !Number.isSafeInteger(input.blockNumber) ||
      input.blockNumber < 0 || !isAtomicAmount(input.amountAtomic) || parseAtomicAmount(input.amountAtomic) <= 0n) {
      throw new Error('Tenant direct USDC settlement is invalid');
    }
    const chain = requireFundingChain(input.chainKey, 'Tenant direct USDC settlement is invalid');
    const walletAddress = canonicalChainAddress(chain.key, input.walletAddress);
    const transactionHash = canonicalChainTransactionId(chain.key, input.transactionHash);
    const blockHash = canonicalChainBlockHash(chain.key, input.blockHash);
    const observedAt = canonicalTimestamp(input.observedAt);
    const fundingId = directFundingId({
      tenantId: input.tenantId, chainKey: chain.key, transactionHash, logIndex: input.logIndex, walletId: input.walletId,
    });
    const ledger = ledgerIdentity({
      tenantId: input.tenantId, chainKey: chain.key, transactionHash, logIndex: input.logIndex, walletId: input.walletId,
      direction: 'credit',
    });
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const binding = await client.query<WalletRow>(
        `SELECT wallet_id, pet_id, smart_wallet_address::text, status
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND wallet_id = $2 AND pet_id = $3
           AND chain_key = $5 AND smart_wallet_address = $4
           AND status IN ('active', 'provisioning')`,
        [input.tenantId, input.walletId, input.petId, walletAddress, controlChainFor(chain.key)],
      );
      if (binding.rows.length !== 1 || binding.rows[0]!.wallet_id !== input.walletId ||
        binding.rows[0]!.pet_id !== input.petId ||
        !sameAddressOn(chain.key, binding.rows[0]!.smart_wallet_address, walletAddress) ||
        !['active', 'provisioning'].includes(binding.rows[0]!.status)) {
        throw new Error('Tenant direct USDC wallet binding is invalid');
      }
      const recordedEvent = await client.query<FundingRow & {
        event_block_number: number | string;
        event_block_hash: string;
        event_amount_atomic: string;
        event_wallet_id: string;
        event_direction: string;
        event_canonical_status: string;
      }>(
        `SELECT funding.tenant_id::text, funding.funding_id, funding.pet_id, funding.wallet_id,
                funding.wallet_address::text, funding.rail, funding.status, funding.reconciliation_status,
                funding.source_currency, funding.source_amount_minor,
                funding.destination_currency, funding.destination_amount_atomic::text,
                funding.chain_key, funding.chain_id, funding.provider_session_id, funding.transaction_hash::text,
                funding.failure_code, funding.created_at, funding.updated_at,
                chain_event.block_number AS event_block_number,
                chain_event.block_hash::text AS event_block_hash,
                chain_event.amount_atomic::text AS event_amount_atomic,
                chain_event.wallet_id AS event_wallet_id,
                chain_event.direction AS event_direction,
                chain_event.canonical_status AS event_canonical_status
         FROM meowwa_wallet_chain_events AS chain_event
         JOIN meowwa_funding_transactions AS funding
           ON funding.tenant_id = chain_event.tenant_id AND funding.funding_id = chain_event.funding_id
         WHERE chain_event.tenant_id = $1 AND chain_event.chain_key = $5
           AND chain_event.transaction_hash = $2 AND chain_event.log_index = $3
           AND chain_event.wallet_id = $4
         FOR UPDATE OF chain_event, funding`,
        [input.tenantId, transactionHash, input.logIndex, input.walletId, chain.key],
      );
      if (recordedEvent.rows.length > 1) throw new Error('Tenant direct USDC chain evidence is invalid');
      if (recordedEvent.rows[0]) {
        const row = recordedEvent.rows[0];
        const prior = mapFunding(row);
        if (safeNonNegativeInteger(row.event_block_number, 'direct settlement block') !== input.blockNumber ||
          canonicalChainBlockHash(chain.key, row.event_block_hash) !== blockHash ||
          row.event_amount_atomic !== input.amountAtomic || row.event_wallet_id !== input.walletId ||
          row.event_direction !== 'credit' || row.event_canonical_status !== 'canonical' ||
          prior.petId !== input.petId || prior.walletId !== input.walletId || prior.walletAddress !== walletAddress ||
          // A recorded canonical chain event already proves the credit was applied, so the
          // funding may since have moved to chargeback_review, manual_review, provider_refunded
          // or a reclassified failure. Only a still-pending funding attached to a recorded
          // credit is a genuine conflict; anything stricter freezes the global scan cursor.
          prior.status === 'pending' ||
          prior.transactionHash !== transactionHash || prior.destinationAmountAtomic !== input.amountAtomic) {
          throw new Error('Tenant direct USDC settlement replay conflicts');
        }
        return { transaction: prior, applied: false };
      }
      const existing = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND funding_id = $2
         FOR UPDATE`,
        [input.tenantId, fundingId],
      );
      if (existing.rows.length > 1) throw new Error('Tenant direct USDC funding identity is invalid');
      if (existing.rows[0]) {
        const prior = mapFunding(existing.rows[0]);
        if (prior.rail !== 'direct_usdc' || prior.status !== 'settled' || prior.reconciliationStatus !== 'confirmed' ||
          prior.walletId !== input.walletId || prior.petId !== input.petId || prior.walletAddress !== walletAddress ||
          prior.transactionHash !== transactionHash || prior.destinationAmountAtomic !== input.amountAtomic) {
          throw new Error('Tenant direct USDC settlement replay conflicts');
        }
        const evidence = await client.query<{
          block_number: number | string;
          block_hash: string;
          amount_atomic: string;
          funding_id: string | null;
          canonical_status: string;
        }>(
          `SELECT block_number, block_hash::text, amount_atomic::text, funding_id, canonical_status
           FROM meowwa_wallet_chain_events
           WHERE tenant_id = $1 AND chain_key = $5 AND transaction_hash = $2 AND log_index = $3
             AND wallet_id = $4 AND direction = 'credit'`,
          [input.tenantId, transactionHash, input.logIndex, input.walletId, chain.key],
        );
        const row = evidence.rows[0];
        if (evidence.rows.length !== 1 || !row || safeNonNegativeInteger(row.block_number, 'direct settlement block') !== input.blockNumber ||
          canonicalChainBlockHash(chain.key, row.block_hash) !== blockHash || row.amount_atomic !== input.amountAtomic ||
          row.funding_id !== fundingId || row.canonical_status !== 'canonical') {
          throw new Error('Tenant direct USDC settlement evidence conflicts');
        }
        return { transaction: prior, applied: false };
      }
      const inserted = await client.query<FundingRow>(
        `INSERT INTO meowwa_funding_transactions (
           tenant_id, funding_id, pet_id, wallet_id, wallet_address, rail, status,
           reconciliation_status, source_currency, source_amount_minor, destination_currency,
           destination_amount_atomic, chain_key, chain_id, provider, provider_session_id, transaction_hash, failure_code
         ) VALUES (
           $1, $2, $3, $4, $5, 'direct_usdc', 'settled', 'confirmed',
           NULL, NULL, 'usdc', $6, $8, $9, NULL, NULL, $7, NULL
         )
         RETURNING ${fundingColumns}`,
        [input.tenantId, fundingId, input.petId, input.walletId, walletAddress, input.amountAtomic, transactionHash,
          chain.key, evmChainId(chain)],
      );
      if (inserted.rows.length !== 1) throw new Error('Tenant direct USDC funding was not created');
      const transaction = mapFunding(inserted.rows[0]!);
      if (transaction.fundingId !== fundingId) throw new Error('Tenant direct USDC funding identity is invalid');
      const chainEvent = await client.query(
        `INSERT INTO meowwa_wallet_chain_events (
           tenant_id, chain_key, chain_id, transaction_hash, log_index, block_number, block_hash,
           wallet_id, direction, amount_atomic, funding_id, observed_at
         ) VALUES ($1, $10, $11, $2, $3, $4, $5, $6, 'credit', $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          input.tenantId, transactionHash, input.logIndex, input.blockNumber, blockHash,
          input.walletId, input.amountAtomic, fundingId, observedAt, chain.key, evmChainId(chain),
        ],
      );
      if (chainEvent.rowCount !== 1) throw new Error('Tenant direct USDC chain evidence conflicts');
      const entry = await client.query(
        `INSERT INTO meowwa_wallet_ledger_entries (
           tenant_id, entry_id, wallet_id, direction, amount_atomic, source_type, source_id
         ) VALUES ($1, $2, $3, 'credit', $4, 'chain_transfer', $5)
         ON CONFLICT DO NOTHING`,
        [input.tenantId, ledger.entryId, input.walletId, input.amountAtomic, ledger.sourceId],
      );
      if (entry.rowCount !== 1) throw new Error('Tenant direct USDC ledger evidence conflicts');
      return { transaction, applied: true };
    }, { serializable: true });
  }

  async recordWalletOutflow(input: {
    tenantId: string;
    walletId: string;
    chainKey: FundingChainKey;
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    amountAtomic: string;
    destinationAddress: string;
    observedAt: string;
  }): Promise<boolean> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.walletId) ||
      !Number.isSafeInteger(input.logIndex) || input.logIndex < 0 || !Number.isSafeInteger(input.blockNumber) ||
      input.blockNumber < 0 || !isAtomicAmount(input.amountAtomic) || parseAtomicAmount(input.amountAtomic) <= 0n) {
      throw new Error('Tenant wallet outflow is invalid');
    }
    const chain = requireFundingChain(input.chainKey, 'Tenant wallet outflow is invalid');
    if (!isChainAddress(chain, input.destinationAddress)) throw new Error('Tenant wallet outflow is invalid');
    const transactionHash = canonicalChainTransactionId(chain.key, input.transactionHash);
    const blockHash = canonicalChainBlockHash(chain.key, input.blockHash);
    const destinationAddress = canonicalChainAddress(chain.key, input.destinationAddress);
    const observedAt = canonicalTimestamp(input.observedAt);
    const ledger = ledgerIdentity({
      tenantId: input.tenantId, chainKey: chain.key, transactionHash, logIndex: input.logIndex, walletId: input.walletId,
      direction: 'debit',
    });
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const binding = await client.query<{ wallet_id: string; status: string }>(
        `SELECT wallet_id, status
         FROM meowwa_pet_wallet_bindings
         WHERE tenant_id = $1 AND wallet_id = $2 AND chain_key = $3
           AND status IN ('active', 'provisioning')`,
        [input.tenantId, input.walletId, controlChainFor(chain.key)],
      );
      if (binding.rows.length !== 1 || binding.rows[0]!.wallet_id !== input.walletId ||
        !['active', 'provisioning'].includes(binding.rows[0]!.status)) {
        throw new Error('Tenant wallet outflow binding is invalid');
      }
      const chainEvent = await client.query(
        `INSERT INTO meowwa_wallet_chain_events (
           tenant_id, chain_key, chain_id, transaction_hash, log_index, block_number, block_hash,
           wallet_id, direction, amount_atomic, funding_id, observed_at, counterparty_address
         ) VALUES ($1, $10, $11, $2, $3, $4, $5, $6, 'debit', $7, NULL, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          input.tenantId, transactionHash, input.logIndex, input.blockNumber, blockHash,
          input.walletId, input.amountAtomic, observedAt, destinationAddress, chain.key, evmChainId(chain),
        ],
      );
      if (chainEvent.rowCount === 0) {
        const existing = await client.query<{
          block_number: number | string;
          block_hash: string;
          amount_atomic: string;
          canonical_status: string;
          counterparty_address: string | null;
        }>(
          `SELECT block_number, block_hash::text, amount_atomic::text, canonical_status,
                  counterparty_address::text
           FROM meowwa_wallet_chain_events
           WHERE tenant_id = $1 AND chain_key = $5 AND transaction_hash = $2 AND log_index = $3
             AND wallet_id = $4 AND direction = 'debit'`,
          [input.tenantId, transactionHash, input.logIndex, input.walletId, chain.key],
        );
        const row = existing.rows[0];
        // migration 028 adds counterparty_address nullable with no backfill, and the previous binary
        // keeps writing NULLs until the rollout finishes. A NULL is absence of stored evidence, not
        // evidence of a different destination -- treating it as a conflict throws on the first replay
        // of any pre-028 debit and permanently halts the chain's global scan cursor.
        if (existing.rows.length !== 1 || !row || safeNonNegativeInteger(row.block_number, 'outflow block') !== input.blockNumber ||
          canonicalChainBlockHash(chain.key, row.block_hash) !== blockHash || row.amount_atomic !== input.amountAtomic ||
          row.canonical_status !== 'canonical' ||
          (row.counterparty_address !== null && !sameAddressOn(chain.key, row.counterparty_address, destinationAddress))) {
          throw new Error('Tenant wallet outflow evidence conflicts');
        }
        return false;
      }
      if (chainEvent.rowCount !== 1) throw new Error('Tenant wallet outflow chain evidence is invalid');
      const entry = await client.query(
        `INSERT INTO meowwa_wallet_ledger_entries (
           tenant_id, entry_id, wallet_id, direction, amount_atomic, source_type, source_id
         ) VALUES ($1, $2, $3, 'debit', $4, 'chain_transfer', $5)
         ON CONFLICT DO NOTHING`,
        [input.tenantId, ledger.entryId, input.walletId, input.amountAtomic, ledger.sourceId],
      );
      if (entry.rowCount !== 1) throw new Error('Tenant wallet outflow ledger evidence conflicts');
      return true;
    }, { serializable: true });
  }

  async reconcileRecordedChainCredit(input: {
    tenantId: string;
    fundingId: string;
    walletId: string;
    chainKey: FundingChainKey;
    transactionHash: string;
    destinationAmountAtomic: string;
  }): Promise<{ transaction: TenantFundingTransaction; matched: boolean; applied: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.fundingId) || !validIdentifier(input.walletId) ||
      !isAtomicAmount(input.destinationAmountAtomic) || parseAtomicAmount(input.destinationAmountAtomic) <= 0n) {
      throw new Error('Recorded tenant chain credit reconciliation is invalid');
    }
    const chain = requireFundingChain(input.chainKey, 'Recorded tenant chain credit reconciliation is invalid');
    const transactionHash = canonicalChainTransactionId(chain.key, input.transactionHash);
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const targetResult = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND funding_id = $2
         FOR UPDATE`,
        [input.tenantId, input.fundingId],
      );
      if (targetResult.rows.length !== 1) throw new Error('Recorded tenant chain credit target was not found');
      const target = mapFunding(targetResult.rows[0]!);
      if (target.rail !== 'stripe_onramp' || target.walletId !== input.walletId || target.chainKey !== chain.key ||
        target.transactionHash !== transactionHash || target.destinationAmountAtomic !== input.destinationAmountAtomic) {
        throw new Error('Recorded tenant chain credit does not match Onramp funding');
      }
      if (target.status === 'settled' && ['confirmed', 'chargeback_review'].includes(target.reconciliationStatus)) {
        return { transaction: target, matched: true, applied: false };
      }
      if (target.status === 'pending' && target.reconciliationStatus === 'manual_review') {
        return { transaction: target, matched: false, applied: false };
      }
      if (target.status !== 'pending' || !['awaiting_chain', 'chargeback_review'].includes(target.reconciliationStatus)) {
        throw new Error('Recorded tenant chain credit target is not awaiting settlement');
      }
      const reconciliationStatus: TenantFundingReconciliation = target.reconciliationStatus === 'chargeback_review'
        ? 'chargeback_review'
        : 'confirmed';
      const chainResult = await client.query<{
        funding_id: string | null;
        log_index: number | string;
        block_number: number | string;
        block_hash: string;
        amount_atomic: string;
        canonical_status: string;
      }>(
        `SELECT funding_id, log_index, block_number, block_hash::text, amount_atomic::text, canonical_status
         FROM meowwa_wallet_chain_events
         WHERE tenant_id = $1 AND chain_key = $5 AND transaction_hash = $2
           AND wallet_id = $3 AND direction = 'credit' AND amount_atomic = $4
           AND canonical_status = 'canonical'
         FOR UPDATE`,
        [input.tenantId, transactionHash, input.walletId, input.destinationAmountAtomic, chain.key],
      );
      if (chainResult.rows.length === 0) return { transaction: target, matched: false, applied: false };
      if (chainResult.rows.length !== 1) {
        const walletEvidence = input.walletId.length <= 96
          ? `wallet=${input.walletId}`
          : `wallet_sha256=${createHash('sha256').update(input.walletId).digest('hex')}`;
        throw new TenantOnrampEvidenceConflictError(
          'multiple_canonical_chain_credits',
          `tx=${transactionHash};${walletEvidence};amount=${input.destinationAmountAtomic};` +
          `canonical_matches=${chainResult.rows.length}`,
        );
      }
      const credit = chainResult.rows[0]!;
      if (credit.canonical_status !== 'canonical' || credit.amount_atomic !== input.destinationAmountAtomic) {
        throw new Error('Recorded tenant chain credit is invalid');
      }
      const priorFundingId = credit.funding_id;
      if (priorFundingId !== null && priorFundingId !== input.fundingId) {
        if (!validIdentifier(priorFundingId)) throw new Error('Recorded tenant chain credit funding identity is invalid');
        const priorResult = await client.query<FundingRow>(
          `SELECT ${fundingColumns}
           FROM meowwa_funding_transactions
           WHERE tenant_id = $1 AND funding_id = $2
           FOR UPDATE`,
          [input.tenantId, priorFundingId],
        );
        if (priorResult.rows.length !== 1) throw new Error('Recorded tenant chain credit prior funding was not found');
        const prior = mapFunding(priorResult.rows[0]!);
        if (prior.rail !== 'direct_usdc' || prior.status !== 'settled' || prior.reconciliationStatus !== 'confirmed' ||
          prior.walletId !== input.walletId || prior.transactionHash !== transactionHash ||
          prior.destinationAmountAtomic !== input.destinationAmountAtomic) {
          throw new Error('Recorded tenant chain credit is already claimed by different funding');
        }
      }
      const assigned = await client.query(
        `UPDATE meowwa_wallet_chain_events
         SET funding_id = $5
         WHERE tenant_id = $1 AND chain_key = $6 AND transaction_hash = $2
           AND log_index = $3 AND wallet_id = $4 AND direction = 'credit'
           AND canonical_status = 'canonical'`,
        [input.tenantId, transactionHash, safeNonNegativeInteger(credit.log_index, 'chain credit log index'), input.walletId,
          input.fundingId, chain.key],
      );
      if (assigned.rowCount !== 1) throw new Error('Recorded tenant chain credit was not assigned');
      if (priorFundingId !== null && priorFundingId !== input.fundingId) {
        const reclassified = await client.query(
          `UPDATE meowwa_funding_transactions
           SET status = 'failed', reconciliation_status = 'manual_review',
               failure_code = 'reclassified_as_stripe_onramp', updated_at = transaction_timestamp()
           WHERE tenant_id = $1 AND funding_id = $2 AND rail = 'direct_usdc'
             AND status = 'settled' AND reconciliation_status = 'confirmed'`,
          [input.tenantId, priorFundingId],
        );
        if (reclassified.rowCount !== 1) throw new Error('Recorded tenant direct funding was not reclassified');
      }
      const settled = await client.query<FundingRow>(
        `UPDATE meowwa_funding_transactions
         SET status = 'settled', reconciliation_status = $3, failure_code = NULL,
             updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND funding_id = $2 AND rail = 'stripe_onramp'
           AND status = 'pending' AND reconciliation_status IN ('awaiting_chain', 'chargeback_review')
         RETURNING ${fundingColumns}`,
        [input.tenantId, input.fundingId, reconciliationStatus],
      );
      if (settled.rows.length !== 1) throw new Error('Recorded tenant chain credit settlement was not committed');
      return { transaction: mapFunding(settled.rows[0]!), matched: true, applied: true };
    }, { serializable: true });
  }

  async settleFunding(input: {
    tenantId: string;
    fundingId: string;
    walletId: string;
    chainKey: FundingChainKey;
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    amountAtomic: string;
    observedAt: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.fundingId) || !validIdentifier(input.walletId) ||
      !Number.isSafeInteger(input.logIndex) || input.logIndex < 0 || !Number.isSafeInteger(input.blockNumber) ||
      input.blockNumber < 0 || !isAtomicAmount(input.amountAtomic) || parseAtomicAmount(input.amountAtomic) <= 0n) {
      throw new Error('Tenant funding settlement is invalid');
    }
    const chain = requireFundingChain(input.chainKey, 'Tenant funding settlement is invalid');
    const transactionHash = canonicalChainTransactionId(chain.key, input.transactionHash);
    const blockHash = canonicalChainBlockHash(chain.key, input.blockHash);
    const observedAt = canonicalTimestamp(input.observedAt);
    const ledger = ledgerIdentity({
      tenantId: input.tenantId, chainKey: chain.key, transactionHash, logIndex: input.logIndex, walletId: input.walletId,
    });
    return this.withRole('meowwa_financial_worker', input.tenantId, async (client) => {
      const locked = await client.query<FundingRow>(
        `SELECT ${fundingColumns}
         FROM meowwa_funding_transactions
         WHERE tenant_id = $1 AND funding_id = $2
         FOR UPDATE`,
        [input.tenantId, input.fundingId],
      );
      if (locked.rows.length !== 1) throw new Error('Tenant funding settlement target was not found');
      const prior = mapFunding(locked.rows[0]!);
      if (prior.walletId !== input.walletId) throw new Error('Tenant funding settlement wallet does not match');
      if (prior.chainKey !== chain.key) throw new Error('Tenant funding settlement chain does not match');
      if (prior.status === 'settled') {
        if (prior.transactionHash !== transactionHash || prior.destinationAmountAtomic !== input.amountAtomic ||
          !['confirmed', 'chargeback_review'].includes(prior.reconciliationStatus)) {
          throw new Error('Tenant funding settlement replay conflicts');
        }
        const recorded = await client.query<{
          chain_key?: string | null; chain_id: number | string | null; transaction_hash: string; log_index: number | string;
          block_number: number | string; block_hash: string; wallet_id: string; direction: string; amount_atomic: string;
          funding_id: string | null; canonical_status: string; reorged_at: Date | string | null;
        }>(
          `SELECT chain_key, chain_id, transaction_hash::text, log_index, block_number, block_hash::text,
                  wallet_id, direction, amount_atomic::text, funding_id, canonical_status, reorged_at
           FROM meowwa_wallet_chain_events
           WHERE tenant_id = $1 AND chain_key = $4 AND transaction_hash = $2
             AND log_index = $3 AND direction = 'credit'`,
          [input.tenantId, transactionHash, input.logIndex, chain.key],
        );
        const event = recorded.rows[0];
        if (recorded.rows.length !== 1 || !event ||
          fundingChainOfRow(event.chain_key, event.chain_id, 'Tenant funding settlement replay conflicts').key !== chain.key ||
          event.transaction_hash !== transactionHash || Number(event.log_index) !== input.logIndex ||
          Number(event.block_number) !== input.blockNumber ||
          canonicalChainBlockHash(chain.key, event.block_hash) !== blockHash ||
          event.wallet_id !== input.walletId || event.direction !== 'credit' || event.amount_atomic !== input.amountAtomic ||
          event.funding_id !== input.fundingId ||
          event.canonical_status !== 'canonical' || event.reorged_at !== null) {
          throw new Error('Tenant funding settlement replay conflicts');
        }
        return { transaction: prior, applied: false };
      }
      if (prior.status !== 'pending' || !['awaiting_chain', 'chargeback_review'].includes(prior.reconciliationStatus) ||
        (prior.transactionHash !== null && prior.transactionHash !== transactionHash) ||
        (prior.destinationAmountAtomic !== null && prior.destinationAmountAtomic !== input.amountAtomic)) {
        throw new Error('Tenant funding transaction is not awaiting this settlement');
      }
      const reconciliationStatus: TenantFundingReconciliation = prior.reconciliationStatus === 'chargeback_review'
        ? 'chargeback_review'
        : 'confirmed';

      const chainEvent = await client.query(
        `INSERT INTO meowwa_wallet_chain_events (
           tenant_id, chain_key, chain_id, transaction_hash, log_index, block_number, block_hash,
           wallet_id, direction, amount_atomic, funding_id, observed_at
         ) VALUES ($1, $10, $11, $2, $3, $4, $5, $6, 'credit', $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          input.tenantId, transactionHash, input.logIndex, input.blockNumber, blockHash,
          input.walletId, input.amountAtomic, input.fundingId, observedAt, chain.key, evmChainId(chain),
        ],
      );
      if (chainEvent.rowCount !== 1) throw new Error('Tenant chain settlement evidence conflicts');
      const entry = await client.query(
        `INSERT INTO meowwa_wallet_ledger_entries (
           tenant_id, entry_id, wallet_id, direction, amount_atomic, source_type, source_id
         ) VALUES ($1, $2, $3, 'credit', $4, 'chain_transfer', $5)
         ON CONFLICT DO NOTHING`,
        [input.tenantId, ledger.entryId, input.walletId, input.amountAtomic, ledger.sourceId],
      );
      if (entry.rowCount !== 1) throw new Error('Tenant funding ledger evidence conflicts');
      const settled = await client.query<FundingRow>(
        `UPDATE meowwa_funding_transactions
         SET status = 'settled', reconciliation_status = $5, destination_amount_atomic = $3,
             transaction_hash = $4, failure_code = NULL, updated_at = transaction_timestamp()
         WHERE tenant_id = $1 AND funding_id = $2 AND status = 'pending'
           AND reconciliation_status IN ('awaiting_chain', 'chargeback_review')
         RETURNING ${fundingColumns}`,
        [input.tenantId, input.fundingId, input.amountAtomic, transactionHash, reconciliationStatus],
      );
      if (settled.rows.length !== 1) throw new Error('Tenant funding settlement was not committed');
      return { transaction: mapFunding(settled.rows[0]!), applied: true };
    }, { serializable: true });
  }
}
