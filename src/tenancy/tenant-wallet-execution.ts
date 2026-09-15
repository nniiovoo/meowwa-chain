import { createHash } from 'node:crypto';
import type { PaymentIntent, WalletAdapter, WalletSubmission } from '../adapters/wallet.js';
import { paymentIntentDigest } from '../adapters/wallet.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  buildAgentSignerPolicy,
  evaluateAgentTransfer,
} from '../wallet-control/policy.js';
import type { WalletControlAttestationProvider } from '../wallet-control/provider.js';
import { buildSandboxTransferIntent } from '../wallet-execution/intent.js';
import type { WalletExecutionProvider } from '../wallet-execution/provider.js';
import type { SandboxAuthorizationSigner } from '../wallet-execution/signer.js';
import { isCanonicalTenantId } from '../auth.js';
import type { TenantWalletBinding } from './financial-repository.js';

export type TenantWalletExecutionStatus =
  | 'prepared'
  | 'submitting'
  | 'submitted'
  | 'provider_confirmed'
  | 'confirmed'
  | 'unknown'
  | 'failed'
  | 'review_required';

export interface TenantWalletExecutionSubmission {
  tenantId: string;
  submissionId: string;
  requestId: string;
  ownerSubject: string;
  petId: string;
  walletId: string;
  providerWalletId: string;
  ownerQuorumId: string;
  agentSignerId: string;
  agentPolicyId: string;
  policyDigest: string;
  policyValidUntil: string;
  controlVerifiedAt: string;
  intentHash: string;
  referenceId: string;
  /** Agent execution stays on the Base Sepolia control plane; a Solana execution rail is deferred. */
  chainKey: 'base_sepolia';
  chainId: 84532;
  contract: string;
  sender: string;
  recipient: string;
  amountAtomic: string;
  valueAtomic: '0';
  calldata: `0x${string}`;
  status: TenantWalletExecutionStatus;
  providerTransactionId: string | null;
  userOperationHash: `0x${string}` | null;
  transactionHash: `0x${string}` | null;
  blockHash: `0x${string}` | null;
  blockNumber: number | null;
  logIndex: number | null;
  failureCode: string | null;
  confirmedAt: string | null;
  applicationSettledAt: string | null;
  /** Blind re-submissions already attempted: replays with no provider transaction id to poll. */
  blindSubmitAttempts: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type PrepareTenantWalletExecutionInput = Omit<TenantWalletExecutionSubmission,
  | 'status'
  | 'providerTransactionId'
  | 'userOperationHash'
  | 'transactionHash'
  | 'blockHash'
  | 'blockNumber'
  | 'logIndex'
  | 'failureCode'
  | 'confirmedAt'
  | 'applicationSettledAt'
  | 'blindSubmitAttempts'
  | 'createdAt'
  | 'updatedAt'
  | 'version'
>;

export class TenantWalletExecutionConflictError extends Error {
  constructor(message = 'Tenant wallet execution conflicts with an existing submission') {
    super(message);
    this.name = 'TenantWalletExecutionConflictError';
  }
}

export interface TenantWalletExecutionRepository {
  getVerifiedBinding(tenantId: string, petId: string): Promise<TenantWalletBinding | undefined>;
  prepareExecution(input: PrepareTenantWalletExecutionInput): Promise<TenantWalletExecutionSubmission>;
  markExecutionSubmitting(tenantId: string, submissionId: string, expectedVersion: number): Promise<TenantWalletExecutionSubmission>;
  markExecutionSubmitted(input: {
    tenantId: string;
    submissionId: string;
    expectedVersion: number;
    providerTransactionId: string;
    userOperationHash: `0x${string}` | null;
    transactionHash: `0x${string}` | null;
  }): Promise<TenantWalletExecutionSubmission>;
  markExecutionUnknown(tenantId: string, submissionId: string, expectedVersion: number, reason: string): Promise<TenantWalletExecutionSubmission>;
}

function validIdentifier(value: string, maximum = 255): boolean {
  return value.length > 0 && value.length <= maximum && value.trim() === value;
}

function submissionId(tenantId: string, referenceId: string): string {
  return `wex_${createHash('sha256').update(`meowwa:tenant-wallet-execution:v1\0${tenantId}\0${referenceId}`).digest('hex').slice(0, 48)}`;
}

function failed(reason: string): Extract<WalletSubmission, { status: 'failed' }> {
  return { status: 'failed', reason };
}

export class TenantWalletExecutionService {
  readonly #allowedRecipients: Set<string>;
  readonly #now: () => Date;

  constructor(private readonly options: {
    repository: TenantWalletExecutionRepository;
    controlProvider: WalletControlAttestationProvider;
    executionProvider: WalletExecutionProvider;
    signer: SandboxAuthorizationSigner;
    agentSignerId: string;
    allowedRecipients: readonly string[];
    perTransactionLimitAtomic: string;
    now?: () => Date;
  }) {
    this.#allowedRecipients = new Set(options.allowedRecipients.map((address) => address.toLowerCase()));
    if (this.#allowedRecipients.size === 0 || [...this.#allowedRecipients].some((address) => !/^0x[0-9a-f]{40}$/.test(address))) {
      throw new Error('Tenant wallet execution recipients are invalid');
    }
    this.#now = options.now ?? (() => new Date());
  }

  async submit(input: { tenantId: string; ownerSubject: string; payment: PaymentIntent }): Promise<WalletSubmission> {
    if (!isCanonicalTenantId(input.tenantId) || !validIdentifier(input.ownerSubject, 512) ||
      input.payment.ownerId !== input.ownerSubject || paymentIntentDigest(input.payment) !== input.payment.intentHash) {
      return failed('EXECUTION_IDENTITY_DENIED');
    }
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) return failed('EXECUTION_PREFLIGHT_DENIED');
    let transfer;
    try { transfer = buildSandboxTransferIntent(input.payment, now, input.tenantId); } catch { return failed('EXECUTION_PREFLIGHT_DENIED'); }
    if (!this.#allowedRecipients.has(transfer.recipient)) return failed('WALLET_CONTROL_DENIED');

    let binding: TenantWalletBinding | undefined;
    try { binding = await this.options.repository.getVerifiedBinding(input.tenantId, input.payment.petId); } catch { /* fail closed below */ }
    const verifiedAt = Date.parse(binding?.controlVerifiedAt ?? '');
    const validUntil = Date.parse(binding?.policyValidUntil ?? '');
    const age = now.getTime() - verifiedAt;
    if (!binding || binding.tenantId !== input.tenantId || binding.status !== 'active' ||
      binding.petId !== input.payment.petId || binding.ownerQuorumId === null ||
      binding.agentSignerId !== this.options.agentSignerId || binding.agentPolicyId === null || binding.policyDigest === null ||
      !Number.isFinite(verifiedAt) || age < -5_000 || binding.ownerPrivyUserId === null ||
      !Number.isFinite(validUntil) || validUntil <= now.getTime()) {
      return failed('WALLET_CONTROL_UNVERIFIED');
    }
    const policyConfig = {
      ownerPrivyUserId: binding.ownerPrivyUserId,
      petId: binding.petId,
      allowedRecipients: [...this.#allowedRecipients],
      perTransactionLimitAtomic: this.options.perTransactionLimitAtomic,
      validUntil: binding.policyValidUntil!,
    };
    const localDecision = evaluateAgentTransfer(policyConfig, {
      method: 'transfer', chainId: transfer.chainId, to: transfer.usdcContract,
      valueAtomic: transfer.valueAtomic, functionName: 'transfer', recipient: transfer.recipient,
      amountAtomic: transfer.amountAtomic,
    }, now);
    if (!localDecision.allowed) return failed('AGENT_POLICY_DENIED');
    let attested = false;
    try {
      attested = await this.options.controlProvider.verifyAttestedControl({
        embeddedWalletId: binding.privyEmbeddedWalletId,
        smartWalletAddress: binding.smartWalletAddress,
        ownerResourceId: binding.ownerQuorumId,
        agentSignerId: binding.agentSignerId,
        agentPolicyId: binding.agentPolicyId,
        expectedPolicy: buildAgentSignerPolicy(policyConfig),
        // The provisioning owner identity, so the key quorum is verified against the owner this
        // wallet was actually provisioned for rather than attested on shape alone.
        expectedPrivyUserId: binding.ownerPrivyUserId,
      });
    } catch { /* provider verification failed closed */ }
    if (!attested) return failed('WALLET_CONTROL_UNVERIFIED');

    let submission: TenantWalletExecutionSubmission;
    try {
      submission = await this.options.repository.prepareExecution({
        tenantId: input.tenantId,
        submissionId: submissionId(input.tenantId, transfer.referenceId),
        requestId: transfer.requestId,
        ownerSubject: input.ownerSubject,
        petId: binding.petId,
        walletId: binding.walletId,
        providerWalletId: binding.privyEmbeddedWalletId,
        ownerQuorumId: binding.ownerQuorumId,
        agentSignerId: binding.agentSignerId,
        agentPolicyId: binding.agentPolicyId,
        policyDigest: binding.policyDigest,
        policyValidUntil: binding.policyValidUntil!,
        controlVerifiedAt: binding.controlVerifiedAt!,
        intentHash: transfer.intentHash,
        referenceId: transfer.referenceId,
        chainKey: 'base_sepolia',
        chainId: BASE_SEPOLIA_CHAIN_ID,
        contract: BASE_SEPOLIA_USDC,
        sender: binding.smartWalletAddress,
        recipient: transfer.recipient,
        amountAtomic: transfer.amountAtomic,
        valueAtomic: '0',
        calldata: transfer.calldata,
      });
    } catch (error) {
      return failed(error instanceof TenantWalletExecutionConflictError ? 'SUBMISSION_IDENTITY_CONFLICT' : 'SUBMISSION_PREPARE_FAILED');
    }
    if (submission.status === 'failed' || submission.status === 'review_required') return failed('SUBMISSION_PREVIOUSLY_FAILED');
    const replayableUnknown = submission.status === 'unknown' && submission.providerTransactionId === null;
    if (!['prepared', 'submitting'].includes(submission.status) && !replayableUnknown) {
      return { status: 'pending', submissionId: submission.referenceId };
    }
    if (submission.status === 'prepared') {
      try {
        submission = await this.options.repository.markExecutionSubmitting(input.tenantId, submission.submissionId, submission.version);
      } catch {
        return { status: 'pending', submissionId: submission.referenceId };
      }
    }
    try {
      const provider = await this.options.executionProvider.submit({
        embeddedWalletId: binding.privyEmbeddedWalletId,
        smartWalletAddress: binding.smartWalletAddress,
        caip2: 'eip155:84532', contract: transfer.usdcContract, calldata: transfer.calldata,
        referenceId: transfer.referenceId, sign: this.options.signer.sign,
      });
      await this.options.repository.markExecutionSubmitted({
        tenantId: input.tenantId, submissionId: submission.submissionId, expectedVersion: submission.version,
        providerTransactionId: provider.providerTransactionId,
        userOperationHash: provider.userOperationHash,
        transactionHash: provider.transactionHash,
      });
    } catch {
      try {
        await this.options.repository.markExecutionUnknown(
          input.tenantId, submission.submissionId, submission.version, 'provider-outcome-unknown',
        );
      } catch { /* reconciliation owns an already advanced submission */ }
    }
    return { status: 'pending', submissionId: submission.referenceId };
  }
}

export class ContextualTenantWalletAdapter implements WalletAdapter {
  constructor(
    private readonly currentTenant: () => { tenantId: string; ownerSubject: string },
    private readonly client: { submit(input: { tenantId: string; ownerSubject: string; payment: PaymentIntent }): Promise<WalletSubmission> },
  ) {}

  submit(payment: PaymentIntent): Promise<WalletSubmission> {
    const context = this.currentTenant();
    return this.client.submit({ tenantId: context.tenantId, ownerSubject: context.ownerSubject, payment });
  }
}
