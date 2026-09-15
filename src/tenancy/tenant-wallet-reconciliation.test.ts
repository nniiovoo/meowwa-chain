import { describe, expect, it, vi } from 'vitest';
import { verifyAuthToken } from '../auth.js';
import {
  ChainConfirmationPendingError,
  ChainEvidenceMismatchError,
  type BaseSepoliaExecutionReader,
} from '../wallet-execution/chain.js';
import type { WalletExecutionProvider, WalletExecutionStatusProvider } from '../wallet-execution/provider.js';
import {
  TenantWalletExecutionConflictError,
  type TenantWalletExecutionStatus,
  type TenantWalletExecutionSubmission,
} from './tenant-wallet-execution.js';
import {
  TenantPrivyWebhookProcessor,
  TenantWalletExecutionReconciler,
  TenantWalletSettlementClient,
  type TenantWalletExecutionReconciliationClaim,
  type TenantWalletReconciliationRepository,
} from './tenant-wallet-reconciliation.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const referenceId = `mw_${'a'.repeat(61)}`;
const transactionHash = `0x${'b'.repeat(64)}` as `0x${string}`;
const blockHash = `0x${'c'.repeat(64)}` as `0x${string}`;
const now = new Date('2026-07-17T22:00:00.000Z');

function submission(overrides: Partial<TenantWalletExecutionSubmission> = {}): TenantWalletExecutionSubmission {
  return {
    tenantId, submissionId: 'wex_123', requestId: 'request_123', ownerSubject: 'owner_1',
    petId: 'pet_mochi', walletId: 'wallet_mochi', providerWalletId: 'embedded_mochi',
    ownerQuorumId: 'quorum_owner_123', agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
    policyDigest: 'd'.repeat(64), policyValidUntil: '2026-07-18T22:00:00.000Z',
    controlVerifiedAt: '2026-07-17T20:00:00.000Z', intentHash: 'e'.repeat(64), referenceId,
    chainKey: 'base_sepolia', chainId: 84532, contract: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    sender: '0x1111111111111111111111111111111111111111',
    recipient: '0x2222222222222222222222222222222222222222', amountAtomic: '12990000', valueAtomic: '0',
    calldata: `0x${'f'.repeat(136)}`, status: 'submitted', providerTransactionId: 'privy_tx_123',
    userOperationHash: null, transactionHash: null, blockHash: null, blockNumber: null, logIndex: null,
    failureCode: null, confirmedAt: null, applicationSettledAt: null, blindSubmitAttempts: 0,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 3,
    ...overrides,
  };
}

class MemoryReconciliationRepository implements TenantWalletReconciliationRepository {
  current: TenantWalletExecutionSubmission;
  readonly deliveries = new Map<string, { digest: string; eventType: string; processed: boolean }>();
  readonly evidenceConflicts: string[] = [];
  currentClaim: {
    tenantId: string; submissionId: string; workerId: string; lockedUntil: string; fenceToken: number;
  } | undefined;
  reconciliationNow = now;
  nextFenceToken = 1;

  constructor(initial = submission()) { this.current = initial; }
  async resolveExecutionTenant(input: { referenceId: string | null; providerTransactionId: string }) {
    return input.referenceId === this.current.referenceId || input.providerTransactionId === this.current.providerTransactionId
      ? tenantId : undefined;
  }
  async getExecutionById(inputTenant: string, id: string) {
    return inputTenant === tenantId && id === this.current.submissionId ? this.current : undefined;
  }
  async findExecutionByProviderIdentity() { return this.current; }
  async claimExecutionReconciliation(input: { workerId: string; leaseSeconds: number }) {
    if (this.currentClaim && Date.parse(this.currentClaim.lockedUntil) > this.reconciliationNow.getTime()) return undefined;
    if (!['submitting', 'submitted', 'provider_confirmed', 'unknown'].includes(this.current.status) &&
      !(this.current.status === 'confirmed' && this.current.applicationSettledAt === null)) return undefined;
    this.currentClaim = {
      tenantId,
      submissionId: this.current.submissionId,
      workerId: input.workerId,
      lockedUntil: new Date(this.reconciliationNow.getTime() + input.leaseSeconds * 1000).toISOString(),
      fenceToken: this.nextFenceToken++,
    };
    return this.currentClaim;
  }
  async renewExecutionReconciliationClaim(claim: TenantWalletExecutionReconciliationClaim, leaseSeconds: number) {
    if (!this.exactCurrentClaim(claim) || Date.parse(this.currentClaim!.lockedUntil) <= this.reconciliationNow.getTime()) {
      return false;
    }
    this.currentClaim = {
      ...this.currentClaim!,
      lockedUntil: new Date(this.reconciliationNow.getTime() + leaseSeconds * 1000).toISOString(),
    };
    return true;
  }
  async releaseExecutionReconciliationClaim(claim: {
    tenantId: string; submissionId: string; workerId: string; lockedUntil: string; fenceToken: number;
  }) {
    if (!this.exactCurrentClaim(claim)) return false;
    this.currentClaim = undefined;
    return true;
  }
  async recordExecutionWebhook(input: { deliveryId: string; eventType: string; payloadSha256: string }) {
    const existing = this.deliveries.get(input.deliveryId);
    if (existing) {
      if (existing.digest !== input.payloadSha256 || existing.eventType !== input.eventType) throw new Error('conflict');
      return 'duplicate' as const;
    }
    this.deliveries.set(input.deliveryId, { digest: input.payloadSha256, eventType: input.eventType, processed: false });
    return 'inserted' as const;
  }
  async executionWebhookProcessed(_tenant: string, id: string) { return this.deliveries.get(id)?.processed ?? false; }
  async markExecutionWebhookProcessed(_tenant: string, id: string) { this.deliveries.get(id)!.processed = true; }
  async markExecutionProviderConfirmed(input: {
    expectedVersion: number; providerTransactionId: string; transactionHash: `0x${string}`;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }) {
    // The production transition declares exactly this `allowed` set and throws
    // TenantWalletExecutionConflictError outside it (financial-repository.ts transitionExecution).
    // The double used to accept any status, so a webhook that threw out of the real repository --
    // and was answered 503 and redelivered by svix forever -- looked like an ordinary success here.
    if (!['submitting', 'submitted', 'unknown'].includes(this.current.status)) {
      throw new TenantWalletExecutionConflictError('Tenant wallet execution transition lost a race');
    }
    return this.transition(input.expectedVersion, 'provider_confirmed', {
      providerTransactionId: input.providerTransactionId, transactionHash: input.transactionHash,
    }, input.claim);
  }
  async markExecutionSubmitted(input: {
    expectedVersion: number; providerTransactionId: string;
    userOperationHash: `0x${string}` | null; transactionHash: `0x${string}` | null;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }) {
    return this.transition(input.expectedVersion, 'submitted', {
      providerTransactionId: input.providerTransactionId,
      userOperationHash: input.userOperationHash,
      transactionHash: input.transactionHash,
      failureCode: null,
    }, input.claim);
  }
  async markExecutionUnknown(
    _tenant: string, _id: string, version: number, reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ) {
    return this.transition(version, 'unknown', { failureCode: reason }, claim);
  }
  async markExecutionFailed(
    _tenant: string, _id: string, version: number, reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ) {
    return this.transition(version, 'failed', { failureCode: reason }, claim);
  }
  async recordBlindSubmitAttempt(): Promise<number> {
    if (!this.current) return 0;
    this.current = { ...this.current, blindSubmitAttempts: this.current.blindSubmitAttempts + 1 };
    return this.current.blindSubmitAttempts;
  }

  async markExecutionReviewRequired(
    _tenant: string, _id: string, version: number, reason: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ) {
    return this.transition(version, 'review_required', { failureCode: reason }, claim);
  }
  async recordExecutionEvidenceConflict(
    _tenant: string, _id: string, version: number, reason: string,
  ) {
    this.evidenceConflicts.push(reason);
    return this.transition(version, this.current.status, { failureCode: reason });
  }
  async confirmExecutionChain(input: {
    expectedVersion: number; transactionHash: `0x${string}`; blockHash: `0x${string}`;
    blockNumber: number; logIndex: number; confirmedAt: string;
    claim?: TenantWalletExecutionReconciliationClaim | undefined;
  }) {
    return this.transition(input.expectedVersion, 'confirmed', {
      transactionHash: input.transactionHash, blockHash: input.blockHash, blockNumber: input.blockNumber,
      logIndex: input.logIndex, confirmedAt: input.confirmedAt,
    }, input.claim);
  }
  async markExecutionApplicationSettled(
    _tenant: string, _id: string, version: number, settledAt: string,
    claim?: TenantWalletExecutionReconciliationClaim,
  ) {
    return this.transition(version, 'confirmed', { applicationSettledAt: settledAt }, claim);
  }
  private exactCurrentClaim(claim: TenantWalletExecutionReconciliationClaim): boolean {
    return Boolean(this.currentClaim && this.currentClaim.tenantId === claim.tenantId &&
      this.currentClaim.submissionId === claim.submissionId && this.currentClaim.workerId === claim.workerId &&
      this.currentClaim.fenceToken === claim.fenceToken);
  }
  private transition(
    version: number,
    status: TenantWalletExecutionStatus,
    changes: Partial<TenantWalletExecutionSubmission>,
    claim?: TenantWalletExecutionReconciliationClaim,
  ) {
    if (claim && (!this.exactCurrentClaim(claim) ||
      Date.parse(this.currentClaim!.lockedUntil) <= this.reconciliationNow.getTime())) throw new Error('stale claim');
    if (this.current.version !== version) throw new Error('race');
    this.current = { ...this.current, ...changes, status, version: version + 1 };
    return this.current;
  }
}

function setup(options: {
  repository?: MemoryReconciliationRepository;
  chain?: BaseSepoliaExecutionReader;
  provider?: WalletExecutionStatusProvider;
} = {}) {
  const repository = options.repository ?? new MemoryReconciliationRepository();
  const chain = options.chain ?? { verifyTransfer: vi.fn(async () => ({
    transactionHash, blockHash, blockNumber: 1000, logIndex: 7, confirmedAtBlock: 1012,
  })) };
  const provider: WalletExecutionStatusProvider = options.provider ?? { getTransaction: vi.fn(async () => ({
    providerTransactionId: 'privy_tx_123', providerWalletId: 'embedded_mochi', referenceId,
    caip2: 'eip155:84532', status: 'confirmed' as const, transactionHash,
  })) };
  const settle = vi.fn(async () => undefined);
  const reconciler = new TenantWalletExecutionReconciler({
    repository, provider, chain, confirmations: 12, settle, now: () => now,
    workerId: 'wallet-reconcile-unit', leaseSeconds: 60,
  });
  const verifiedEvent: Record<string, unknown> = {
    type: 'transaction.confirmed', wallet_id: 'embedded_mochi', transaction_id: 'privy_tx_123',
    caip2: 'eip155:84532', reference_id: referenceId, transaction_hash: transactionHash,
  };
  const verifier = { verify: vi.fn(() => verifiedEvent) };
  const processor = new TenantPrivyWebhookProcessor({ verifier, repository, reconciler });
  return { repository, chain, provider, settle, reconciler, verifier, processor, verifiedEvent };
}

describe('tenant wallet execution reconciliation', () => {
  it('accepts a signed exact Privy confirmation, independently verifies chain evidence, and settles once', async () => {
    const harness = setup();
    const raw = Buffer.from(JSON.stringify(harness.verifiedEvent));
    const headers = { 'svix-id': 'msg_123', 'svix-timestamp': '1784325600', 'svix-signature': 'valid' };
    await expect(harness.processor.process(raw, headers)).resolves.toEqual({ received: true, duplicate: false, handled: true });
    await expect(harness.processor.process(raw, headers)).resolves.toEqual({ received: true, duplicate: true, handled: true });
    expect(harness.chain.verifyTransfer).toHaveBeenCalledOnce();
    expect(harness.chain.verifyTransfer).toHaveBeenCalledWith({
      transactionHash, sender: harness.repository.current.sender, recipient: harness.repository.current.recipient,
      amountAtomic: '12990000', confirmations: 12,
    });
    expect(harness.settle).toHaveBeenCalledOnce();
    expect(harness.repository.current).toMatchObject({
      status: 'confirmed', transactionHash, blockHash, blockNumber: 1000, logIndex: 7,
      applicationSettledAt: now.toISOString(),
      blindSubmitAttempts: 0,
    });
  });

  it('quarantines a signed cross-wallet identity mismatch before chain or application settlement', async () => {
    const harness = setup();
    harness.verifier.verify.mockReturnValue({ ...harness.verifiedEvent, wallet_id: 'embedded_attacker' });
    await expect(harness.processor.process(Buffer.from('{}'), {
      'svix-id': 'msg_bad', 'svix-timestamp': '1784325600', 'svix-signature': 'valid',
    })).resolves.toMatchObject({ received: true });
    expect(harness.repository.current).toMatchObject({ status: 'review_required', failureCode: 'provider-evidence-mismatch' });
    expect(harness.chain.verifyTransfer).not.toHaveBeenCalled();
    expect(harness.settle).not.toHaveBeenCalled();
  });

  it('keeps insufficient confirmation depth retryable, then settles from the poller', async () => {
    let ready = false;
    const chain: BaseSepoliaExecutionReader = { verifyTransfer: vi.fn(async () => {
      if (!ready) throw new ChainConfirmationPendingError();
      return { transactionHash, blockHash, blockNumber: 1000, logIndex: 7, confirmedAtBlock: 1012 };
    }) };
    const harness = setup({ chain });
    await harness.processor.process(Buffer.from(JSON.stringify(harness.verifiedEvent)), {
      'svix-id': 'msg_pending', 'svix-timestamp': '1784325600', 'svix-signature': 'valid',
    });
    expect(harness.repository.current).toMatchObject({ status: 'provider_confirmed', applicationSettledAt: null });
    expect(harness.settle).not.toHaveBeenCalled();
    ready = true;
    await expect(harness.reconciler.runBatch()).resolves.toEqual({ attempted: 1, confirmed: 1, reviewRequired: 0 });
    expect(harness.repository.current).toMatchObject({ status: 'confirmed', applicationSettledAt: now.toISOString() });
  });

  it('keeps valid provider evidence retryable when the chain-confirmation database write fails', async () => {
    const repository = new MemoryReconciliationRepository(submission({
      status: 'provider_confirmed', transactionHash, version: 4,
    }));
    vi.spyOn(repository, 'confirmExecutionChain').mockRejectedValueOnce(new Error('serialization failure'));
    const harness = setup({ repository });

    await expect(harness.reconciler.reconcile(tenantId, 'wex_123')).rejects.toThrow('serialization failure');
    expect(repository.current).toMatchObject({ status: 'provider_confirmed', failureCode: null, version: 4 });
    expect(harness.settle).not.toHaveBeenCalled();
  });

  it('stops replaying an ambiguous submission once the blind attempt bound is reached', async () => {
    // The production path has the same duplicate-payment exposure as the singleton reconciler:
    // bound the replays rather than retrying on a timer forever.
    const repository = new MemoryReconciliationRepository(submission({
      status: 'unknown', providerTransactionId: null, version: 4, blindSubmitAttempts: 3,
    }));
    const submissionProvider: WalletExecutionProvider = { submit: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null,
    })) };
    const reconciler = new TenantWalletExecutionReconciler({
      repository,
      provider: { getTransaction: vi.fn() },
      submissionProvider,
      signer: { sign: vi.fn(async () => 'authorization-signature') },
      chain: { verifyTransfer: vi.fn() },
      confirmations: 12,
      settle: vi.fn(),
      now: () => now,
    });

    await expect(reconciler.reconcile(tenantId, 'wex_123')).resolves.toMatchObject({
      status: 'review_required', failureCode: 'blind-submit-attempts-exhausted:3',
    });
    expect(submissionProvider.submit).not.toHaveBeenCalled();
  });

  it('replays a persisted ambiguous submission through the provider idempotency reference', async () => {
    const repository = new MemoryReconciliationRepository(submission({
      status: 'submitting', providerTransactionId: null, version: 4,
    }));
    const submissionProvider: WalletExecutionProvider = { submit: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', userOperationHash: null, transactionHash: null,
    })) };
    const statusProvider: WalletExecutionStatusProvider = { getTransaction: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', providerWalletId: 'embedded_mochi', referenceId,
      caip2: 'eip155:84532', status: 'pending' as const, transactionHash: null,
    })) };
    const reconciler = new TenantWalletExecutionReconciler({
      repository,
      provider: statusProvider,
      submissionProvider,
      signer: { sign: vi.fn(async () => 'authorization-signature') },
      chain: { verifyTransfer: vi.fn() },
      confirmations: 12,
      settle: vi.fn(),
      now: () => now,
    });

    await expect(reconciler.reconcile(tenantId, 'wex_123')).resolves.toMatchObject({
      status: 'submitted', providerTransactionId: 'privy_tx_123', failureCode: null,
    });
    expect(submissionProvider.submit).toHaveBeenCalledWith(expect.objectContaining({
      embeddedWalletId: 'embedded_mochi', referenceId,
    }));
    expect(statusProvider.getTransaction).toHaveBeenCalledOnce();
  });

  it('retries transient chain RPC failures but quarantines deterministic evidence mismatches', async () => {
    const transientRepository = new MemoryReconciliationRepository(submission({
      status: 'provider_confirmed', transactionHash, version: 4,
    }));
    const transient = setup({
      repository: transientRepository,
      chain: { verifyTransfer: vi.fn(async () => { throw new Error('RPC unavailable'); }) },
    });
    await expect(transient.reconciler.reconcile(tenantId, 'wex_123')).rejects.toThrow('RPC unavailable');
    expect(transientRepository.current).toMatchObject({ status: 'provider_confirmed', failureCode: null, version: 4 });

    const mismatchRepository = new MemoryReconciliationRepository(submission({
      status: 'provider_confirmed', transactionHash, version: 4,
    }));
    const mismatch = setup({
      repository: mismatchRepository,
      chain: { verifyTransfer: vi.fn(async () => { throw new ChainEvidenceMismatchError('wrong amount'); }) },
    });
    await expect(mismatch.reconciler.reconcile(tenantId, 'wex_123')).resolves.toMatchObject({
      status: 'review_required', failureCode: 'chain-evidence-mismatch',
    });
  });

  it('retries an application callback failure without resubmitting or losing chain confirmation', async () => {
    const repository = new MemoryReconciliationRepository(submission({
      status: 'confirmed', transactionHash, blockHash, blockNumber: 1000, logIndex: 7,
      confirmedAt: now.toISOString(), applicationSettledAt: null, version: 5,
    }));
    let unavailable = true;
    const settle = vi.fn(async () => {
      if (unavailable) throw new Error('API unavailable');
    });
    const reconciler = new TenantWalletExecutionReconciler({
      repository,
      provider: { getTransaction: vi.fn() },
      chain: { verifyTransfer: vi.fn() },
      confirmations: 12,
      settle,
      now: () => now,
    });
    await expect(reconciler.runBatch()).rejects.toThrow('API unavailable');
    expect(repository.current).toMatchObject({ status: 'confirmed', applicationSettledAt: null, version: 5 });
    unavailable = false;
    await expect(reconciler.runBatch()).resolves.toEqual({ attempted: 1, confirmed: 1, reviewRequired: 0 });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(repository.current).toMatchObject({ status: 'confirmed', applicationSettledAt: now.toISOString(), version: 6 });
  });

  it('does not let one unavailable tenant settlement starve later reconciliation candidates', async () => {
    const harness = setup();
    const settled = submission({ status: 'confirmed', transactionHash, applicationSettledAt: now.toISOString() });
    const firstClaim = {
      tenantId, submissionId: 'wex_first', workerId: 'wallet-reconcile-unit',
      lockedUntil: now.toISOString(), fenceToken: 1,
    };
    const secondClaim = {
      tenantId, submissionId: 'wex_second', workerId: 'wallet-reconcile-unit',
      lockedUntil: now.toISOString(), fenceToken: 2,
    };
    const claim = vi.spyOn(harness.repository, 'claimExecutionReconciliation')
      .mockResolvedValueOnce(firstClaim)
      .mockResolvedValueOnce(secondClaim)
      .mockResolvedValueOnce(undefined);
    const release = vi.spyOn(harness.repository, 'releaseExecutionReconciliationClaim').mockResolvedValue(true);
    const reconcile = vi.spyOn(harness.reconciler, 'reconcile')
      .mockRejectedValueOnce(new Error('first tenant unavailable'))
      .mockResolvedValueOnce(settled);
    await expect(harness.reconciler.runBatch()).rejects.toThrow('first tenant unavailable');
    expect(reconcile).toHaveBeenNthCalledWith(1, tenantId, 'wex_first', firstClaim);
    expect(reconcile).toHaveBeenNthCalledWith(2, tenantId, 'wex_second', secondClaim);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[1]!);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('renews the exact item lease while slow provider work is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const repository = new MemoryReconciliationRepository();
      let providerStarted!: () => void;
      let completeProvider!: (value: {
        providerTransactionId: string; providerWalletId: string; referenceId: string;
        caip2: string; status: 'pending'; transactionHash: null;
      }) => void;
      const started = new Promise<void>((resolve) => { providerStarted = resolve; });
      const providerResult = new Promise<{
        providerTransactionId: string; providerWalletId: string; referenceId: string;
        caip2: string; status: 'pending'; transactionHash: null;
      }>((resolve) => { completeProvider = resolve; });
      const reconciler = new TenantWalletExecutionReconciler({
        repository,
        provider: { getTransaction: vi.fn(async () => { providerStarted(); return providerResult; }) },
        chain: { verifyTransfer: vi.fn() },
        confirmations: 12,
        settle: vi.fn(),
        workerId: 'wallet-reconcile-slow',
        leaseSeconds: 5,
        now: () => now,
      });
      const renew = vi.spyOn(repository, 'renewExecutionReconciliationClaim');
      const running = reconciler.runBatch(1);
      await started;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(renew).toHaveBeenCalledOnce();
      completeProvider({
        providerTransactionId: 'privy_tx_123', providerWalletId: 'embedded_mochi', referenceId,
        caip2: 'eip155:84532', status: 'pending', transactionHash: null,
      });
      await expect(running).resolves.toEqual({ attempted: 1, confirmed: 0, reviewRequired: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents a second replica from claiming until the exact claim is released or expires', async () => {
    const repository = new MemoryReconciliationRepository();
    const first = await repository.claimExecutionReconciliation({
      workerId: 'wallet-reconcile-a', leaseSeconds: 60,
    });
    expect(first).toBeDefined();
    await expect(repository.claimExecutionReconciliation({
      workerId: 'wallet-reconcile-b', leaseSeconds: 60,
    })).resolves.toBeUndefined();
    await expect(repository.releaseExecutionReconciliationClaim({
      ...first!, workerId: 'wallet-reconcile-b',
    })).resolves.toBe(false);
    await expect(repository.releaseExecutionReconciliationClaim(first!)).resolves.toBe(true);

    const releasedClaim = await repository.claimExecutionReconciliation({
      workerId: 'wallet-reconcile-b', leaseSeconds: 60,
    });
    expect(releasedClaim).toMatchObject({ workerId: 'wallet-reconcile-b', fenceToken: 2 });
    repository.reconciliationNow = new Date(Date.parse(releasedClaim!.lockedUntil) + 1);
    const expiredClaim = await repository.claimExecutionReconciliation({
      workerId: 'wallet-reconcile-a', leaseSeconds: 60,
    });
    expect(expiredClaim).toMatchObject({ workerId: 'wallet-reconcile-a', fenceToken: 3 });
    await expect(repository.markExecutionUnknown(
      tenantId, 'wex_123', repository.current.version, 'stale-worker', releasedClaim,
    )).rejects.toThrow('stale claim');
    await expect(repository.markExecutionUnknown(
      tenantId, 'wex_123', repository.current.version, 'current-worker', expiredClaim,
    )).resolves.toMatchObject({ status: 'unknown', failureCode: 'current-worker' });
  });

  it('acknowledges malformed late confirmation evidence without reopening a terminal execution', async () => {
    const repository = new MemoryReconciliationRepository(submission({
      status: 'confirmed', transactionHash, blockHash, blockNumber: 1000, logIndex: 7,
      confirmedAt: now.toISOString(), applicationSettledAt: now.toISOString(), version: 6,
    }));
    const harness = setup({ repository });
    harness.verifier.verify.mockReturnValue({ ...harness.verifiedEvent, transaction_hash: null });
    await expect(harness.processor.process(Buffer.from('{}'), {
      'svix-id': 'msg_late_bad', 'svix-timestamp': '1784325600', 'svix-signature': 'valid',
    })).resolves.toEqual({ received: true, duplicate: false, handled: true });
    expect(repository.current).toMatchObject({ status: 'confirmed', applicationSettledAt: now.toISOString(), version: 6 });
    expect(repository.deliveries.get('msg_late_bad')?.processed).toBe(true);
    expect(harness.chain.verifyTransfer).not.toHaveBeenCalled();
    expect(harness.settle).not.toHaveBeenCalled();
  });

  it.each([
    ['confirmed', transactionHash, 'provider-transaction-hash-conflict'],
    ['failed', null, 'provider-confirmation-after-failure'],
  ] as const)('durably records a signed confirmation conflict against a terminal %s execution', async (
    status, storedHash, reason,
  ) => {
    const repository = new MemoryReconciliationRepository(submission({
      status, transactionHash: storedHash,
      ...(status === 'confirmed' ? {
        blockHash, blockNumber: 1000, logIndex: 7, confirmedAt: now.toISOString(),
        applicationSettledAt: now.toISOString(),
        blindSubmitAttempts: 0,
      } : { failureCode: 'provider-execution-reverted' }),
      version: 6,
    }));
    const harness = setup({ repository });
    harness.verifier.verify.mockReturnValue({
      ...harness.verifiedEvent,
      transaction_hash: `0x${'1'.repeat(64)}`,
    });

    await expect(harness.processor.process(Buffer.from('{}'), {
      'svix-id': `msg_terminal_${status}`, 'svix-timestamp': '1784325600', 'svix-signature': 'valid',
    })).resolves.toEqual({ received: true, duplicate: false, handled: true });

    expect(repository.current).toMatchObject({ status, failureCode: reason, version: 7 });
    expect(repository.evidenceConflicts).toEqual([reason]);
    expect(repository.deliveries.get(`msg_terminal_${status}`)?.processed).toBe(true);
    expect(harness.chain.verifyTransfer).not.toHaveBeenCalled();
    expect(harness.settle).not.toHaveBeenCalled();
  });

  // A quarantined submission is a permanent local state, not a provider outage. The singleton
  // reconciler already no-ops here; this twin special-cased only `failed`, so a confirmation
  // arriving for a submission already in review_required threw out of the signed webhook, the route
  // answered 503 'Privy event processing is temporarily unavailable', the delivery was never marked
  // processed, and svix redelivered it on its full retry schedule forever -- re-running signature
  // verification, tenant resolution and a SELECT ... FOR UPDATE each time, under a label naming the
  // wrong cause. Reachable from every review reason that can precede the webhook: a reorged receipt,
  // a replaced provider transaction, blind submits exhausted, a signed identity mismatch.
  it.each(['review_required', 'prepared'] as const)(
    'acknowledges a signed confirmation for a %s execution instead of reporting a provider outage',
    async (status) => {
      const repository = new MemoryReconciliationRepository(submission({
        status, failureCode: status === 'review_required' ? 'chain-evidence-mismatch' : null, version: 6,
      }));
      const harness = setup({ repository });

      await expect(harness.processor.process(Buffer.from('{}'), {
        'svix-id': `msg_quarantined_${status}`, 'svix-timestamp': '1784325600', 'svix-signature': 'valid',
      })).resolves.toEqual({ received: true, duplicate: false, handled: true });

      expect(repository.current).toMatchObject({ status, version: 6 });
      expect(repository.deliveries.get(`msg_quarantined_${status}`)?.processed).toBe(true);
      expect(repository.evidenceConflicts).toEqual([]);
      expect(harness.chain.verifyTransfer).not.toHaveBeenCalled();
      expect(harness.settle).not.toHaveBeenCalled();
    },
  );

  it('leaves a terminal confirmation conflict delivery retryable when conflict persistence fails', async () => {
    const repository = new MemoryReconciliationRepository(submission({
      status: 'confirmed', transactionHash, blockHash, blockNumber: 1000, logIndex: 7,
      confirmedAt: now.toISOString(), applicationSettledAt: now.toISOString(), version: 6,
    }));
    vi.spyOn(repository, 'recordExecutionEvidenceConflict')
      .mockRejectedValueOnce(new Error('wallet conflict database unavailable'));
    const harness = setup({ repository });
    harness.verifier.verify.mockReturnValue({
      ...harness.verifiedEvent,
      transaction_hash: `0x${'1'.repeat(64)}`,
    });

    await expect(harness.processor.process(Buffer.from('{}'), {
      'svix-id': 'msg_terminal_write_failure', 'svix-timestamp': '1784325600', 'svix-signature': 'valid',
    })).rejects.toThrow('wallet conflict database unavailable');
    expect(repository.deliveries.get('msg_terminal_write_failure')?.processed).toBe(false);
  });

  it('marks a provider-declared terminal failure without creating chain or settlement evidence', async () => {
    const provider: WalletExecutionStatusProvider = { getTransaction: vi.fn(async () => ({
      providerTransactionId: 'privy_tx_123', providerWalletId: 'embedded_mochi', referenceId,
      caip2: 'eip155:84532', status: 'execution_reverted' as const, transactionHash: null,
    })) };
    const harness = setup({ provider });
    await expect(harness.reconciler.reconcile(tenantId, 'wex_123')).resolves.toMatchObject({
      status: 'failed', failureCode: 'provider-execution-reverted',
    });
    expect(harness.chain.verifyTransfer).not.toHaveBeenCalled();
    expect(harness.settle).not.toHaveBeenCalled();
  });

  it('sends a tenant-bound, narrowly scoped settlement credential and exact evidence', async () => {
    const authSecret = 'unit-test-wallet-settlement-secret-is-distinct-and-strong';
    let request: RequestInit | undefined;
    let responseCancelled = false;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"settled":true}')); },
        cancel() { responseCancelled = true; },
      }), { status: 200 });
    });
    const client = new TenantWalletSettlementClient({
      baseUrl: 'https://api.internal.example', authSecret, requestTimeoutMs: 5000, fetch: fetcher as typeof fetch,
    });
    await client.settle(submission({ status: 'confirmed', transactionHash }));
    const token = new Headers(request?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    expect(verifyAuthToken(token, authSecret, Date.now(), { requireTenant: true })).toMatchObject({
      type: 'service', subject: 'wallet_execution_worker', tenantId, ownerId: 'owner_1',
      scopes: ['wallet-execution-reconcile'],
    });
    expect(JSON.parse(String(request?.body))).toEqual({ requestId: 'request_123', transactionHash, submissionId: referenceId });
    expect(responseCancelled).toBe(true);
  });
});
