import { createHash } from 'node:crypto';
import type { WalletAdapter, PaymentIntent, WalletSubmission } from '../adapters/wallet.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  buildAgentSignerPolicy,
  evaluateAgentTransfer,
  parseUsdcAmountAtomic,
  policyDigest,
  type PrivyAgentSignerPolicy,
} from '../wallet-control/policy.js';
import type { WalletControlBinding } from '../wallet-control/types.js';
import { buildSandboxTransferIntent } from './intent.js';
import type { WalletExecutionProvider } from './provider.js';
import { SubmissionConflictError, WalletExecutionRepository } from './repository.js';
import type { SandboxAuthorizationSigner } from './signer.js';
import { EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';

export interface WalletControlVerifier {
  verify(ownerId: string, petId: string): Promise<WalletControlBinding>;
}

function safeFailure(reason: string): Extract<WalletSubmission, { status: 'failed' }> {
  return { status: 'failed', reason };
}

function pending(referenceId: string): Extract<WalletSubmission, { status: 'pending' }> {
  return { status: 'pending', submissionId: referenceId };
}

function submissionId(referenceId: string): string {
  return `wex_${createHash('sha256').update(referenceId).digest('hex').slice(0, 32)}`;
}

function condition(policy: PrivyAgentSignerPolicy, field: string): Record<string, unknown> | undefined {
  const found = policy.rules[0]?.conditions.find((item) => item.field === field);
  return found as unknown as Record<string, unknown> | undefined;
}

function policyConfig(binding: WalletControlBinding): {
  ownerPrivyUserId: string;
  petId: string;
  allowedRecipients: string[];
  perTransactionLimitAtomic: string;
  validUntil: string;
} | undefined {
  let policy: PrivyAgentSignerPolicy;
  try { policy = JSON.parse(binding.expectedPolicyJson) as PrivyAgentSignerPolicy; } catch { return undefined; }
  if (!policy || typeof policy !== 'object' || policyDigest(policy) !== binding.expectedPolicyDigest ||
      policy.owner?.user_id !== binding.privyUserId || policy.rules.length !== 1) return undefined;
  const recipients = condition(policy, 'destination.address')?.value;
  const limitDecimal = condition(policy, 'source.amount')?.value;
  const expirySeconds = condition(policy, 'current_unix_timestamp')?.value;
  if (!Array.isArray(recipients) || recipients.some((item) => typeof item !== 'string') ||
      typeof limitDecimal !== 'string' || typeof expirySeconds !== 'string' || !/^[1-9][0-9]*$/.test(expirySeconds)) return undefined;
  let limit: string;
  try { limit = parseUsdcAmountAtomic(limitDecimal); } catch { return undefined; }
  const validUntilMs = Number(expirySeconds) * 1000;
  if (!Number.isSafeInteger(validUntilMs)) return undefined;
  const config = {
    ownerPrivyUserId: binding.privyUserId,
    petId: binding.petId,
    allowedRecipients: recipients as string[],
    perTransactionLimitAtomic: limit,
    validUntil: new Date(validUntilMs).toISOString(),
  };
  try {
    if (policyDigest(buildAgentSignerPolicy(config)) !== binding.expectedPolicyDigest) return undefined;
  } catch {
    return undefined;
  }
  return config;
}

export class PrivySandboxWalletAdapter implements WalletAdapter {
  readonly #repository: WalletExecutionRepository;
  readonly #walletControl: WalletControlVerifier;
  readonly #provider: WalletExecutionProvider;
  readonly #signer: SandboxAuthorizationSigner;
  readonly #allowedRecipients: Set<string>;
  readonly #maxBindingAgeMs: number;
  readonly #now: () => Date;

  constructor(options: {
    repository: WalletExecutionRepository;
    walletControl: WalletControlVerifier;
    provider: WalletExecutionProvider;
    signer: SandboxAuthorizationSigner;
    allowedRecipients: string[];
    maxBindingAgeMs: number;
    now?: () => Date;
  }) {
    if (!Number.isSafeInteger(options.maxBindingAgeMs) || options.maxBindingAgeMs < 1_000 || options.maxBindingAgeMs > 300_000) {
      throw new Error('Invalid wallet binding verification age');
    }
    const recipients = options.allowedRecipients.map((item) => {
      if (!EVM_ADDRESS_PATTERN.test(item) || item.toLowerCase() === '0x0000000000000000000000000000000000000000') {
        throw new Error('Invalid execution recipient');
      }
      return item.toLowerCase();
    });
    if (recipients.length === 0) throw new Error('At least one execution recipient is required');
    this.#repository = options.repository;
    this.#walletControl = options.walletControl;
    this.#provider = options.provider;
    this.#signer = options.signer;
    this.#allowedRecipients = new Set(recipients);
    this.#maxBindingAgeMs = options.maxBindingAgeMs;
    this.#now = options.now ?? (() => new Date());
  }

  async submit(payment: PaymentIntent): Promise<WalletSubmission> {
    const now = this.#now();
    let transfer;
    try {
      transfer = buildSandboxTransferIntent(payment, now);
    } catch {
      return safeFailure('EXECUTION_PREFLIGHT_DENIED');
    }

    let binding: WalletControlBinding;
    try {
      binding = await this.#walletControl.verify(payment.ownerId, payment.petId);
    } catch {
      return safeFailure('WALLET_CONTROL_UNVERIFIED');
    }
    const config = policyConfig(binding);
    const verifiedAt = binding.lastVerifiedAt === null ? Number.NaN : Date.parse(binding.lastVerifiedAt);
    const age = now.getTime() - verifiedAt;
    const structurallyValid =
      binding.ownerId === payment.ownerId && binding.petId === payment.petId && binding.environment === 'sandbox' &&
      binding.chainId === BASE_SEPOLIA_CHAIN_ID && binding.usdcContract.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase() &&
      binding.smartWalletType === 'embedded_hd' && binding.ownerType === 'privy_user' && ['active', 'recovered'].includes(binding.status) &&
      binding.signerStatus === 'attached' && binding.agentPolicyId !== null && binding.privyEmbeddedWalletId !== null &&
      binding.smartWalletAddress !== null && EVM_ADDRESS_PATTERN.test(binding.smartWalletAddress) &&
      Number.isFinite(verifiedAt) && age >= -5_000 && age <= this.#maxBindingAgeMs;
    if (!structurallyValid || !config || !this.#allowedRecipients.has(transfer.recipient)) {
      return safeFailure('WALLET_CONTROL_DENIED');
    }
    const localDecision = evaluateAgentTransfer(config, {
      method: 'transfer', chainId: transfer.chainId, to: transfer.usdcContract,
      valueAtomic: transfer.valueAtomic, functionName: 'transfer', recipient: transfer.recipient,
      amountAtomic: transfer.amountAtomic,
    }, now);
    if (!localDecision.allowed) return safeFailure('AGENT_POLICY_DENIED');

    const referenceId = transfer.referenceId;
    let submission;
    try {
      submission = this.#repository.prepare({
        submissionId: submissionId(referenceId), requestId: transfer.requestId, ownerId: transfer.ownerId,
        petId: transfer.petId, bindingId: binding.bindingId, providerWalletId: binding.privyEmbeddedWalletId!,
        intentHash: transfer.intentHash, referenceId,
        chainId: transfer.chainId, contract: transfer.usdcContract, sender: binding.smartWalletAddress!,
        recipient: transfer.recipient, amountAtomic: transfer.amountAtomic, valueAtomic: transfer.valueAtomic,
        calldata: transfer.calldata,
      });
    } catch (error) {
      if (error instanceof SubmissionConflictError) return safeFailure('SUBMISSION_IDENTITY_CONFLICT');
      return safeFailure('SUBMISSION_PREPARE_FAILED');
    }

    if (submission.status === 'failed' || submission.status === 'review_required') return safeFailure('SUBMISSION_PREVIOUSLY_FAILED');
    const replayableUnknown = submission.status === 'unknown' && submission.providerTransactionId === null;
    if (!['prepared', 'submitting'].includes(submission.status) && !replayableUnknown) return pending(referenceId);
    if (submission.status === 'prepared') {
      try {
        submission = this.#repository.markSubmitting(submission.submissionId, submission.version);
      } catch {
        return pending(referenceId);
      }
    }

    let result;
    try {
      result = await this.#provider.submit({
        embeddedWalletId: binding.privyEmbeddedWalletId!, smartWalletAddress: binding.smartWalletAddress!,
        caip2: transfer.caip2, contract: transfer.usdcContract, calldata: transfer.calldata,
        referenceId, sign: this.#signer.sign,
      });
    } catch {
      this.#markUnknownIfSubmitting(submission.submissionId, 'provider-outcome-unknown');
      return pending(referenceId);
    }
    try {
      this.#repository.markSubmitted(submission.submissionId, submission.version, result);
    } catch {
      this.#markUnknownIfSubmitting(submission.submissionId, 'provider-response-persistence-conflict');
    }
    return pending(referenceId);
  }

  #markUnknownIfSubmitting(submissionIdValue: string, reason: string): void {
    try {
      const current = this.#repository.getById(submissionIdValue);
      if (current?.status === 'submitting') this.#repository.markUnknown(current.submissionId, current.version, reason);
    } catch {
      // A concurrent reconciler may already have advanced the durable record.
    }
  }
}
