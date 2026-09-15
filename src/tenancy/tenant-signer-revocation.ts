import { CHAINS } from '@meowwa/chain-domain';
import type { ControlChainKey } from '../funding/types.js';
import { buildAgentSignerPolicy } from '../wallet-control/policy.js';
import type { WalletControlProvider } from '../wallet-control/provider.js';
import type { TenantWalletBinding } from './financial-repository.js';
import { requestedControlChain } from './privy-wallet-provisioner.js';

export interface TenantRevocationRepository {
  getVerifiedBinding(tenantId: string, petId: string, chainKey?: ControlChainKey): Promise<TenantWalletBinding | undefined>;
  recordBindingRevocation(input: {
    tenantId: string;
    petId: string;
    expectedWalletId: string;
    status: 'revoked' | 'drifted';
    reason: string;
    revokedAt: string;
  }): Promise<TenantWalletBinding>;
}

/** What one family's verification needs: the Privy control provider for that network and its recipients. */
export interface TenantSignerRevocationFamily {
  provider: Pick<WalletControlProvider, 'inspectBinding'>;
  allowedRecipients: readonly string[];
}

export interface TenantSignerRevocationOptions {
  repository: TenantRevocationRepository;
  /** The Base Sepolia control provider: the family every existing binding lives on. */
  provider: Pick<WalletControlProvider, 'inspectBinding'>;
  agentSignerId: string;
  /** Base Sepolia recipients; other families carry their own in `families`. */
  allowedRecipients: readonly string[];
  perTransactionLimitAtomic: string;
  /** Further control chains this workload verifies, keyed by the binding's chain. */
  families?: Partial<Record<ControlChainKey, TenantSignerRevocationFamily>>;
  now?: () => Date;
}

/**
 * Confirms an owner-authorized signer detachment against Privy, then records it.
 *
 * MeowWa cannot detach its own signer: `updateWalletAdditionalSigner` requires the owner's JWT,
 * because the owner owns the wallet. The owner performs the detachment with their own credential
 * and this verifies the result, which is the same two-phase shape the sandbox control plane uses.
 *
 * It runs in the wallet-provisioner workload because verification needs the Privy app secret, which
 * the API is deliberately never given.
 */
export class TenantSignerRevocationVerifier {
  readonly #now: () => Date;

  constructor(private readonly options: TenantSignerRevocationOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  #family(chainKey: ControlChainKey): TenantSignerRevocationFamily {
    const family = this.options.families?.[chainKey] ??
      (chainKey === 'base_sepolia'
        ? { provider: this.options.provider, allowedRecipients: this.options.allowedRecipients }
        : undefined);
    if (!family) throw new Error(`Tenant wallet revocation cannot be verified on ${CHAINS[chainKey].displayName}`);
    return family;
  }

  async verify(input: { tenantId: string; petId: string; chain?: ControlChainKey | undefined }): Promise<{ status: 'revoked' | 'drifted'; reason: string }> {
    const chainKey = requestedControlChain(input.chain);
    const binding = await this.options.repository.getVerifiedBinding(input.tenantId, input.petId, chainKey);
    if (!binding) throw new Error('Tenant wallet binding was not found');
    if (binding.chainKey !== chainKey) throw new Error('Tenant wallet binding is on another chain');
    if (binding.status === 'revoked' || binding.status === 'drifted') {
      return { status: binding.status, reason: binding.revocationReason ?? 'already-recorded' };
    }
    if (!binding.agentPolicyId || !binding.ownerPrivyUserId) {
      // Without the provisioning owner identity there is nothing to inspect against, and guessing
      // would mean recording a revocation nobody verified.
      throw new Error('Tenant wallet binding cannot be verified for revocation');
    }

    // The expected policy is rebuilt for the binding's own network: a Solana binding's policy
    // names solana_devnet and base58 recipients, and the default (Base Sepolia) build would never
    // match it, so it would be classed as tampered rather than verified.
    const family = this.#family(binding.chainKey);
    const inspection = await family.provider.inspectBinding({
      privyUserId: binding.ownerPrivyUserId,
      embeddedWalletId: binding.privyEmbeddedWalletId,
      smartWalletAddress: binding.smartWalletAddress,
      agentPolicyId: binding.agentPolicyId,
      expectedPolicy: buildAgentSignerPolicy({
        ownerPrivyUserId: binding.ownerPrivyUserId,
        petId: binding.petId,
        allowedRecipients: [...family.allowedRecipients],
        perTransactionLimitAtomic: this.options.perTransactionLimitAtomic,
        validUntil: binding.policyValidUntil ?? this.#now().toISOString(),
      }, CHAINS[binding.chainKey]),
    });

    const outcome = this.#classify(inspection.agentSigners);
    return this.#record(input, binding, outcome);
  }

  #classify(agentSigners: ReadonlyArray<{ signerId: string }>): { status: 'revoked' | 'drifted'; reason: string } {
    if (agentSigners.some((signer) => signer.signerId === this.options.agentSignerId)) {
      // The owner asked to revoke and the signer is still there. Not revoked, and not silently
      // recorded as such: this is the case worth alerting on.
      return { status: 'drifted', reason: 'agent-signer-still-attached' };
    }
    if (agentSigners.length !== 0) return { status: 'drifted', reason: 'unexpected-additional-signer' };
    return { status: 'revoked', reason: 'owner-authorized-detachment-verified' };
  }

  async #record(
    input: { tenantId: string; petId: string },
    binding: TenantWalletBinding,
    outcome: { status: 'revoked' | 'drifted'; reason: string },
  ): Promise<{ status: 'revoked' | 'drifted'; reason: string }> {
    await this.options.repository.recordBindingRevocation({
      tenantId: input.tenantId,
      petId: input.petId,
      expectedWalletId: binding.walletId,
      status: outcome.status,
      reason: outcome.reason,
      revokedAt: this.#now().toISOString(),
    });
    return outcome;
  }
}
