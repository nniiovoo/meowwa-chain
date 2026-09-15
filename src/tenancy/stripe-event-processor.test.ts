import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { encodeBase58, isSolanaAddress, isSolanaSignature } from '@meowwa/chain-domain';
import type { OnrampProvider, VerifiedOnrampSession } from '../funding/stripe-onramp.js';
import type { TenantFundingTransaction } from './financial-repository.js';
import { TenantOnrampEvidenceConflictError } from './financial-repository.js';
import {
  TenantStripeEventProcessor,
  TenantStripeWebhookVerificationError,
  type TenantStripeEventRepository,
} from './stripe-event-processor.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const fundingId = 'funding_a';
const walletAddress = `0x${'1'.repeat(40)}` as const;
const transactionHash = `0x${'2'.repeat(64)}` as const;
// Solana: a 32-byte base58 pubkey and an 88-character (longest form) 64-byte base58 signature.
const solanaWalletAddress = encodeBase58(new Uint8Array(32).fill(1));
const solanaSignature = encodeBase58(new Uint8Array(64).fill(255));
const otherSolanaSignature = encodeBase58(new Uint8Array(64).fill(254));
// The same characters as solanaWalletAddress with one letter's case flipped: a different key.
const caseFlippedSolanaAddress = `${solanaWalletAddress.slice(0, 2)}${solanaWalletAddress[2]!.toLowerCase()}${solanaWalletAddress.slice(3)}`;

function funding(overrides: Partial<TenantFundingTransaction> = {}): TenantFundingTransaction {
  return {
    tenantId,
    fundingId,
    petId: 'pet_a',
    walletId: 'wallet_a',
    walletAddress,
    rail: 'stripe_onramp',
    status: 'pending',
    reconciliationStatus: 'awaiting_provider',
    sourceCurrency: 'usd',
    sourceAmountMinor: 2_500,
    destinationCurrency: 'usdc',
    destinationAmountAtomic: null,
    chainKey: 'base',
    chainId: 8453,
    providerSessionId: 'cos_a',
    transactionHash: null,
    failureCode: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function solanaFunding(overrides: Partial<TenantFundingTransaction> = {}): TenantFundingTransaction {
  return funding({ chainKey: 'solana', chainId: null, walletAddress: solanaWalletAddress, ...overrides });
}

function session(overrides: Partial<VerifiedOnrampSession> = {}): VerifiedOnrampSession {
  return {
    providerSessionId: 'cos_a',
    status: 'fulfillment_complete',
    livemode: true,
    chainKey: 'base',
    walletAddress,
    destinationCurrency: 'usdc',
    destinationNetwork: 'base',
    destinationAmountAtomic: '24000000',
    transactionHash,
    metadata: {
      meowwa_tenant_id: tenantId,
      meowwa_funding_id: fundingId,
      meowwa_pet_id: 'pet_a',
      meowwa_wallet_id: 'wallet_a',
    },
    redirectUrl: null,
    ...overrides,
  };
}

function solanaSession(overrides: Partial<VerifiedOnrampSession> = {}): VerifiedOnrampSession {
  return session({
    chainKey: 'solana', destinationNetwork: 'solana', walletAddress: solanaWalletAddress, transactionHash: solanaSignature,
    ...overrides,
  });
}

function stripeEvent(type = 'crypto.onramp_session.updated', object: Record<string, unknown> = { id: 'cos_a' }): Stripe.Event {
  return { id: 'evt_a', type, livemode: true, data: { object } } as unknown as Stripe.Event;
}

function fixture(options: {
  event?: Stripe.Event;
  verifiedSession?: VerifiedOnrampSession;
  transaction?: TenantFundingTransaction;
  duplicate?: boolean;
  processed?: boolean;
} = {}) {
  const provider: OnrampProvider = {
    createSession: vi.fn(),
    retrieveSession: vi.fn(async () => options.verifiedSession ?? session()),
    constructWebhook: vi.fn((raw, signature) => {
      if (signature !== 'valid' || raw.toString('utf8') !== '{"exact":true}') throw new Error('bad signature');
      return options.event ?? stripeEvent();
    }),
  };
  const repository: TenantStripeEventRepository = {
    resolveFundingTenant: vi.fn(async () => tenantId),
    getFundingForWorker: vi.fn(async () => options.transaction ?? funding()),
    recordVerifiedProviderEvent: vi.fn(async () => options.duplicate ? 'duplicate' : 'inserted'),
    isVerifiedProviderEventProcessed: vi.fn(async () => options.processed ?? false),
    markVerifiedProviderEventProcessed: vi.fn(async () => true),
    markOnrampAwaitingChain: vi.fn(async () => ({ transaction: funding({
      reconciliationStatus: 'awaiting_chain', transactionHash, destinationAmountAtomic: '24000000',
    }), applied: true })),
    reconcileRecordedChainCredit: vi.fn(async () => ({
      transaction: funding({ reconciliationStatus: 'awaiting_chain', transactionHash, destinationAmountAtomic: '24000000' }),
      matched: false,
      applied: false,
    })),
    markOnrampFailed: vi.fn(async () => ({ transaction: funding({
      status: 'failed', reconciliationStatus: 'manual_review', failureCode: 'stripe_onramp_rejected',
    }), applied: true })),
    recordReconciliation: vi.fn(async () => ({ transaction: funding({ status: 'refunded' }), applied: true })),
  };
  return {
    provider,
    repository,
    processor: new TenantStripeEventProcessor({ provider, repository, requireLivemode: true }),
  };
}

describe('TenantStripeEventProcessor', () => {
  it('rejects a missing or invalid signature before any provider state or database reference is trusted', async () => {
    const { processor, provider, repository } = fixture();
    await expect(processor.process(Buffer.from('{"exact":true}'), '')).rejects.toBeInstanceOf(TenantStripeWebhookVerificationError);
    await expect(processor.process(Buffer.from('{"tampered":true}'), 'valid')).rejects.toBeInstanceOf(TenantStripeWebhookVerificationError);
    expect(provider.retrieveSession).not.toHaveBeenCalled();
    expect(repository.resolveFundingTenant).not.toHaveBeenCalled();
    expect(repository.recordVerifiedProviderEvent).not.toHaveBeenCalled();
  });

  it('re-fetches a completed session, validates its tenant wallet contract, and only moves it to chain confirmation', async () => {
    const { processor, provider, repository } = fixture();
    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
      received: true, duplicate: false, handled: true,
    });
    expect(provider.retrieveSession).toHaveBeenCalledWith('cos_a');
    expect(repository.resolveFundingTenant).toHaveBeenCalledWith(fundingId);
    expect(repository.getFundingForWorker).toHaveBeenCalledWith(tenantId, fundingId);
    expect(repository.markOnrampAwaitingChain).toHaveBeenCalledWith({
      tenantId,
      fundingId,
      providerSessionId: 'cos_a',
      transactionHash,
      destinationAmountAtomic: '24000000',
    });
    expect(repository.reconcileRecordedChainCredit).toHaveBeenCalledWith({
      tenantId,
      fundingId,
      walletId: 'wallet_a',
      chainKey: 'base',
      transactionHash,
      destinationAmountAtomic: '24000000',
    });
    expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalledAfter(
      repository.markOnrampAwaitingChain as ReturnType<typeof vi.fn>,
    );
  });

  it('retries chain reconciliation for a completed event that was previously processed', async () => {
    const { processor, repository } = fixture({
      duplicate: true,
      processed: true,
      transaction: funding({
        reconciliationStatus: 'awaiting_chain', transactionHash, destinationAmountAtomic: '24000000',
      }),
    });
    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
      received: true, duplicate: true, handled: true,
    });
    expect(repository.markOnrampAwaitingChain).toHaveBeenCalledOnce();
    expect(repository.reconcileRecordedChainCredit).toHaveBeenCalledOnce();
    expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalledOnce();
  });

  it('does not replay a processed Onramp event after the funding reached a later terminal state', async () => {
    const { processor, repository } = fixture({
      duplicate: true,
      processed: true,
      transaction: funding({
        status: 'refunded', reconciliationStatus: 'provider_refunded',
        transactionHash, destinationAmountAtomic: '24000000',
      }),
    });

    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
      received: true, duplicate: true, handled: true,
    });
    expect(repository.markOnrampAwaitingChain).not.toHaveBeenCalled();
    expect(repository.reconcileRecordedChainCredit).not.toHaveBeenCalled();
    expect(repository.markVerifiedProviderEventProcessed).not.toHaveBeenCalled();
  });

  it('marks an authoritatively rejected Onramp session failed without changing a balance', async () => {
    const { processor, repository } = fixture({ verifiedSession: session({
      status: 'rejected', destinationAmountAtomic: null, transactionHash: null,
    }) });
    await processor.process(Buffer.from('{"exact":true}'), 'valid');
    expect(repository.markOnrampFailed).toHaveBeenCalledWith({
      tenantId, fundingId, providerSessionId: 'cos_a', failureCode: 'stripe_onramp_rejected',
    });
    expect(repository.markOnrampAwaitingChain).not.toHaveBeenCalled();
  });

  it.each([
    ['charge.refunded', 'refund'],
    ['charge.dispute.created', 'chargeback'],
  ] as const)('reconciles a signed %s event from trusted funding metadata as %s', async (eventType, kind) => {
    const event = stripeEvent(eventType, { metadata: { meowwa_funding_id: fundingId } });
    const { processor, provider, repository } = fixture({ event });
    await processor.process(Buffer.from('{"exact":true}'), 'valid');
    expect(provider.retrieveSession).not.toHaveBeenCalled();
    expect(repository.recordReconciliation).toHaveBeenCalledWith({
      tenantId, fundingId, kind, evidenceReference: 'stripe:evt_a',
    });
  });

  it.each(['charge.dispute.closed', 'charge.dispute.funds_reinstated'] as const)(
    'acknowledges a %s notification without recording another chargeback',
    async (eventType) => {
      // Each subtype carries its own event id, so recording them all as chargebacks re-flagged
      // already-refunded and already-resolved fundings for review on every later notification.
      const event = stripeEvent(eventType, { metadata: { meowwa_funding_id: fundingId } });
      const { processor, repository } = fixture({ event });
      await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toMatchObject({ handled: true });
      expect(repository.recordReconciliation).not.toHaveBeenCalled();
      expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalled();
    },
  );

  it.each([
    ['won', 'dispute_won'],
    ['lost', 'dispute_lost'],
  ] as const)('records a dispute closed as %s as the %s outcome', async (status, kind) => {
    const event = stripeEvent('charge.dispute.closed', { metadata: { meowwa_funding_id: fundingId }, status });
    const { processor, repository } = fixture({ event });
    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toMatchObject({ handled: true });
    expect(repository.recordReconciliation).toHaveBeenCalledWith({
      tenantId, fundingId, kind, evidenceReference: 'stripe:evt_a',
    });
  });

  it.each(['under_review', 'warning_closed'] as const)(
    'does not invent an outcome for a dispute closed as %s',
    async (status) => {
      // Only 'won' and 'lost' are verdicts. Anything else means the dispute is still live, and
      // guessing would move a funding out of review on Stripe's silence.
      const event = stripeEvent('charge.dispute.closed', { metadata: { meowwa_funding_id: fundingId }, status });
      const { processor, repository } = fixture({ event });
      await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toMatchObject({ handled: true });
      expect(repository.recordReconciliation).not.toHaveBeenCalled();
      expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalled();
    },
  );

  it('records manual review instead of poisoning the webhook when refund evidence arrives for a terminal funding', async () => {
    const event = stripeEvent('charge.refunded', { metadata: { meowwa_funding_id: fundingId } });
    const { processor, repository } = fixture({ event });
    vi.mocked(repository.recordReconciliation).mockRejectedValueOnce(
      new TenantOnrampEvidenceConflictError('provider_terminal_state_conflict', 'stored_status=failed'),
    );

    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toMatchObject({ handled: true });
    expect(vi.mocked(repository.recordReconciliation).mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'manual_review' });
    expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalled();
  });

  it('fails closed before recording an event when Stripe state does not match the stored tenant destination', async () => {
    const { processor, repository } = fixture({ verifiedSession: session({
      metadata: { ...session().metadata, meowwa_tenant_id: '22222222-2222-4222-8222-222222222222' },
    }) });
    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).rejects.toThrow('does not match');
    expect(repository.recordVerifiedProviderEvent).not.toHaveBeenCalled();
    expect(repository.markOnrampAwaitingChain).not.toHaveBeenCalled();
  });

  it('leaves an event unprocessed when its state transition fails so Stripe retry can finish it safely', async () => {
    const first = fixture();
    vi.mocked(first.repository.markOnrampAwaitingChain).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(first.processor.process(Buffer.from('{"exact":true}'), 'valid')).rejects.toThrow('database unavailable');
    expect(first.repository.markVerifiedProviderEventProcessed).not.toHaveBeenCalled();

    const retry = fixture({ duplicate: true, processed: false });
    await expect(retry.processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
      received: true, duplicate: true, handled: true,
    });
    expect(retry.repository.markOnrampAwaitingChain).toHaveBeenCalledOnce();
    expect(retry.repository.markVerifiedProviderEventProcessed).toHaveBeenCalledOnce();
  });

  it.each([
    ['provider_fulfillment_conflict', 'stored_transaction_hash=old;observed_transaction_hash=new', 'markOnrampAwaitingChain'],
    ['multiple_canonical_chain_credits', 'transaction_hash=tx;canonical_match_count=2', 'reconcileRecordedChainCredit'],
  ] as const)('durably reviews a permanent %s and terminally processes its provider event', async (reason, evidence, method) => {
    const { processor, repository } = fixture();
    vi.mocked(repository[method]).mockRejectedValueOnce(new TenantOnrampEvidenceConflictError(reason, evidence));

    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
      received: true, duplicate: false, handled: true,
    });
    expect(repository.recordReconciliation).toHaveBeenCalledWith({
      tenantId, fundingId, kind: 'manual_review',
      evidenceReference: `stripe:evt_a:${reason}:${evidence}`,
    });
    expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalledAfter(
      repository.recordReconciliation as ReturnType<typeof vi.fn>,
    );
  });

  it('leaves a permanent conflict event unprocessed when recording its review evidence transiently fails', async () => {
    const { processor, repository } = fixture();
    vi.mocked(repository.markOnrampAwaitingChain).mockRejectedValueOnce(new TenantOnrampEvidenceConflictError(
      'provider_fulfillment_conflict',
      'stored_transaction_hash=old;observed_transaction_hash=new',
    ));
    vi.mocked(repository.recordReconciliation).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).rejects.toThrow('database unavailable');
    expect(repository.markVerifiedProviderEventProcessed).not.toHaveBeenCalled();
  });

  it('durably reviews a rejected event that contradicts previously recorded fulfillment', async () => {
    const { processor, repository } = fixture({
      verifiedSession: session({ status: 'rejected', destinationAmountAtomic: null, transactionHash: null }),
      transaction: funding({
        reconciliationStatus: 'awaiting_chain', transactionHash, destinationAmountAtomic: '24000000',
      }),
    });
    vi.mocked(repository.markOnrampFailed).mockRejectedValueOnce(new TenantOnrampEvidenceConflictError(
      'provider_terminal_state_conflict',
      'stored_status=pending;stored_reconciliation=awaiting_chain;observed_status=rejected',
    ));

    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
      received: true, duplicate: false, handled: true,
    });
    expect(repository.recordReconciliation).toHaveBeenCalledWith({
      tenantId,
      fundingId,
      kind: 'manual_review',
      evidenceReference: 'stripe:evt_a:provider_terminal_state_conflict:' +
        'stored_status=pending;stored_reconciliation=awaiting_chain;observed_status=rejected',
    });
    expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalledAfter(
      repository.recordReconciliation as ReturnType<typeof vi.fn>,
    );
  });

  it('bounds durable conflict evidence even for maximum-length provider identifiers and amounts', async () => {
    const eventId = `evt_${'a'.repeat(251)}`;
    const maximumAmount = '9'.repeat(78);
    const observedHash = `0x${'b'.repeat(64)}`;
    const evidence = `stored_tx=${transactionHash};stored_amount=${maximumAmount};` +
      `observed_tx=${observedHash};observed_amount=${maximumAmount}`;
    const { processor, repository } = fixture({ event: {
      ...stripeEvent(), id: eventId,
    } as Stripe.Event });
    vi.mocked(repository.markOnrampAwaitingChain).mockRejectedValueOnce(new TenantOnrampEvidenceConflictError(
      'provider_fulfillment_conflict', evidence,
    ));

    await processor.process(Buffer.from('{"exact":true}'), 'valid');
    const reference = vi.mocked(repository.recordReconciliation).mock.calls[0]?.[0].evidenceReference;
    expect(reference).toMatch(/^stripe:event_sha256=[0-9a-f]{64}:provider_fulfillment_conflict:/);
    expect(reference?.length).toBeLessThanOrEqual(512);
    expect(reference).toContain(evidence);
  });

  it('lowercases a checksummed Base settlement hash before it reaches the ledger', async () => {
    const checksummed = `0x${'2'.repeat(32)}${'A'.repeat(32)}`;
    const { processor, repository } = fixture({ verifiedSession: session({ transactionHash: checksummed }) });
    await processor.process(Buffer.from('{"exact":true}'), 'valid');
    expect(repository.markOnrampAwaitingChain).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: checksummed.toLowerCase() }));
    expect(repository.reconcileRecordedChainCredit).toHaveBeenCalledWith(expect.objectContaining({ chainKey: 'base', transactionHash: checksummed.toLowerCase() }));
  });

  describe('Solana rail', () => {
    it('uses fixtures of the shapes Solana actually produces', () => {
      expect(isSolanaAddress(solanaWalletAddress)).toBe(true);
      expect(isSolanaAddress(caseFlippedSolanaAddress)).toBe(true);
      expect(caseFlippedSolanaAddress).not.toBe(solanaWalletAddress);
      expect(isSolanaSignature(solanaSignature)).toBe(true);
      expect(solanaSignature).toHaveLength(88);
      expect(otherSolanaSignature).toHaveLength(88);
    });

    it('moves a completed Solana session to chain confirmation with the signature kept verbatim', async () => {
      const { processor, repository } = fixture({ verifiedSession: solanaSession(), transaction: solanaFunding() });
      await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
        received: true, duplicate: false, handled: true,
      });
      expect(repository.markOnrampAwaitingChain).toHaveBeenCalledWith({
        tenantId,
        fundingId,
        providerSessionId: 'cos_a',
        transactionHash: solanaSignature,
        destinationAmountAtomic: '24000000',
      });
      expect(repository.reconcileRecordedChainCredit).toHaveBeenCalledWith({
        tenantId,
        fundingId,
        walletId: 'wallet_a',
        chainKey: 'solana',
        transactionHash: solanaSignature,
        destinationAmountAtomic: '24000000',
      });
      expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalledOnce();
    });

    it('marks a rejected Solana session failed without changing a balance', async () => {
      const { processor, repository } = fixture({
        verifiedSession: solanaSession({ status: 'rejected', destinationAmountAtomic: null, transactionHash: null }),
        transaction: solanaFunding(),
      });
      await processor.process(Buffer.from('{"exact":true}'), 'valid');
      expect(repository.markOnrampFailed).toHaveBeenCalledWith({
        tenantId, fundingId, providerSessionId: 'cos_a', failureCode: 'stripe_onramp_rejected',
      });
      expect(repository.markOnrampAwaitingChain).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'a Solana session for a Base funding', verifiedSession: solanaSession(), transaction: funding() },
      { label: 'a Base session for a Solana funding', verifiedSession: session(), transaction: solanaFunding() },
      { label: 'a Solana session naming the Base network', verifiedSession: solanaSession({ destinationNetwork: 'base' }), transaction: solanaFunding() },
      { label: 'a Base session naming the Solana network', verifiedSession: session({ destinationNetwork: 'solana' }), transaction: funding() },
      { label: 'a Solana session for a wallet differing only by letter case', verifiedSession: solanaSession({ walletAddress: caseFlippedSolanaAddress }), transaction: solanaFunding() },
      { label: 'a Solana session carrying an EVM hash', verifiedSession: solanaSession({ transactionHash }), transaction: solanaFunding() },
      { label: 'a Base session carrying a Solana signature', verifiedSession: session({ transactionHash: solanaSignature }), transaction: funding() },
      { label: 'a Solana funding row stamped with an EVM chain id', verifiedSession: solanaSession(), transaction: solanaFunding({ chainId: 8453 }) },
      { label: 'a Base funding row missing its chain id', verifiedSession: session(), transaction: funding({ chainId: null }) },
    ])('fails closed before recording an event for $label', async ({ verifiedSession, transaction }) => {
      const { processor, repository } = fixture({ verifiedSession, transaction });
      await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).rejects.toThrow('does not match');
      expect(repository.recordVerifiedProviderEvent).not.toHaveBeenCalled();
      expect(repository.markOnrampAwaitingChain).not.toHaveBeenCalled();
      expect(repository.markOnrampFailed).not.toHaveBeenCalled();
    });

    it('durably reviews a Solana fulfillment conflict with the signatures kept verbatim in the evidence', async () => {
      const evidence = `stored_transaction_hash=${otherSolanaSignature};observed_transaction_hash=${solanaSignature}`;
      const { processor, repository } = fixture({ verifiedSession: solanaSession(), transaction: solanaFunding() });
      vi.mocked(repository.markOnrampAwaitingChain).mockRejectedValueOnce(new TenantOnrampEvidenceConflictError(
        'provider_fulfillment_conflict', evidence,
      ));
      await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
        received: true, duplicate: false, handled: true,
      });
      expect(repository.recordReconciliation).toHaveBeenCalledWith({
        tenantId, fundingId, kind: 'manual_review',
        evidenceReference: `stripe:evt_a:provider_fulfillment_conflict:${evidence}`,
      });
    });

    it('bounds durable conflict evidence for a maximum-length event id with 88-character signatures and amounts', async () => {
      const eventId = `evt_${'a'.repeat(251)}`;
      const maximumAmount = '9'.repeat(78);
      const evidence = `stored_tx=${otherSolanaSignature};stored_amount=${maximumAmount};` +
        `observed_tx=${solanaSignature};observed_amount=${maximumAmount}`;
      const { processor, repository } = fixture({
        event: { ...stripeEvent(), id: eventId } as Stripe.Event,
        verifiedSession: solanaSession(), transaction: solanaFunding(),
      });
      vi.mocked(repository.markOnrampAwaitingChain).mockRejectedValueOnce(new TenantOnrampEvidenceConflictError(
        'provider_fulfillment_conflict', evidence,
      ));

      await processor.process(Buffer.from('{"exact":true}'), 'valid');
      const reference = vi.mocked(repository.recordReconciliation).mock.calls[0]?.[0].evidenceReference;
      expect(reference).toMatch(/^stripe:event_sha256=[0-9a-f]{64}:provider_fulfillment_conflict:/);
      expect(reference?.length).toBeLessThanOrEqual(512);
      // The signatures survive verbatim (case intact) in the bounded reference.
      expect(reference).toContain(evidence);
    });

    it('digests evidence that no longer fits beside the event digest once Solana signatures lengthen it', async () => {
      const eventId = `evt_${'a'.repeat(251)}`;
      const signatures = Array.from({ length: 5 }, (_, index) => encodeBase58(new Uint8Array(64).fill(250 - index)));
      const evidence = `transaction_hash=${solanaSignature};canonical_match_count=${signatures.length};` +
        signatures.map((signature, index) => `candidate_${index}=${signature}`).join(';');
      expect(`stripe:event_sha256=${'0'.repeat(64)}:multiple_canonical_chain_credits:${evidence}`.length).toBeGreaterThan(512);
      const { processor, repository } = fixture({
        event: { ...stripeEvent(), id: eventId } as Stripe.Event,
        verifiedSession: solanaSession(), transaction: solanaFunding(),
      });
      vi.mocked(repository.reconcileRecordedChainCredit).mockRejectedValueOnce(new TenantOnrampEvidenceConflictError(
        'multiple_canonical_chain_credits', evidence,
      ));

      await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toMatchObject({ handled: true });
      const reference = vi.mocked(repository.recordReconciliation).mock.calls[0]?.[0].evidenceReference;
      expect(reference).toMatch(/^stripe:event_sha256=[0-9a-f]{64}:multiple_canonical_chain_credits:evidence_sha256=[0-9a-f]{64}$/);
      expect(reference?.length).toBeLessThanOrEqual(512);
      expect(repository.markVerifiedProviderEventProcessed).toHaveBeenCalledAfter(
        repository.recordReconciliation as ReturnType<typeof vi.fn>,
      );
    });
  });

  it('acknowledges an irrelevant signed event without assigning it to a tenant', async () => {
    const { processor, repository } = fixture({ event: stripeEvent('customer.updated', { id: 'cus_a' }) });
    await expect(processor.process(Buffer.from('{"exact":true}'), 'valid')).resolves.toEqual({
      received: true, duplicate: false, handled: false,
    });
    expect(repository.resolveFundingTenant).not.toHaveBeenCalled();
    expect(repository.recordVerifiedProviderEvent).not.toHaveBeenCalled();
  });
});
