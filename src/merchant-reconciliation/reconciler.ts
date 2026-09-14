import { ChainConfirmationPendingError, ChainEvidenceMismatchError, type BaseSepoliaExecutionReader } from '../wallet-execution/chain.js';
import type { ControlledMerchantProvider, MerchantProviderOrder, MerchantProviderRefund } from './provider.js';
import { MerchantIdentityConflictError, MerchantReconciliationRepository } from './repository.js';
import type { ControlledMerchantQuote, MerchantOrder, MerchantRefund } from './types.js';

export interface MerchantOrderSettlementInput { requestId: string; providerOrderId: string }
export interface MerchantRefundSettlementInput {
  requestId: string; refundId: string; providerRefundId: string; transactionHash: `0x${string}`;
  blockHash: `0x${string}`; blockNumber: number; logIndex: number;
}

/**
 * Provider-controlled failure text reaching a durable identifier column. The repository
 * rejects anything over 255 characters or blank, and that rejection throws out of the signed
 * webhook, leaving a paid order stranded. Normalize once and use the same value for both the
 * write and the later re-delivery comparison, so a truncated reason still matches itself.
 */
/**
 * A blind create can double-charge the pet if the provider has forgotten the reference. Three
 * attempts rides out a transient outage; more is a permanent rejection that needs an operator.
 */
export const MAX_BLIND_CREATE_ATTEMPTS = 3;

function failureCode(reason: string | undefined, fallback: string): string {
  const normalised = (reason ?? '').trim().slice(0, 255).trim();
  return normalised || fallback;
}

export class MerchantReconciler {
  readonly #repository: MerchantReconciliationRepository;
  readonly #provider: ControlledMerchantProvider;
  readonly #chain: BaseSepoliaExecutionReader;
  readonly #confirmations: number;
  readonly #settleOrder: (input: MerchantOrderSettlementInput) => Promise<void> | void;
  readonly #settleRefund: (input: MerchantRefundSettlementInput) => Promise<void> | void;
  readonly #now: () => Date;

  constructor(options: {
    repository: MerchantReconciliationRepository;
    provider: ControlledMerchantProvider;
    chain: BaseSepoliaExecutionReader;
    confirmations: number;
    settleOrder(input: MerchantOrderSettlementInput): Promise<void> | void;
    settleRefund(input: MerchantRefundSettlementInput): Promise<void> | void;
    now?: () => Date;
  }) {
    if (!Number.isSafeInteger(options.confirmations) || options.confirmations < 2 || options.confirmations > 100) throw new Error('Invalid merchant refund confirmation depth');
    this.#repository = options.repository; this.#provider = options.provider; this.#chain = options.chain;
    this.#confirmations = options.confirmations; this.#settleOrder = options.settleOrder; this.#settleRefund = options.settleRefund;
    this.#now = options.now ?? (() => new Date());
  }

  async refreshQuotes(): Promise<ControlledMerchantQuote[]> {
    return (await this.#provider.fetchQuotes()).map((quote) => this.#repository.putQuote(quote));
  }

  async reconcileOrder(orderId: string): Promise<MerchantOrder> {
    let order = this.#repository.getOrder(orderId);
    if (!order) throw new Error('Merchant order was not found');
    this.#repository.markOrderReconcileAttempt(orderId);
    if (order.status === 'confirmed' || order.status === 'fulfilled') {
      await this.#settleConfirmedOrder(order);
      return this.#repository.getOrder(orderId)!;
    }
    if (['failed', 'cancelled', 'review_required'].includes(order.status)) return order;
    if (order.status === 'prepared') {
      order = this.#repository.markOrderSubmitting(order.orderId, order.version);
    }
    if (order.status === 'submitting') {
      let evidence: MerchantProviderOrder;
      try {
        evidence = await this.#provider.createOrder({
          providerReference: order.providerReference, quoteId: order.quoteId, requestId: order.requestId,
          amountMinor: order.amountMinor, paymentTransactionHash: order.paymentTransactionHash,
        });
      } catch {
        return this.#repository.markOrderUnknown(order.orderId, order.version, 'provider-outcome-unknown');
      }
      order = this.#applyOrderEvidence(order, evidence);
      if (order.status === 'confirmed' || order.status === 'fulfilled') await this.#settleConfirmedOrder(order);
      return this.#repository.getOrder(orderId)!;
    }
    if (order.status === 'submitted' || order.status === 'unknown' || order.status === 'cancel_pending') {
      let evidence: MerchantProviderOrder | undefined;
      try { evidence = await this.#provider.getOrder(order.providerReference); }
      catch {
        if (order.status === 'submitted') return this.#repository.markOrderUnknown(order.orderId, order.version, 'provider-status-unavailable');
        return order;
      }
      if (!evidence && order.status === 'unknown') {
        // Every pass through here is a blind create: the provider has no record of the reference
        // and the pet has already paid on chain. A permanent rejection -- an expired quoteId, a
        // gateway contract change -- would otherwise repeat on every poll forever while the batch
        // reported no failures. Bound the replays and hand the order to a human, as the wallet
        // execution reconciler does with MAX_BLIND_SUBMIT_ATTEMPTS.
        if (this.#repository.recordBlindCreateAttempt(order.orderId) > MAX_BLIND_CREATE_ATTEMPTS) {
          return this.#reviewOrder(order, 'blind-create-attempts-exhausted');
        }
        try {
          evidence = await this.#provider.createOrder({
            providerReference: order.providerReference, quoteId: order.quoteId, requestId: order.requestId,
            amountMinor: order.amountMinor, paymentTransactionHash: order.paymentTransactionHash,
          });
        } catch { return order; }
      }
      if (!evidence) return order;
      order = this.#applyOrderEvidence(order, evidence);
      if (order.status === 'confirmed' || order.status === 'fulfilled') await this.#settleConfirmedOrder(order);
      return this.#repository.getOrder(orderId)!;
    }
    return order;
  }

  async reconcileRefund(refundId: string): Promise<MerchantRefund> {
    let refund = this.#repository.getRefund(refundId);
    if (!refund) throw new Error('Merchant refund was not found');
    this.#repository.markRefundReconcileAttempt(refundId);
    if (refund.status === 'chain_confirmed') {
      await this.#settleConfirmedRefund(refund);
      return this.#repository.getRefund(refundId)!;
    }
    if (['failed', 'review_required'].includes(refund.status)) return refund;
    const order = this.#repository.getOrder(refund.orderId);
    if (!order || !order.providerOrderId || !['confirmed', 'fulfilled'].includes(order.status)) {
      return this.#reviewRefund(refund, 'confirmed-order-identity-missing');
    }
    if (refund.status === 'prepared') {
      refund = this.#repository.markRefundSubmitting(refund.refundId, refund.version);
    }
    if (refund.status === 'submitting') {
      let evidence: MerchantProviderRefund;
      try {
        evidence = await this.#provider.createRefund({
          providerReference: refund.providerReference, providerOrderId: order.providerOrderId,
          requestId: refund.requestId, amountMinor: refund.amountMinor,
        });
      } catch {
        return this.#repository.markRefundUnknown(refund.refundId, refund.version, 'provider-outcome-unknown');
      }
      refund = this.#applyRefundEvidence(refund, evidence);
    } else if (refund.status === 'submitted' || refund.status === 'unknown') {
      let evidence: MerchantProviderRefund | undefined;
      try { evidence = await this.#provider.getRefund(refund.providerReference); }
      catch {
        if (refund.status === 'submitted') return this.#repository.markRefundUnknown(refund.refundId, refund.version, 'provider-status-unavailable');
        return refund;
      }
      if (!evidence && refund.status === 'unknown') {
        // Same rule, same constant and same failure code as the order branch above. A refund create
        // replayed against a provider that has no record of the reference can issue a second refund
        // for one payment, and a permanent rejection would otherwise repeat on every poll forever
        // while the batch reported no failures. The bound existed only on the order side.
        if (this.#repository.recordRefundBlindCreateAttempt(refund.refundId) > MAX_BLIND_CREATE_ATTEMPTS) {
          return this.#reviewRefund(refund, 'blind-create-attempts-exhausted');
        }
        try {
          evidence = await this.#provider.createRefund({
            providerReference: refund.providerReference, providerOrderId: order.providerOrderId,
            requestId: refund.requestId, amountMinor: refund.amountMinor,
          });
        } catch { return refund; }
      }
      if (!evidence) return refund;
      refund = this.#applyRefundEvidence(refund, evidence);
    }
    if (refund.status !== 'provider_confirmed' || !refund.transactionHash) return refund;
    let chain;
    try {
      chain = await this.#chain.verifyTransfer({
        transactionHash: refund.transactionHash, sender: order.merchantRecipient,
        recipient: order.petWalletAddress, amountAtomic: refund.amountAtomic, confirmations: this.#confirmations,
      });
    } catch (error) {
      if (error instanceof ChainConfirmationPendingError) return refund;
      if (error instanceof ChainEvidenceMismatchError) return this.#reviewRefund(refund, 'refund-chain-evidence-mismatch');
      throw error;
    }
    refund = this.#repository.confirmRefundChain(refund.refundId, refund.version, {
      transactionHash: chain.transactionHash, blockHash: chain.blockHash, blockNumber: chain.blockNumber,
      logIndex: chain.logIndex, confirmedAt: this.#now().toISOString(),
    });
    await this.#settleConfirmedRefund(refund);
    return this.#repository.getRefund(refundId)!;
  }

  recordOrderEvidence(evidence: MerchantProviderOrder): MerchantOrder | undefined {
    const order = this.#repository.getOrderByReference(evidence.providerReference);
    return order ? this.#applyOrderEvidence(order, evidence) : undefined;
  }

  recordRefundEvidence(evidence: MerchantProviderRefund): MerchantRefund | undefined {
    const refund = this.#repository.getRefundByReference(evidence.providerReference);
    return refund ? this.#applyRefundEvidence(refund, evidence) : undefined;
  }

  #applyOrderEvidence(order: MerchantOrder, evidence: MerchantProviderOrder): MerchantOrder {
    if (evidence.providerReference !== order.providerReference || !evidence.providerOrderId) return this.#reviewOrder(order, 'provider-order-identity-mismatch');
    if (order.providerOrderId && order.providerOrderId !== evidence.providerOrderId) return this.#reviewOrder(order, 'provider-order-id-conflict');
    if (order.status === 'failed') {
      const failure = failureCode(evidence.reason, 'provider-order-failed');
      return evidence.status === 'failed' && order.failureCode === failure &&
        order.providerOrderId === evidence.providerOrderId
        ? order
        : this.#reviewOrder(order, 'provider-order-terminal-conflict');
    }
    if (order.status === 'cancelled') {
      return evidence.status === 'cancelled'
        ? order
        : this.#reviewOrder(order, 'provider-order-terminal-conflict');
    }
    try {
      if (evidence.status === 'pending') {
        return ['submitting', 'unknown'].includes(order.status)
          ? this.#repository.markOrderSubmitted(order.orderId, order.version, evidence.providerOrderId) : order;
      }
      if (evidence.status === 'failed') {
        if (order.status === 'confirmed' || order.status === 'fulfilled') return this.#reviewOrder(order, 'provider-order-terminal-conflict');
        if (order.status === 'submitting') order = this.#repository.markOrderSubmitted(order.orderId, order.version, evidence.providerOrderId);
        return this.#repository.failOrder(order.orderId, order.version, failureCode(evidence.reason, 'provider-order-failed'));
      }
      if (evidence.status === 'cancelled') return this.#reviewOrder(order, 'paid-order-cancelled-refund-required');
      if (order.status === 'prepared') return this.#reviewOrder(order, 'unsolicited-provider-order-confirmation');
      if (order.status === 'submitting') order = this.#repository.markOrderSubmitted(order.orderId, order.version, evidence.providerOrderId);
      if (order.status === 'submitted' || order.status === 'unknown') order = this.#repository.confirmOrder(order.orderId, order.version, evidence.providerOrderId);
      if (evidence.status === 'fulfilled' && order.status === 'confirmed') order = this.#repository.fulfillOrder(order.orderId, order.version);
      return order;
    } catch (error) {
      if (error instanceof MerchantIdentityConflictError) return this.#reviewOrder(this.#repository.getOrder(order.orderId)!, 'provider-order-evidence-conflict');
      throw error;
    }
  }

  #applyRefundEvidence(refund: MerchantRefund, evidence: MerchantProviderRefund): MerchantRefund {
    if (evidence.providerReference !== refund.providerReference || !evidence.providerRefundId) return this.#reviewRefund(refund, 'provider-refund-identity-mismatch');
    if (refund.providerRefundId && refund.providerRefundId !== evidence.providerRefundId) return this.#reviewRefund(refund, 'provider-refund-id-conflict');
    if (refund.status === 'failed') {
      const failure = failureCode(evidence.reason, 'provider-refund-failed');
      return evidence.status === 'failed' && refund.failureCode === failure &&
        refund.providerRefundId === evidence.providerRefundId
        ? refund
        : this.#reviewRefund(refund, 'provider-refund-terminal-conflict');
    }
    try {
      if (evidence.status === 'pending') {
        return ['submitting', 'unknown'].includes(refund.status)
          ? this.#repository.markRefundSubmitted(refund.refundId, refund.version, evidence.providerRefundId) : refund;
      }
      if (evidence.status === 'failed') {
        if (refund.status === 'provider_confirmed' || refund.status === 'chain_confirmed') return this.#reviewRefund(refund, 'provider-refund-terminal-conflict');
        if (refund.status === 'submitting') refund = this.#repository.markRefundSubmitted(refund.refundId, refund.version, evidence.providerRefundId);
        return this.#repository.failRefund(refund.refundId, refund.version, failureCode(evidence.reason, 'provider-refund-failed'));
      }
      if (!evidence.transactionHash) return this.#reviewRefund(refund, 'provider-refund-confirmation-missing-hash');
      if (refund.status === 'prepared') return this.#reviewRefund(refund, 'unsolicited-provider-refund-confirmation');
      if (refund.status === 'submitting') refund = this.#repository.markRefundSubmitted(refund.refundId, refund.version, evidence.providerRefundId);
      if (refund.status === 'submitted' || refund.status === 'unknown') {
        refund = this.#repository.confirmRefundProvider(refund.refundId, refund.version, {
          providerRefundId: evidence.providerRefundId, transactionHash: evidence.transactionHash,
        });
      // chain_confirmed must be checked too: a contradictory provider hash after chain
      // settlement is exactly the case that needs review, not the one to ignore.
      } else if ((refund.status === 'provider_confirmed' || refund.status === 'chain_confirmed') &&
        refund.transactionHash?.toLowerCase() !== evidence.transactionHash.toLowerCase()) {
        return this.#reviewRefund(refund, 'provider-refund-hash-conflict');
      }
      return refund;
    } catch (error) {
      if (error instanceof MerchantIdentityConflictError) return this.#reviewRefund(this.#repository.getRefund(refund.refundId)!, 'provider-refund-evidence-conflict');
      throw error;
    }
  }

  async #settleConfirmedOrder(order: MerchantOrder): Promise<void> {
    if (!['confirmed', 'fulfilled'].includes(order.status) || !order.providerOrderId || order.internalSettledAt) return;
    await this.#settleOrder({ requestId: order.requestId, providerOrderId: order.providerOrderId });
    const current = this.#repository.getOrder(order.orderId)!;
    if (!current.internalSettledAt) this.#repository.markOrderInternalSettled(current.orderId, current.version, this.#now().toISOString());
  }

  async #settleConfirmedRefund(refund: MerchantRefund): Promise<void> {
    if (refund.status !== 'chain_confirmed' || !refund.providerRefundId || !refund.transactionHash || !refund.blockHash ||
        refund.blockNumber === null || refund.logIndex === null || refund.internalSettledAt) return;
    await this.#settleRefund({
      requestId: refund.requestId, refundId: refund.refundId, providerRefundId: refund.providerRefundId, transactionHash: refund.transactionHash,
      blockHash: refund.blockHash, blockNumber: refund.blockNumber, logIndex: refund.logIndex,
    });
    const current = this.#repository.getRefund(refund.refundId)!;
    if (!current.internalSettledAt) this.#repository.markRefundInternalSettled(current.refundId, current.version, this.#now().toISOString());
  }

  #reviewOrder(order: MerchantOrder, reason: string): MerchantOrder {
    if (order.status === 'review_required') return order;
    return this.#repository.reviewOrder(order.orderId, order.version, reason);
  }

  #reviewRefund(refund: MerchantRefund, reason: string): MerchantRefund {
    if (refund.status === 'review_required') return refund;
    return this.#repository.reviewRefund(refund.refundId, refund.version, reason);
  }
}

export class MerchantReconciliationWorker {
  readonly #run: () => Promise<void>;
  #active: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(run: () => Promise<void>) { this.#run = run; }
  async runOnce(): Promise<void> {
    if (this.#active) return;
    const active = this.#run(); this.#active = active;
    try { await active; } finally { if (this.#active === active) this.#active = undefined; }
  }
  start(pollMs: number, onError: (error: unknown) => void = () => undefined): void {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 3_600_000) throw new Error('Invalid merchant reconciliation interval');
    if (this.#timer) return;
    const run = () => { void this.runOnce().catch(onError); };
    run(); this.#timer = setInterval(run, pollMs); this.#timer.unref();
  }
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer); this.#timer = undefined;
    try { await this.#active; } catch { /* scheduled caller reports failures */ }
  }
}
