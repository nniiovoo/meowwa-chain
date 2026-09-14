import { createHash } from 'node:crypto';
import { buildAgentSignerPolicy, policyDigest } from './policy.js';
import type { WalletControlProvider, WalletControlProviderInspection } from './provider.js';
import { WalletControlRepository } from './repository.js';
import type { AgentSignerPolicyConfig, WalletControlBinding } from './types.js';

export interface WalletControlProvisionInput {
  ownerId: string;
  petId: string;
  appWalletId: string;
  privyUserId: string;
  policyConfig: AgentSignerPolicyConfig;
}

export type WalletControlPolicyRotationInput = WalletControlProvisionInput;

export interface WalletControlClientPolicyAttachment {
  walletAddress: string;
  agentSignerId: string;
  agentPolicyId: string;
  expectedPolicyDigest: string;
}

export interface WalletControlClientRevocationAttachment {
  walletAddress: string;
  expectedBindingVersion: number;
}

export interface WalletControlClientRecoveryAttachment extends WalletControlClientPolicyAttachment {
  expectedBindingVersion: number;
}

export type WalletControlPolicyPreparation =
  | { status: 'current'; binding: WalletControlBinding }
  | { status: 'owner-authorization-required'; attachment: WalletControlClientPolicyAttachment };

type RotatableWalletControlBinding = WalletControlBinding & {
  privyEmbeddedWalletId: string;
  smartWalletAddress: string;
  agentPolicyId: string;
};

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash('sha256').update(values.join(':')).digest('hex').slice(0, 32)}`;
}

/**
 * How long a 'requested'/'provisioning' binding may sit untouched before another attempt may
 * declare it abandoned. Long enough that no real Privy round trip is interrupted, short enough that
 * a crash does not become a support ticket.
 */
const STALE_PROVISIONING_MS = 15 * 60_000;

type WalletControlProviderStage =
  | 'provision'
  | 'inspect-reprovision'
  | 'create-replacement-policy'
  | 'inspect-replacement-policy'
  | 'inspect-revocation'
  | 'inspect-recovery';

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

function providerCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const body = (error as { error?: unknown }).error;
  if (!body || typeof body !== 'object') return undefined;
  const candidate = (body as { code?: unknown; type?: unknown }).code ?? (body as { type?: unknown }).type;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : undefined;
}

class WalletControlProviderFailure extends Error {
  readonly stage: WalletControlProviderStage;
  readonly providerStatus: number | undefined;
  readonly providerCode: string | undefined;

  constructor(stage: WalletControlProviderStage, cause: unknown) {
    super('Wallet control provisioning failed');
    this.name = 'WalletControlProviderFailure';
    this.stage = stage;
    this.providerStatus = providerStatus(cause);
    this.providerCode = providerCode(cause);
  }
}

/**
 * Top-level log fields, so they never reach the `err` serializer or the redact allowlist: every
 * value here has to be safe on its own. The provider's free-text message is therefore not one of
 * them -- it carries whatever Privy put in it, and no denylist of patterns can promise otherwise
 * (`safeErrorProjection` in observability/logger.ts drops error messages for the same reason).
 * The stage, an HTTP status, and the provider's allowlist-shaped code are what an operator acts on.
 */
export function walletControlProviderDiagnostic(error: unknown): Record<string, string | number> {
  if (!(error instanceof WalletControlProviderFailure)) return { stage: 'unknown' };
  return {
    stage: error.stage,
    ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
  };
}

function safeProviderFailure(stage: WalletControlProviderStage, cause: unknown): Error {
  return new WalletControlProviderFailure(stage, cause);
}

/**
 * A failed binding was retried with a changed policy, but the abandoned provider policy could
 * not be proven orphaned. Privy requires the resource owner's authorization signature for every
 * PATCH/DELETE on owned resources, and these policies and wallets are deliberately user-owned,
 * so this server cannot detach or delete the old policy itself: it fails closed instead.
 */
class WalletControlStalePolicyError extends Error {
  readonly reason: 'stale-policy-attached' | 'unexpected-wallet' | 'unverifiable';

  constructor(reason: 'stale-policy-attached' | 'unexpected-wallet' | 'unverifiable') {
    super('Wallet control retry is blocked until the previous provisioning attempt is reviewed');
    this.name = 'WalletControlStalePolicyError';
    this.reason = reason;
  }
}

export class WalletControlService {
  readonly #repository: WalletControlRepository;
  readonly #provider: WalletControlProvider;
  readonly #agentSignerId: string;
  readonly #now: () => Date;
  readonly #inFlight = new Map<string, Promise<WalletControlBinding>>();
  readonly #policyPreparations = new Map<string, Promise<WalletControlPolicyPreparation>>();

  constructor(options: {
    repository: WalletControlRepository;
    provider: WalletControlProvider;
    agentSignerId: string;
    now?: () => Date;
  }) {
    if (!options.agentSignerId.trim() || options.agentSignerId.length > 255) throw new Error('Invalid agent signer ID');
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#agentSignerId = options.agentSignerId;
    this.#now = options.now ?? (() => new Date());
  }

  provision(input: WalletControlProvisionInput): Promise<WalletControlBinding> {
    if (input.policyConfig.ownerPrivyUserId !== input.privyUserId || input.policyConfig.petId !== input.petId) {
      return Promise.reject(new Error('Wallet control policy identity does not match the requested owner and pet'));
    }
    const key = `${input.ownerId}:${input.petId}`;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const operation = this.#provision(input).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, operation);
    return operation;
  }

  async #provision(input: WalletControlProvisionInput): Promise<WalletControlBinding> {
    const policy = buildAgentSignerPolicy(input.policyConfig);
    const expectedPolicyDigest = policyDigest(policy);
    const bindingId = stableId('wcb', [input.ownerId, input.petId, input.appWalletId, input.privyUserId]);
    // Before anything else: if a previous attempt died without recording an outcome, release it.
    // `markFailed` only runs in this service's catch handler, so a crashed or evicted process leaves
    // the row in 'requested'/'provisioning', where the reprovision path cannot reach it and
    // beginProvisioning rejects any changed policy. Elapsed time is the only signal a second replica
    // has that the other attempt is gone, so the window has to be generous.
    this.#repository.releaseStalledProvisioning(bindingId, STALE_PROVISIONING_MS);
    // And before `beginProvisioning` for the same reason it rejects a changed policy outside
    // 'failed': a drift that happened before this binding ever recorded a wallet identity has no
    // owner route out of it at all, so provisioning stayed 409 `drifted` for that pet forever and
    // its app wallet kept the never-provisioned sentinel with nothing able to clear it. Releasing it
    // to 'failed' re-arms the retry path below; reaching 'active' from there still costs a clean
    // provider inspection, so nothing is restored on a local edit.
    this.#repository.releaseUnprovisionedDrift(bindingId);
    let binding = this.#repository.beginProvisioning({
      bindingId, ownerId: input.ownerId, petId: input.petId, appWalletId: input.appWalletId,
      privyUserId: input.privyUserId, agentSignerId: this.#agentSignerId, expectedPolicyDigest,
      expectedPolicyJson: JSON.stringify(policy),
    });
    if (binding.status === 'revoked' || binding.status === 'drifted') return binding;
    if (binding.status === 'active' || binding.status === 'paused' || binding.status === 'recovered') {
      return await this.verify(input.ownerId, input.petId);
    }
    if (binding.status === 'failed' && binding.expectedPolicyDigest !== expectedPolicyDigest) {
      await this.#assertAbandonedPolicyOrphaned(binding);
      binding = this.#repository.adoptReprovisionPolicy(binding.bindingId, binding.version, {
        expectedPolicyDigest, expectedPolicyJson: JSON.stringify(policy),
      });
    }

    try {
      if (binding.status === 'requested') {
        const created = await this.#provider.createUserOwnedPolicy({
          privyUserId: input.privyUserId,
          policy,
          idempotencyKey: stableId('meowwa_policy', [bindingId, expectedPolicyDigest]),
        });
        if (created.digest !== expectedPolicyDigest || created.ownerType !== 'privy_user') {
          return this.#repository.markDrifted(binding.bindingId, binding.version,
            created.ownerType !== 'privy_user' ? 'policy-owner-mismatch' : 'policy-digest-mismatch');
        }
        binding = this.#repository.setPolicy(binding.bindingId, binding.version, created.policyId);
      } else if (binding.status === 'failed') {
        if (!binding.agentPolicyId) {
          const created = await this.#provider.createUserOwnedPolicy({
            privyUserId: input.privyUserId,
            policy,
            idempotencyKey: stableId('meowwa_policy', [bindingId, expectedPolicyDigest]),
          });
          if (created.digest !== expectedPolicyDigest || created.ownerType !== 'privy_user') {
            return this.#repository.markDrifted(binding.bindingId, binding.version,
              created.ownerType !== 'privy_user' ? 'policy-owner-mismatch' : 'policy-digest-mismatch');
          }
          binding = this.#repository.setPolicy(binding.bindingId, binding.version, created.policyId);
        } else {
          binding = this.#repository.resumeProvisioning(binding.bindingId, binding.version);
        }
      }
      if (binding.status !== 'provisioning' || !binding.agentPolicyId) throw new Error('Wallet control binding is not ready for provisioning');
      const wallet = await this.#provider.provisionUserWallet({
        privyUserId: input.privyUserId,
        externalId: stableId('meowwa_control', [binding.bindingId]),
        agentSignerId: this.#agentSignerId,
        agentPolicyId: binding.agentPolicyId,
        // Scoped to the policy: Privy rejects a reused idempotency key whose request body changed
        // (400, docs.privy.io/api-reference/idempotency-keys), and the body carries the policy id.
        idempotencyKey: stableId('meowwa_wallet', [binding.bindingId, binding.agentPolicyId]),
      });
      const inspection = await this.#provider.inspectBinding({
        privyUserId: input.privyUserId,
        embeddedWalletId: wallet.embeddedWalletId,
        smartWalletAddress: wallet.smartWalletAddress,
        agentPolicyId: binding.agentPolicyId,
        expectedPolicy: policy,
      });
      const drift = this.#driftReason(binding, inspection, wallet.embeddedWalletId, wallet.smartWalletAddress);
      if (drift) return this.#repository.markDrifted(binding.bindingId, binding.version, drift);
      return this.#repository.activate(binding.bindingId, binding.version, {
        privyEmbeddedWalletId: wallet.embeddedWalletId,
        smartWalletAddress: wallet.smartWalletAddress,
        verifiedAt: this.#now().toISOString(),
      });
    } catch (error) {
      const current = this.#repository.getBindingById(binding.bindingId);
      if (current && current.version === binding.version && (current.status === 'requested' || current.status === 'provisioning')) {
        this.#repository.markFailed(current.bindingId, current.version, 'provider-error');
      }
      throw safeProviderFailure('provision', error);
    }
  }

  /**
   * A policy only ever reaches the agent signer through wallet creation with this binding's
   * write-once external ID, so a missing wallet proves the abandoned policy is orphaned. A
   * surviving wallet means the failed provisioning materialized provider-side and the old
   * policy may still govern a live agent signer; detaching it requires the wallet owner's
   * authorization signature, which this server deliberately does not hold, so it fails closed.
   */
  async #assertAbandonedPolicyOrphaned(binding: WalletControlBinding): Promise<void> {
    if (!this.#provider.findProvisionedWallet) throw new WalletControlStalePolicyError('unverifiable');
    let remnant;
    try {
      remnant = await this.#provider.findProvisionedWallet({
        externalId: stableId('meowwa_control', [binding.bindingId]),
      });
    } catch (error) {
      throw safeProviderFailure('inspect-reprovision', error);
    }
    if (!remnant) return;
    const attached = binding.agentPolicyId !== null && remnant.agentSigners.some((signer) =>
      signer.signerId === this.#agentSignerId && signer.overridePolicyIds.includes(binding.agentPolicyId!));
    throw new WalletControlStalePolicyError(attached ? 'stale-policy-attached' : 'unexpected-wallet');
  }

  async verify(ownerId: string, petId: string): Promise<WalletControlBinding> {
    const binding = this.#repository.getBinding(ownerId, petId);
    if (!binding) throw new Error('Wallet control binding was not found');
    if (binding.status === 'revoked' || binding.status === 'drifted') return binding;
    if (!binding.privyEmbeddedWalletId || !binding.smartWalletAddress || !binding.agentPolicyId) {
      throw new Error('Wallet control binding is incomplete');
    }
    const inspection = await this.#provider.inspectBinding({
      privyUserId: binding.privyUserId,
      embeddedWalletId: binding.privyEmbeddedWalletId,
      smartWalletAddress: binding.smartWalletAddress,
      agentPolicyId: binding.agentPolicyId,
      expectedPolicy: JSON.parse(binding.expectedPolicyJson) as ReturnType<typeof buildAgentSignerPolicy>,
    });
    const drift = this.#driftReason(binding, inspection, binding.privyEmbeddedWalletId, binding.smartWalletAddress);
    if (drift) return this.#repository.markDrifted(binding.bindingId, binding.version, drift);
    return this.#repository.recordVerified(binding.bindingId, binding.version, this.#now().toISOString());
  }

  prepareClientPolicyRotation(input: WalletControlPolicyRotationInput): Promise<WalletControlPolicyPreparation> {
    if (input.policyConfig.ownerPrivyUserId !== input.privyUserId || input.policyConfig.petId !== input.petId) {
      return Promise.reject(new Error('Wallet control policy identity does not match the requested owner and pet'));
    }
    const key = `${input.ownerId}:${input.petId}`;
    const existing = this.#policyPreparations.get(key);
    if (existing) return existing;
    const operation = this.#prepareClientPolicyRotation(input).finally(() => this.#policyPreparations.delete(key));
    this.#policyPreparations.set(key, operation);
    return operation;
  }

  async #prepareClientPolicyRotation(input: WalletControlPolicyRotationInput): Promise<WalletControlPolicyPreparation> {
    const binding = this.#rotationBinding(input);
    const policy = buildAgentSignerPolicy(input.policyConfig);
    const expectedPolicyDigest = policyDigest(policy);
    if (expectedPolicyDigest === binding.expectedPolicyDigest) {
      return { status: 'current', binding: await this.verify(input.ownerId, input.petId) };
    }
    try {
      const created = await this.#provider.createUserOwnedPolicy({
        privyUserId: input.privyUserId,
        policy,
        idempotencyKey: stableId('meowwa_policy_rotation', [binding.bindingId, binding.expectedPolicyDigest, expectedPolicyDigest]),
      });
      if (created.digest !== expectedPolicyDigest || created.ownerType !== 'privy_user') {
        throw new Error('Replacement policy was not verified');
      }
      return {
        status: 'owner-authorization-required',
        attachment: {
          walletAddress: binding.smartWalletAddress,
          agentSignerId: this.#agentSignerId,
          agentPolicyId: created.policyId,
          expectedPolicyDigest,
        },
      };
    } catch (error) {
      throw safeProviderFailure('create-replacement-policy', error);
    }
  }

  async completeClientPolicyRotation(
    input: WalletControlPolicyRotationInput,
    attachment: Pick<WalletControlClientPolicyAttachment, 'agentPolicyId' | 'expectedPolicyDigest'>,
  ): Promise<WalletControlBinding> {
    const binding = this.#rotationBinding(input);
    const policy = buildAgentSignerPolicy(input.policyConfig);
    const expectedPolicyDigest = policyDigest(policy);
    if (expectedPolicyDigest === binding.expectedPolicyDigest) return await this.verify(input.ownerId, input.petId);
    if (attachment.expectedPolicyDigest !== expectedPolicyDigest || !attachment.agentPolicyId.trim()) {
      throw new Error('Wallet control policy completion does not match the prepared owner authorization');
    }
    const candidate: WalletControlBinding = {
      ...binding,
      agentPolicyId: attachment.agentPolicyId,
      expectedPolicyDigest,
      expectedPolicyJson: JSON.stringify(policy),
    };
    try {
      const inspection = await this.#provider.inspectBinding({
        privyUserId: binding.privyUserId,
        embeddedWalletId: binding.privyEmbeddedWalletId,
        smartWalletAddress: binding.smartWalletAddress,
        agentPolicyId: attachment.agentPolicyId,
        expectedPolicy: policy,
      });
      if (this.#driftReason(candidate, inspection, binding.privyEmbeddedWalletId, binding.smartWalletAddress)) {
        throw new Error('Client-authorized replacement policy binding was not verified');
      }
      return this.#repository.recordPolicyRotation(binding.bindingId, binding.version, {
        agentPolicyId: attachment.agentPolicyId,
        expectedPolicyDigest,
        expectedPolicyJson: JSON.stringify(policy),
        verifiedAt: this.#now().toISOString(),
      });
    } catch (error) {
      throw safeProviderFailure('inspect-replacement-policy', error);
    }
  }

  #rotationBinding(input: WalletControlPolicyRotationInput): RotatableWalletControlBinding {
    const binding = this.#repository.getBinding(input.ownerId, input.petId);
    if (!binding || binding.appWalletId !== input.appWalletId || binding.privyUserId !== input.privyUserId) {
      throw new Error('Wallet control binding was not found');
    }
    if (!['active', 'paused', 'recovered'].includes(binding.status) || binding.signerStatus !== 'attached' ||
      !binding.privyEmbeddedWalletId || !binding.smartWalletAddress || !binding.agentPolicyId) {
      throw new Error('Wallet control binding is not eligible for policy rotation');
    }
    return binding as RotatableWalletControlBinding;
  }

  pause(ownerId: string, petId: string, reason = 'owner'): WalletControlBinding {
    const binding = this.#repository.getBinding(ownerId, petId);
    if (!binding) throw new Error('Wallet control binding was not found');
    if (binding.status === 'paused') return binding;
    return this.#repository.pause(binding.bindingId, binding.version, reason);
  }

  resume(ownerId: string, petId: string): WalletControlBinding {
    const binding = this.#repository.getBinding(ownerId, petId);
    if (!binding) throw new Error('Wallet control binding was not found');
    if (binding.status === 'active' || binding.status === 'recovered') return binding;
    return this.#repository.resume(binding.bindingId, binding.version);
  }

  prepareClientSignerRevocation(ownerId: string, petId: string):
    | { status: 'revoked'; binding: WalletControlBinding }
    | { status: 'owner-authorization-required'; attachment: WalletControlClientRevocationAttachment } {
    const binding = this.#repository.getBinding(ownerId, petId);
    if (!binding) throw new Error('Wallet control binding was not found');
    if (binding.status === 'revoked') return { status: 'revoked', binding };
    if (!binding.privyEmbeddedWalletId || !binding.smartWalletAddress || !binding.agentPolicyId) {
      throw new Error('Wallet control binding is incomplete');
    }
    return {
      status: 'owner-authorization-required',
      attachment: { walletAddress: binding.smartWalletAddress, expectedBindingVersion: binding.version },
    };
  }

  async completeClientSignerRevocation(
    ownerId: string,
    petId: string,
    expectedBindingVersion: number,
  ): Promise<WalletControlBinding> {
    const binding = this.#repository.getBinding(ownerId, petId);
    if (!binding) throw new Error('Wallet control binding was not found');
    if (binding.status === 'revoked') return binding;
    if (binding.version !== expectedBindingVersion) throw new Error('Wallet control revocation is stale');
    if (!binding.privyEmbeddedWalletId || !binding.smartWalletAddress || !binding.agentPolicyId) {
      throw new Error('Wallet control binding is incomplete');
    }
    try {
      const inspection = await this.#provider.inspectBinding({
        privyUserId: binding.privyUserId,
        embeddedWalletId: binding.privyEmbeddedWalletId,
        smartWalletAddress: binding.smartWalletAddress,
        agentPolicyId: binding.agentPolicyId,
        expectedPolicy: JSON.parse(binding.expectedPolicyJson) as ReturnType<typeof buildAgentSignerPolicy>,
      });
      if (inspection.agentSigners.some((signer) => signer.signerId === this.#agentSignerId)) {
        throw new Error('Client-authorized signer revocation was not verified');
      }
      if (inspection.agentSigners.length !== 0) {
        return this.#repository.markDrifted(binding.bindingId, binding.version, 'unexpected-additional-signer');
      }
      const structuralDrift = this.#structuralDriftReason(
        binding, inspection, binding.privyEmbeddedWalletId, binding.smartWalletAddress,
      );
      if (structuralDrift) return this.#repository.markDrifted(binding.bindingId, binding.version, structuralDrift);
      return this.#repository.recordAgentRevoked(binding.bindingId, binding.version);
    } catch (error) {
      throw safeProviderFailure('inspect-revocation', error);
    }
  }

  prepareClientSignerRecovery(ownerId: string, petId: string): {
    status: 'owner-authorization-required'; attachment: WalletControlClientRecoveryAttachment;
  } {
    const binding = this.#repository.getBinding(ownerId, petId);
    if (!binding) throw new Error('Wallet control binding was not found');
    if (binding.status !== 'revoked' || binding.signerStatus !== 'revoked' ||
      !binding.privyEmbeddedWalletId || !binding.smartWalletAddress || !binding.agentPolicyId) {
      throw new Error('Wallet control binding is not eligible for recovery');
    }
    return {
      status: 'owner-authorization-required',
      attachment: {
        walletAddress: binding.smartWalletAddress,
        agentSignerId: this.#agentSignerId,
        agentPolicyId: binding.agentPolicyId,
        expectedPolicyDigest: binding.expectedPolicyDigest,
        expectedBindingVersion: binding.version,
      },
    };
  }

  async completeClientSignerRecovery(
    ownerId: string,
    petId: string,
    attachment: Omit<WalletControlClientRecoveryAttachment, 'walletAddress' | 'agentSignerId'>,
  ): Promise<WalletControlBinding> {
    const binding = this.#repository.getBinding(ownerId, petId);
    if (!binding) throw new Error('Wallet control binding was not found');
    if (binding.status === 'recovered' && binding.signerStatus === 'attached') return binding;
    if (binding.status !== 'revoked' || binding.signerStatus !== 'revoked' ||
      binding.version !== attachment.expectedBindingVersion || binding.agentPolicyId !== attachment.agentPolicyId ||
      binding.expectedPolicyDigest !== attachment.expectedPolicyDigest || !binding.privyEmbeddedWalletId ||
      !binding.smartWalletAddress) {
      throw new Error('Wallet control recovery does not match the revoked binding');
    }
    try {
      const inspection = await this.#provider.inspectBinding({
        privyUserId: binding.privyUserId,
        embeddedWalletId: binding.privyEmbeddedWalletId,
        smartWalletAddress: binding.smartWalletAddress,
        agentPolicyId: binding.agentPolicyId,
        expectedPolicy: JSON.parse(binding.expectedPolicyJson) as ReturnType<typeof buildAgentSignerPolicy>,
      });
      if (this.#driftReason(binding, inspection, binding.privyEmbeddedWalletId, binding.smartWalletAddress)) {
        throw new Error('Client-authorized signer recovery was not verified');
      }
      return this.#repository.recordAgentRecovered(binding.bindingId, binding.version, this.#now().toISOString());
    } catch (error) {
      throw safeProviderFailure('inspect-recovery', error);
    }
  }

  #structuralDriftReason(
    binding: WalletControlBinding,
    inspection: WalletControlProviderInspection,
    embeddedWalletId: string,
    smartWalletAddress: string,
  ): string | undefined {
    if (!inspection.userLinked || inspection.privyUserId !== binding.privyUserId || inspection.embeddedWalletId !== embeddedWalletId ||
      inspection.smartWalletAddress.toLowerCase() !== smartWalletAddress.toLowerCase()) return 'user-link-mismatch';
    if (inspection.smartWalletType !== 'embedded_hd') return 'wallet-type-mismatch';
    if (inspection.policy.policyId !== binding.agentPolicyId || inspection.policy.digest !== binding.expectedPolicyDigest) return 'policy-digest-mismatch';
    if (inspection.policy.ownerType !== 'privy_user') return 'policy-owner-mismatch';
    return undefined;
  }

  #driftReason(
    binding: WalletControlBinding,
    inspection: WalletControlProviderInspection,
    embeddedWalletId: string,
    smartWalletAddress: string,
  ): string | undefined {
    const structural = this.#structuralDriftReason(binding, inspection, embeddedWalletId, smartWalletAddress);
    if (structural) return structural;
    const matchingSigner = inspection.agentSigners.filter((signer) => signer.signerId === this.#agentSignerId);
    if (matchingSigner.length !== 1) return 'agent-signer-missing';
    if (inspection.agentSigners.length !== 1) return 'unexpected-additional-signer';
    if (matchingSigner[0]!.overridePolicyIds.length !== 1 || matchingSigner[0]!.overridePolicyIds[0] !== binding.agentPolicyId) {
      return 'agent-policy-mismatch';
    }
    return undefined;
  }
}
