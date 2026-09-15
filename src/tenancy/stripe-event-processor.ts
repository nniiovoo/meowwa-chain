import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { CHAINS, isChainTransactionId } from '@meowwa/chain-domain';
import { stripeOnrampNetwork, type OnrampProvider, type VerifiedOnrampSession } from '../funding/stripe-onramp.js';
import { canonicalChainTransactionId, sameAddressOn, type FundingChainKey } from '../funding/types.js';
import {
  TenantOnrampEvidenceConflictError,
  type TenantFundingTransaction,
} from './financial-repository.js';

export interface TenantStripeEventRepository {
  resolveFundingTenant(fundingId: string): Promise<string | undefined>;
  getFundingForWorker(tenantId: string, fundingId: string): Promise<TenantFundingTransaction | undefined>;
  recordVerifiedProviderEvent(input: {
    tenantId: string;
    provider: 'stripe';
    eventId: string;
    eventType: string;
    payloadSha256: string;
  }): Promise<'inserted' | 'duplicate'>;
  isVerifiedProviderEventProcessed(input: {
    tenantId: string;
    provider: 'stripe';
    eventId: string;
  }): Promise<boolean>;
  markVerifiedProviderEventProcessed(input: {
    tenantId: string;
    provider: 'stripe';
    eventId: string;
  }): Promise<boolean>;
  markOnrampAwaitingChain(input: {
    tenantId: string;
    fundingId: string;
    providerSessionId: string;
    transactionHash: string;
    destinationAmountAtomic: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }>;
  markOnrampFailed(input: {
    tenantId: string;
    fundingId: string;
    providerSessionId: string;
    failureCode: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }>;
  reconcileRecordedChainCredit(input: {
    tenantId: string;
    fundingId: string;
    walletId: string;
    chainKey: FundingChainKey;
    transactionHash: string;
    destinationAmountAtomic: string;
  }): Promise<{ transaction: TenantFundingTransaction; matched: boolean; applied: boolean }>;
  recordReconciliation(input: {
    tenantId: string;
    fundingId: string;
    kind: 'refund' | 'chargeback' | 'manual_review' | 'dispute_won' | 'dispute_lost';
    evidenceReference: string;
  }): Promise<{ transaction: TenantFundingTransaction; applied: boolean }>;
}

export class TenantStripeWebhookVerificationError extends Error {
  constructor() {
    super('Stripe webhook signature verification failed');
    this.name = 'TenantStripeWebhookVerificationError';
  }
}

export class TenantStripeEventError extends Error {
  constructor(message = 'Stripe webhook event is invalid') {
    super(message);
    this.name = 'TenantStripeEventError';
  }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 255 && value.trim() === value;
}

function eventObject(event: Stripe.Event): Record<string, unknown> {
  const value = event.data?.object;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TenantStripeEventError();
  return value as unknown as Record<string, unknown>;
}

function metadataOf(object: Record<string, unknown>): Record<string, unknown> {
  const value = object.metadata;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TenantStripeEventError();
  return value as Record<string, unknown>;
}

/**
 * Stripe's own verdict on a closed dispute. Only 'won' and 'lost' are outcomes; the others
 * ('needs_response', 'under_review', 'warning_*') mean the dispute is still live and a
 * 'charge.dispute.closed' carrying one is not something to record an outcome for.
 */
function disputeOutcome(object: Record<string, unknown>): 'dispute_won' | 'dispute_lost' | undefined {
  const status = object.status;
  if (status === 'won') return 'dispute_won';
  if (status === 'lost') return 'dispute_lost';
  return undefined;
}

function fundingReference(metadata: Record<string, unknown>): string {
  const fundingId = metadata.meowwa_funding_id;
  if (!identifier(fundingId)) throw new TenantStripeEventError('Stripe event has no trusted funding reference');
  return fundingId;
}

function requireMatchingMetadata(
  metadata: Record<string, string>,
  transaction: TenantFundingTransaction,
): void {
  if (metadata.meowwa_tenant_id !== transaction.tenantId ||
    metadata.meowwa_funding_id !== transaction.fundingId ||
    metadata.meowwa_pet_id !== transaction.petId ||
    metadata.meowwa_wallet_id !== transaction.walletId) {
    throw new TenantStripeEventError('Stripe Onramp session does not match the stored tenant funding destination');
  }
}

/**
 * The session Stripe reports must name the rail the funding row was opened on: same chain key,
 * Stripe's network name for that chain, and the wallet address compared the way that family
 * compares addresses (hex is case-insensitive, base58 is not). The stored chain id is only a
 * consistency check against the registry, since Solana rows carry none.
 */
function requireMatchingSession(
  session: VerifiedOnrampSession,
  transaction: TenantFundingTransaction,
  providerSessionId: string,
  requireLivemode: boolean,
): void {
  requireMatchingMetadata(session.metadata, transaction);
  const chain = CHAINS[transaction.chainKey];
  const chainId = chain.family === 'evm' ? chain.chainId : null;
  if (transaction.rail !== 'stripe_onramp' || transaction.providerSessionId !== providerSessionId ||
    session.providerSessionId !== providerSessionId || session.livemode !== requireLivemode ||
    session.chainKey !== transaction.chainKey || session.destinationNetwork !== stripeOnrampNetwork(transaction.chainKey) ||
    transaction.chainId !== chainId ||
    !sameAddressOn(transaction.chainKey, session.walletAddress, transaction.walletAddress) ||
    session.destinationCurrency !== 'usdc' ||
    (session.transactionHash !== null && !isChainTransactionId(chain, session.transactionHash))) {
    throw new TenantStripeEventError('Stripe Onramp session does not match the stored tenant funding destination');
  }
}

function assertEventIdentity(event: Stripe.Event, requireLivemode: boolean): { eventId: string; eventType: string } {
  const eventType = event.type as string;
  if (!identifier(event.id) || !identifier(eventType) || event.livemode !== requireLivemode) {
    throw new TenantStripeEventError();
  }
  return { eventId: event.id, eventType };
}

function conflictEvidenceReference(eventId: string, error: TenantOnrampEvidenceConflictError): string {
  const suffix = `${error.reason}:${error.evidence}`;
  const reference = `stripe:${eventId}:${suffix}`;
  if (reference.length <= 512) return reference;
  const eventDigest = createHash('sha256').update(eventId).digest('hex');
  const bounded = `stripe:event_sha256=${eventDigest}:${suffix}`;
  if (bounded.length <= 512) return bounded;
  const evidenceDigest = createHash('sha256').update(error.evidence).digest('hex');
  return `stripe:event_sha256=${eventDigest}:${error.reason}:evidence_sha256=${evidenceDigest}`;
}

export class TenantStripeEventProcessor {
  readonly #provider: OnrampProvider;
  readonly #repository: TenantStripeEventRepository;
  readonly #requireLivemode: boolean;

  constructor(options: {
    provider: OnrampProvider;
    repository: TenantStripeEventRepository;
    requireLivemode: boolean;
  }) {
    this.#provider = options.provider;
    this.#repository = options.repository;
    this.#requireLivemode = options.requireLivemode;
  }

  async process(rawBody: Buffer, signature: string): Promise<{
    received: true;
    duplicate: boolean;
    handled: boolean;
  }> {
    if (!signature || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      throw new TenantStripeWebhookVerificationError();
    }
    let event: Stripe.Event;
    try {
      event = this.#provider.constructWebhook(rawBody, signature);
    } catch {
      throw new TenantStripeWebhookVerificationError();
    }
    const { eventId, eventType } = assertEventIdentity(event, this.#requireLivemode);
    if (eventType !== 'crypto.onramp_session.updated' && eventType !== 'charge.refunded' &&
      !eventType.startsWith('charge.dispute.')) {
      return { received: true, duplicate: false, handled: false };
    }

    let tenantId: string;
    let transaction: TenantFundingTransaction;
    let session: VerifiedOnrampSession | undefined;
    let fundingId: string;
    if (eventType === 'crypto.onramp_session.updated') {
      const object = eventObject(event);
      const providerSessionId = object.id;
      if (!identifier(providerSessionId) || !/^cos_[A-Za-z0-9_]+$/.test(providerSessionId)) {
        throw new TenantStripeEventError('Stripe Onramp event has no valid session reference');
      }
      session = await this.#provider.retrieveSession(providerSessionId);
      fundingId = fundingReference(session.metadata);
      tenantId = await this.#resolveTenant(fundingId);
      transaction = await this.#getFunding(tenantId, fundingId);
      requireMatchingSession(session, transaction, providerSessionId, this.#requireLivemode);
    } else {
      const metadata = metadataOf(eventObject(event));
      fundingId = fundingReference(metadata);
      tenantId = await this.#resolveTenant(fundingId);
      transaction = await this.#getFunding(tenantId, fundingId);
      if (transaction.rail !== 'stripe_onramp') throw new TenantStripeEventError('Stripe event funding rail does not match');
      const metadataTenant = metadata.meowwa_tenant_id;
      if (metadataTenant !== undefined && metadataTenant !== tenantId) {
        throw new TenantStripeEventError('Stripe event tenant does not match');
      }
    }

    const recorded = await this.#repository.recordVerifiedProviderEvent({
      tenantId,
      provider: 'stripe',
      eventId,
      eventType,
      payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
    });
    const duplicate = recorded === 'duplicate';
    const processed = duplicate && await this.#repository.isVerifiedProviderEventProcessed({
      tenantId, provider: 'stripe', eventId,
    });
    const retryUnmatchedChainCredit = eventType === 'crypto.onramp_session.updated' &&
      session?.status === 'fulfillment_complete' && transaction.status === 'pending' &&
      transaction.reconciliationStatus === 'awaiting_chain';
    if (processed && !retryUnmatchedChainCredit) {
      return { received: true, duplicate: true, handled: true };
    }

    if (eventType === 'crypto.onramp_session.updated') {
      if (!session) throw new TenantStripeEventError();
      try {
        if (session.status === 'rejected') {
          await this.#repository.markOnrampFailed({
            tenantId,
            fundingId,
            providerSessionId: session.providerSessionId,
            failureCode: 'stripe_onramp_rejected',
          });
        } else if (session.status === 'fulfillment_complete') {
          if (session.transactionHash === null || session.destinationAmountAtomic === null) {
            throw new TenantStripeEventError('Stripe completed Onramp session has incomplete settlement evidence');
          }
          // Storage form for the funding's rail: lowercase hex on Base, the base58 signature
          // verbatim on Solana. requireMatchingSession already proved it is an id of that chain.
          const transactionHash = canonicalChainTransactionId(transaction.chainKey, session.transactionHash);
          await this.#repository.markOnrampAwaitingChain({
            tenantId,
            fundingId,
            providerSessionId: session.providerSessionId,
            transactionHash,
            destinationAmountAtomic: session.destinationAmountAtomic,
          });
          await this.#repository.reconcileRecordedChainCredit({
            tenantId,
            fundingId,
            walletId: transaction.walletId,
            chainKey: transaction.chainKey,
            transactionHash,
            destinationAmountAtomic: session.destinationAmountAtomic,
          });
        }
      } catch (error) {
        if (!(error instanceof TenantOnrampEvidenceConflictError)) throw error;
        await this.#repository.recordReconciliation({
          tenantId,
          fundingId,
          kind: 'manual_review',
          evidenceReference: conflictEvidenceReference(eventId, error),
        });
      }
    } else if (eventType === 'charge.refunded' || eventType === 'charge.dispute.created' ||
      eventType === 'charge.dispute.closed') {
      // Opening a dispute is chargeback evidence; closing one is the outcome. The other
      // charge.dispute.* notifications (.updated, .funds_withdrawn, .funds_reinstated) each carry
      // their own event id and are acknowledged without re-flagging, because recording them as
      // fresh chargebacks re-flagged already-resolved fundings on every later notification.
      //
      // A closed dispute that is neither won nor lost is still live, so it gets the same
      // acknowledge-only treatment rather than a fabricated outcome.
      const outcome = eventType === 'charge.dispute.closed' ? disputeOutcome(eventObject(event)) : undefined;
      if (eventType === 'charge.dispute.closed' && !outcome) {
        await this.#repository.markVerifiedProviderEventProcessed({ tenantId, provider: 'stripe', eventId });
        return { received: true, duplicate, handled: true };
      }
      try {
        await this.#repository.recordReconciliation({
          tenantId,
          fundingId,
          kind: outcome ?? (eventType === 'charge.refunded' ? 'refund' : 'chargeback'),
          evidenceReference: `stripe:${eventId}`,
        });
      } catch (error) {
        if (!(error instanceof TenantOnrampEvidenceConflictError)) throw error;
        await this.#repository.recordReconciliation({
          tenantId,
          fundingId,
          kind: 'manual_review',
          evidenceReference: conflictEvidenceReference(eventId, error),
        });
      }
    }

    await this.#repository.markVerifiedProviderEventProcessed({ tenantId, provider: 'stripe', eventId });
    return { received: true, duplicate, handled: true };
  }

  async #resolveTenant(fundingId: string): Promise<string> {
    const tenantId = await this.#repository.resolveFundingTenant(fundingId);
    if (!tenantId) throw new TenantStripeEventError('Stripe funding reference was not found');
    return tenantId;
  }

  async #getFunding(tenantId: string, fundingId: string): Promise<TenantFundingTransaction> {
    const transaction = await this.#repository.getFundingForWorker(tenantId, fundingId);
    if (!transaction || transaction.tenantId !== tenantId || transaction.fundingId !== fundingId) {
      throw new TenantStripeEventError('Stripe funding reference was not found');
    }
    return transaction;
  }
}
