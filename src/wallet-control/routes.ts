import { createHash } from 'node:crypto';
import { transitionRequest, EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumeVerifiedStepUp, stepUpIntentHash, type StepUpReplayStore } from '../auth.js';
import type { OwnerIdentityVerifier } from '../funding/privy.js';
import { signPetMandate, type MandateSigner } from '../mandate-signing.js';
import {
  appendAudit,
  appendNotification,
  newReceiveToken,
  petHasUnresolvedWalletActivity,
  releaseBudget,
  retireDerivedReceiveToken,
  suspendAutonomy,
  syncPocUsdcHolding,
  type AppStore,
  type Wallet,
} from '../store/memory-store.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  formatUsdcAmountAtomic,
  parseUsdcAmountAtomic,
  PRIVY_BASE_SEPOLIA_CHAIN,
  PRIVY_USDC_ASSET,
} from './policy.js';
import { WalletControlRepository } from './repository.js';
import { WalletControlService, walletControlProviderDiagnostic } from './service.js';
import type { WalletControlBinding } from './types.js';

export interface WalletControlModuleOptions {
  repository: WalletControlRepository;
  service: WalletControlService;
  privyOwnerId: string;
  agentSignerId: string;
  allowedRecipients: readonly string[];
  perTransactionLimitAtomic: string;
  maxDurationSeconds: number;
  ownerIdentityVerifier?: OwnerIdentityVerifier;
  now?: () => Date;
  closeRepositoryOnClose?: boolean;
}

const provisionBody = z.object({
  validUntil: z.iso.datetime({ offset: true }),
  stepUpVerified: z.boolean().optional(),
}).strict();
const policyCompletionBody = z.object({
  validUntil: z.iso.datetime({ offset: true }),
  agentPolicyId: z.string().min(1).max(255),
  expectedPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const batchPolicyIntentBody = z.object({
  validUntil: z.iso.datetime({ offset: true }),
  petIds: z.array(z.string().min(1).max(200)).min(1).max(20),
}).strict().refine((value) => new Set(value.petIds).size === value.petIds.length, {
  message: 'Pet IDs must be unique', path: ['petIds'],
});
const batchPolicyUpdateBody = z.object({
  validUntil: z.iso.datetime({ offset: true }),
  petIds: z.array(z.string().min(1).max(200)).min(1).max(20),
  stepUpVerified: z.boolean().optional(),
}).strict().refine((value) => new Set(value.petIds).size === value.petIds.length, {
  message: 'Pet IDs must be unique', path: ['petIds'],
});
const mutationBody = z.object({ stepUpVerified: z.boolean().optional() }).strict();
const signerRevocationCompletionBody = z.object({
  expectedBindingVersion: z.number().int().positive(),
}).strict();
const signerRecoveryCompletionBody = z.object({
  expectedBindingVersion: z.number().int().positive(),
  agentPolicyId: z.string().min(1).max(255),
  expectedPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const intentQuery = z.object({ validUntil: z.iso.datetime({ offset: true }) }).strict();

function policyScope(
  options: WalletControlModuleOptions,
  petId: string,
  validUntil: string,
  operation: 'wallet-control-provision' | 'wallet-control-policy-update' = 'wallet-control-provision',
) {
  return {
    operation,
    petId,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    usdcContract: BASE_SEPOLIA_USDC,
    asset: 'test USDC',
    providerAction: 'transfer',
    gasPaymentAsset: 'USDC',
    agentSignerConfigurationDigest: createHash('sha256').update(options.agentSignerId).digest('hex'),
    allowedRecipients: [...options.allowedRecipients].map((item) => item.toLowerCase()).sort(),
    perTransactionLimitAtomic: options.perTransactionLimitAtomic,
    validUntil,
  } as const;
}

function policyUpdateScope(options: WalletControlModuleOptions, binding: WalletControlBinding, validUntil: string) {
  return {
    ...policyScope(options, binding.petId, validUntil, 'wallet-control-policy-update'),
    bindingVersion: binding.version,
    previousPolicyDigest: binding.expectedPolicyDigest,
  } as const;
}

function batchPolicyUpdateScope(
  options: WalletControlModuleOptions,
  bindings: readonly WalletControlBinding[],
  validUntil: string,
) {
  return {
    operation: 'wallet-control-batch-policy-update',
    updates: [...bindings]
      .sort((left, right) => left.petId.localeCompare(right.petId))
      .map((binding) => policyUpdateScope(options, binding, validUntil)),
  } as const;
}

function validatedScope(options: WalletControlModuleOptions, petId: string, validUntilInput: string, now: Date) {
  const validUntil = new Date(validUntilInput);
  const expiresAt = validUntil.getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt > now.getTime() + options.maxDurationSeconds * 1000) {
    throw new RangeError('Wallet control authorization expiry is outside the allowed sandbox window');
  }
  return policyScope(options, petId, validUntil.toISOString());
}

function publicBinding(binding: WalletControlBinding, options: WalletControlModuleOptions) {
  const expectedPolicy = JSON.parse(binding.expectedPolicyJson) as {
    rules?: Array<{ conditions?: Array<{ field?: string; value?: string | string[] }> }>;
  };
  const conditions = expectedPolicy.rules?.[0]?.conditions ?? [];
  const limit = conditions.find((condition) => condition.field === 'source.amount')?.value;
  const legacyLimit = conditions.find((condition) => condition.field === 'transfer.amount')?.value;
  const expirySeconds = conditions.find((condition) => condition.field === 'current_unix_timestamp')?.value;
  const validUntil = typeof expirySeconds === 'string' && /^\d+$/.test(expirySeconds)
    ? new Date(Number(expirySeconds) * 1000).toISOString()
    : null;
  return {
    walletControl: {
      petId: binding.petId,
      appWalletId: binding.appWalletId,
      address: binding.smartWalletAddress,
      status: binding.status,
      signerStatus: binding.signerStatus,
      network: 'Base Sepolia',
      chainId: binding.chainId,
      asset: 'test USDC',
      ownerControlled: binding.ownerType === 'privy_user',
      smartWalletType: binding.smartWalletType,
      ownerEscapeStatus: binding.ownerEscapeStatus,
      lastVerifiedAt: binding.lastVerifiedAt,
      failureCode: binding.failureCode,
    },
    policy: {
      digest: binding.expectedPolicyDigest,
      perTransactionLimitAtomic: typeof limit === 'string' ? (() => {
        try { return parseUsdcAmountAtomic(limit); } catch { return null; }
      })() : typeof legacyLimit === 'string' && /^[1-9][0-9]*$/.test(legacyLimit) ? legacyLimit : null,
      validUntil,
      defaultDeny: true,
      matchesCurrentSettings: policyMatchesConfigured(binding, options),
    },
  };
}

function syncPetWalletAddress(store: AppStore, binding: WalletControlBinding): void {
  if (!binding.smartWalletAddress) return;
  const wallet = store.wallets.get(binding.petId);
  if (!wallet) return;
  const normalizedAddress = binding.smartWalletAddress.toLowerCase();
  for (const candidate of store.wallets.values()) {
    if (candidate.petId !== binding.petId && candidate.address.toLowerCase() === normalizedAddress) {
      throw new Error('Verified wallet address is already assigned to another pet');
    }
  }
  wallet.address = normalizedAddress;
  wallet.chainId = BASE_SEPOLIA_CHAIN_ID;
  syncPocUsdcHolding(wallet);
}

/**
 * The never-provisioned sentinel, read from the flags rather than from the empty address.
 *
 * `receiveEnabled: false` is written on a stored wallet by exactly two callers, both at creation:
 * tenancy/provisioning.ts for a tenant shell and modules/management.ts for a pet added while another
 * wallet was signer-restricted. Nothing else ever turns receiving off -- `/v1/wallet/revoke`,
 * `markPetSignerRevoked` below and account closure all leave it on, deliberately, so deposits keep
 * landing -- so a wallet the owner really did revoke can never be mistaken for this.
 *
 * Reading the empty address instead was self-erasing: `syncPetWalletAddress` writes the address
 * first, so a sync that then failed a policy or recipient gate consumed the only signal that could
 * ever reopen that wallet. The owner fixed the policy, called the route again, and the sentinel was
 * no longer visible to it -- their pet's wallet stayed paused and signerRevoked with nothing in this
 * module able to clear it.
 */
function carriesProvisioningSentinel(wallet: Wallet): boolean {
  return wallet.receiveEnabled === false && wallet.signerRevoked && wallet.paused && wallet.pauseReason === 'signer_revoked';
}

/**
 * Clears the never-provisioned sentinel, and only that.
 *
 * An empty `address` has exactly two writers -- tenancy/provisioning.ts for a tenant shell and
 * modules/management.ts for a pet added while any other wallet was signer-restricted -- and the
 * durable snapshot accepts an empty address only together with paused + signerRevoked
 * (memory-store validateHydratedBindings), so those flags are the provisioning sentinel rather than
 * an owner containing a wallet that ever spent. One pet's revocation stamps them on every pet added
 * afterwards, and nothing in the singleton topology cleared them: /v1/wallet/recover skips a wallet
 * with no address and /v1/wallet/pause refuses to resume a signer-revoked one, so the new pet's
 * wallet could never spend, never receive and never leave SUSPENDED.
 *
 * An activated binding is Privy's own proof that this pet's wallet exists and carries the restricted
 * signer, so it is the closer -- the same one tenancy/funding-routes.ts syncProvisionedWallet is for
 * a tenant shell, reached here through the step-up-gated provisioning route.
 *
 * This is the only restoring branch in this file, and it can fire only on a wallet that still
 * carries the sentinel `carriesProvisioningSentinel` describes -- one that has never had receiving
 * turned on. A wallet the owner actually revoked keeps receiving enabled, so provider
 * synchronization still cannot undo an owner emergency revocation.
 */
function clearProvisioningSentinel(store: AppStore, petId: string): void {
  const wallet = store.wallets.get(petId);
  if (!wallet || !carriesProvisioningSentinel(wallet)) return;
  retireDerivedReceiveToken(wallet, store.owner.ownerId);
  wallet.receiveToken ??= newReceiveToken();
  wallet.receiveEnabled = true;
  wallet.signerRevoked = false;
  if (wallet.pauseReason === 'signer_revoked') {
    wallet.paused = false;
    delete wallet.pauseReason;
  }
  const agent = store.agents.get(petId);
  // Not for an archived pet: modules/pet-archive.ts suspends the agent and leaves the wallet alone
  // precisely so deposits and withdrawals still work, so the wallet is reopened and the agent is not.
  if (agent && !wallet.paused && !store.pets.find((pet) => pet.petId === petId)?.archivedAt) agent.status = 'ACTIVE';
}

function ownerApprovedRecipients(binding: WalletControlBinding): string[] {
  let expectedPolicy: {
    rules?: Array<{ conditions?: Array<{ field?: string; operator?: string; value?: unknown }> }>;
  };
  try { expectedPolicy = JSON.parse(binding.expectedPolicyJson) as typeof expectedPolicy; }
  catch { throw new Error('Stored wallet control policy is invalid'); }
  const condition = expectedPolicy.rules?.[0]?.conditions?.find((item) =>
    item.field === 'destination.address' || item.field === 'transfer.recipient');
  if (condition?.operator !== 'in' || !Array.isArray(condition.value) || condition.value.length === 0) {
    throw new Error('Stored wallet control recipient policy is invalid');
  }
  const recipients = [...new Set(condition.value.map((item) => {
    if (typeof item !== 'string' || !EVM_ADDRESS_PATTERN.test(item) || /^0x0{40}$/i.test(item)) {
      throw new Error('Stored wallet control recipient policy is invalid');
    }
    return item.toLowerCase();
  }))].sort();
  return recipients;
}

function recipientsMatchConfigured(binding: WalletControlBinding, options: WalletControlModuleOptions): boolean {
  try {
    const recipients = ownerApprovedRecipients(binding);
    const configuredRecipients = [...new Set(options.allowedRecipients.map((item) => item.toLowerCase()))].sort();
    return JSON.stringify(recipients) === JSON.stringify(configuredRecipients);
  } catch {
    return false;
  }
}

function policyMatchesConfigured(binding: WalletControlBinding, options: WalletControlModuleOptions): boolean {
  let policy: {
    chain_type?: string;
    owner?: { user_id?: string };
    version?: string;
    rules?: Array<{
      action?: string;
      method?: string;
      conditions?: Array<{ field?: string; field_source?: string; operator?: string; value?: unknown; abi?: unknown }>;
    }>;
  };
  try { policy = JSON.parse(binding.expectedPolicyJson) as typeof policy; } catch { return false; }
  const rule = policy.rules?.[0];
  if (policy.chain_type !== 'ethereum' || policy.version !== '1.0' || policy.owner?.user_id !== binding.privyUserId ||
    policy.rules?.length !== 1 || rule?.action !== 'ALLOW' || rule.method !== 'transfer' || rule.conditions?.length !== 5) return false;
  const condition = (field: string) => rule.conditions!.find((item) => item.field === field);
  const asset = condition('source.asset');
  const chain = condition('source.chain');
  const amount = condition('source.amount');
  const expiry = condition('current_unix_timestamp');
  if (asset?.field_source !== 'action_request_body' || asset.operator !== 'eq' || asset.value !== PRIVY_USDC_ASSET ||
    chain?.field_source !== 'action_request_body' || chain.operator !== 'eq' || chain.value !== PRIVY_BASE_SEPOLIA_CHAIN ||
    amount?.field_source !== 'action_request_body' || amount.operator !== 'lte' ||
    amount.value !== formatUsdcAmountAtomic(options.perTransactionLimitAtomic) ||
    expiry?.field_source !== 'system' || expiry.operator !== 'lt' ||
    typeof expiry.value !== 'string' || !/^[1-9][0-9]*$/.test(expiry.value) ||
    rule.conditions.some((item) => item.abi !== undefined)) return false;
  return recipientsMatchConfigured(binding, options);
}

export function syncPetWalletControl(
  store: AppStore,
  binding: WalletControlBinding,
  options: WalletControlModuleOptions,
  mandateSigner: MandateSigner | undefined,
  now: Date,
): boolean {
  syncPetWalletAddress(store, binding);
  if (!['active', 'recovered'].includes(binding.status) || binding.signerStatus !== 'attached') return false;
  if (!policyMatchesConfigured(binding, options)) return false;
  const recipients = ownerApprovedRecipients(binding);
  const configuredRecipients = [...new Set(options.allowedRecipients.map((item) => item.toLowerCase()))].sort();
  if (JSON.stringify(recipients) !== JSON.stringify(configuredRecipients)) {
    return false;
  }
  const mandate = store.mandates.get(binding.petId);
  if (mandate && JSON.stringify(mandate.recipients) !== JSON.stringify(recipients)) {
    if (!mandateSigner) throw new Error('Wallet control mandate signer is unavailable');
    mandate.recipients = recipients;
    mandate.signatureVerified = true;
    mandate.nonceValid = true;
    mandate.authorization.approvedAt = binding.createdAt;
    mandate.authorization.displayedText = `Owner-approved Privy wallet policy bound pet ${binding.petId} to recipients ${recipients.join(', ')} on Base Sepolia test USDC.`;
    mandate.authorization.proof = signPetMandate(mandate, mandateSigner, now.toISOString());
    appendAudit(store, {
      eventType: 'MANDATE_WALLET_POLICY_BOUND', aggregateId: mandate.mandateId, actorType: 'owner', actorId: store.owner.ownerId,
      summary: 'Owner-approved Privy wallet recipients bound to the pet spending mandate',
      metadata: { petId: binding.petId, policyDigest: binding.expectedPolicyDigest },
    });
  }
  // Provider synchronization is deliberately one-way: it may tighten local safety state, never
  // restore it. `recovered` is a sticky binding status, so restoring here let any later sync —
  // including the unauthenticated-for-step-up /verify route and the startup sweep — silently
  // undo an owner emergency revocation and re-enable spending. Restoration belongs only to
  // /v1/wallet-controls/:petId/complete-agent-recovery, which gates it behind a verified Privy
  // owner, a one-use step-up token, and the unresolved-activity check.
  //
  // The one exception is the never-provisioned sentinel: a wallet that has never had receiving
  // turned on had nothing to revoke, so clearing it restores nothing an owner ever contained. The
  // call is unconditional because the sentinel is now read from the wallet itself, which is what
  // makes it survive a first sync that stopped at one of the gates above.
  clearProvisioningSentinel(store, binding.petId);
  return true;
}

export function walletControlRevokeIntent(binding: WalletControlBinding) {
  return {
    operation: 'wallet-control-revoke-agent',
    petId: binding.petId,
    bindingId: binding.bindingId,
    bindingVersion: binding.version,
    policyDigest: binding.expectedPolicyDigest,
  } as const;
}

export function walletControlRecoveryIntent(binding: WalletControlBinding) {
  return {
    operation: 'wallet-control-recover-agent',
    petId: binding.petId,
    bindingId: binding.bindingId,
    bindingVersion: binding.version,
    policyDigest: binding.expectedPolicyDigest,
  } as const;
}

export function walletControlOwnerEscapeIntent(binding: WalletControlBinding) {
  return {
    operation: 'wallet-control-owner-recovery-export',
    petId: binding.petId,
    bindingId: binding.bindingId,
    bindingVersion: binding.version,
    address: binding.smartWalletAddress?.toLowerCase() ?? null,
  } as const;
}

/**
 * Cuts MeowWa off from one pet wallet: the same fail-closed lock POST /v1/wallet/revoke applies
 * in modules/management.ts. `providerDetached` says only whether Privy has *confirmed* the signer
 * is gone -- detaching it needs the owner's own Privy credential, so only the completion call can
 * prove it. The lock never waits for that proof: the preparation step used to leave every spending
 * path live until a client the owner may no longer control chose to finish. Both facts get their
 * own audit line, and neither line claims the other happened.
 */
function markPetSignerRevoked(store: AppStore, petId: string, providerDetached: boolean): void {
  const wallet = store.wallets.get(petId);
  const newlyRevoked = wallet ? !wallet.signerRevoked : false;
  if (wallet) {
    wallet.signerRevoked = true;
    if (!wallet.paused) wallet.pauseReason = 'signer_revoked';
    wallet.paused = true;
    if (newlyRevoked || providerDetached) appendAudit(store, {
      eventType: 'SIGNER_REVOKED', aggregateId: wallet.walletId, actorType: 'owner', actorId: store.owner.ownerId,
      summary: providerDetached
        ? 'Privy confirmed removal of the restricted pet-wallet signer'
        : 'MeowWa signer access disabled and pet wallet spending locked',
      metadata: { petId, providerSignerDetached: providerDetached },
    });
  }
  const agent = store.agents.get(petId);
  if (agent) agent.status = 'SUSPENDED';
  if (store.autonomy.has(petId)) suspendAutonomy(store, petId, 'restricted signer revoked');
  for (const [requestId, paymentRequest] of store.requests) {
    if (paymentRequest.petId !== petId ||
      (paymentRequest.state !== 'AWAITING_APPROVAL' && paymentRequest.state !== 'AUTHORIZED')) continue;
    store.requests.set(requestId, {
      ...paymentRequest,
      state: transitionRequest(paymentRequest.state, 'CANCELLED', 'owner'),
    });
    releaseBudget(store, petId, requestId);
    appendAudit(store, {
      eventType: 'REQUEST_CANCELLED_BY_SIGNER_REVOCATION', aggregateId: requestId,
      actorType: 'owner', actorId: store.owner.ownerId,
      summary: 'Pending spending cancelled when the restricted signer was revoked',
    });
  }
  if (newlyRevoked) appendNotification(store, {
    type: 'SIGNER_REVOKED',
    message: providerDetached
      ? 'Restricted signer access was removed and this pet wallet is paused.'
      : 'MeowWa can no longer spend from this pet wallet. The agent signer is still attached at your wallet provider until you remove it there.',
    dedupeKey: `security:signer-revoked:${petId}`,
  });
}

function markPetSignerRecovered(store: AppStore, petId: string): void {
  const wallet = store.wallets.get(petId);
  const newlyRecovered = wallet ? wallet.signerRevoked : false;
  if (wallet) {
    wallet.signerRevoked = false;
    if (wallet.pauseReason === 'signer_revoked') {
      wallet.paused = false;
      delete wallet.pauseReason;
    }
    if (newlyRecovered) appendAudit(store, {
      eventType: 'WALLET_RECOVERED', aggregateId: wallet.walletId, actorType: 'owner', actorId: store.owner.ownerId,
      summary: 'Privy confirmed restoration of the restricted pet-wallet signer',
    });
  }
  const agent = store.agents.get(petId);
  // Only reactivate an agent whose wallet this recovery actually reopened. Provider recovery
  // restoring the signer says nothing about a pause the owner set for their own reason, and the
  // wallet above already honours that by unpausing only when pauseReason was 'signer_revoked'.
  // Activating unconditionally left an ACTIVE spending agent on a still-paused wallet, which is the
  // same shape modules/management.ts and tenancy/funding-routes.ts avoid by gating on the wallet.
  if (agent && wallet && !wallet.paused) agent.status = 'ACTIVE';
  if (newlyRecovered) appendNotification(store, {
    type: 'WALLET_RECOVERED',
    message: 'Restricted signer access was restored after owner authorization.',
    dedupeKey: `security:signer-recovered:${petId}`,
  });
}

function ownerAndPet(request: { headers: Record<string, unknown> }, store: AppStore, petId: string) {
  const ownerId = request.headers['x-owner-id'];
  if (typeof ownerId !== 'string' || ownerId !== store.owner.ownerId) return undefined;
  const pet = store.pets.find((item) => item.petId === petId && item.ownerId === ownerId);
  return pet ? { ownerId, pet } : undefined;
}

function privyUserFor(request: { headers: Record<string, unknown> }, options: WalletControlModuleOptions): string | undefined {
  const verified = request.headers['x-privy-user-id'];
  if (typeof verified === 'string' && verified === options.privyOwnerId) return verified;
  if (process.env.NODE_ENV === 'test' && request.headers['x-auth-mode'] === 'legacy') return options.privyOwnerId;
  return undefined;
}

async function verifiedPrivyOwner(
  request: { headers: Record<string, unknown> },
  options: WalletControlModuleOptions,
): Promise<boolean> {
  const freshProof = request.headers['x-privy-access-token'];
  if (freshProof !== undefined) {
    if (typeof freshProof !== 'string' || !options.ownerIdentityVerifier) return false;
    try {
      return (await options.ownerIdentityVerifier.verify(freshProof)).privyUserId === options.privyOwnerId;
    } catch {
      return false;
    }
  }
  return Boolean(privyUserFor(request, options));
}

export function registerWalletControlRoutes(
  app: FastifyInstance,
  store: AppStore,
  options: WalletControlModuleOptions,
  consumedStepUpTokens: Set<string> | StepUpReplayStore,
  mandateSigner?: MandateSigner,
): void {
  const clock = options.now ?? (() => new Date());
  for (const binding of options.repository.listBindings(store.owner.ownerId)) {
    syncPetWalletControl(store, binding, options, mandateSigner, clock());
  }

  const ownedPolicyBindings = (request: { headers: Record<string, unknown> }, petIds: readonly string[]) => {
    if (request.headers['x-owner-id'] !== store.owner.ownerId) return undefined;
    const bindings: WalletControlBinding[] = [];
    for (const petId of [...petIds].sort()) {
      if (!store.pets.some((pet) => pet.petId === petId && pet.ownerId === store.owner.ownerId)) return undefined;
      const binding = options.repository.getBinding(store.owner.ownerId, petId);
      if (!binding) return undefined;
      bindings.push(binding);
    }
    return bindings;
  };

  app.get('/v1/wallet-controls', async (request, reply) => {
    const ownerId = request.headers['x-owner-id'];
    if (typeof ownerId !== 'string' || ownerId !== store.owner.ownerId) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    return { walletControls: options.repository.listBindings(ownerId).map((binding) => publicBinding(binding, options)) };
  });

  app.get('/v1/wallet-controls/:petId', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    return publicBinding(binding, options);
  });

  app.get('/v1/wallet-controls/:petId/provisioning-intent', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    if (!ownerAndPet(request, store, petId)) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    const query = intentQuery.parse(request.query);
    try {
      const scope = validatedScope(options, petId, query.validUntil, clock());
      return { action: 'wallet-control-provision', resourceId: petId, intentHash: stepUpIntentHash(scope), scope };
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ type: 'validation', title: error.message, status: 400 });
      throw error;
    }
  });

  app.get('/v1/wallet-controls/:petId/policy-update-intent', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const query = intentQuery.parse(request.query);
    try {
      const validated = validatedScope(options, petId, query.validUntil, clock());
      const scope = policyUpdateScope(options, binding, validated.validUntil);
      return { action: 'policy-change', resourceId: owned.ownerId, intentHash: stepUpIntentHash(scope), scope };
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ type: 'validation', title: error.message, status: 400 });
      throw error;
    }
  });

  app.post('/v1/wallet-controls/batch-policy-update-intent', async (request, reply) => {
    const body = batchPolicyIntentBody.parse(request.body);
    const bindings = ownedPolicyBindings(request, body.petIds);
    if (!bindings) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    try {
      const validUntil = validatedScope(options, bindings[0]!.petId, body.validUntil, clock()).validUntil;
      const scope = batchPolicyUpdateScope(options, bindings, validUntil);
      return {
        action: 'policy-change', resourceId: store.owner.ownerId,
        intentHash: stepUpIntentHash(scope), scope,
      };
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ type: 'validation', title: error.message, status: 400 });
      throw error;
    }
  });

  app.post('/v1/wallet-controls/:petId/provision', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    const privyUserId = privyUserFor(request, options);
    if (!privyUserId) return reply.code(403).send({ type: 'privy-owner-required', title: 'Sign in as the Privy pet owner to configure wallet controls', status: 403 });
    const body = provisionBody.parse(request.body);
    let scope: ReturnType<typeof policyScope>;
    try {
      scope = validatedScope(options, petId, body.validUntil, clock());
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ type: 'validation', title: error.message, status: 400 });
      throw error;
    }
    if (!(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'wallet-control-provision', consumedStepUpTokens, {
      resourceId: petId, intentHash: stepUpIntentHash(scope),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    const existed = options.repository.getBinding(owned.ownerId, petId) !== undefined;
    try {
      const binding = await options.service.provision({
        ownerId: owned.ownerId, petId, appWalletId: owned.pet.walletId, privyUserId,
        policyConfig: {
          ownerPrivyUserId: privyUserId, petId, allowedRecipients: options.allowedRecipients,
          perTransactionLimitAtomic: options.perTransactionLimitAtomic, validUntil: scope.validUntil,
        },
      });
      // `recovered` beside `active` because every other route in this module already treats the two
      // as the same live binding -- verify, policy rotation and `syncPetWalletControl` all accept
      // both. Refusing it here told an owner whose wallet works that it "requires review", and left
      // the pet wallet unsynchronized on the one route that is meant to establish it.
      if (binding.status !== 'active' && binding.status !== 'recovered') {
        return reply.code(409).send({
          type: 'wallet-control-not-active', status: 409,
          // Names what is left to do instead of implying someone else is reviewing it: a drift that
          // never reached a live wallet is released and retried by this same call.
          title: binding.status === 'drifted'
            ? 'Pet wallet setup did not verify at the provider; try again'
            : 'Sandbox wallet control requires review',
          ...publicBinding(binding, options),
        });
      }
      if (!syncPetWalletControl(store, binding, options, mandateSigner, clock())) {
        return reply.code(409).send({
          type: 'wallet-control-policy-review-required', title: 'Pet wallet spending access needs owner review', status: 409,
          ...publicBinding(binding, options),
        });
      }
      return reply.code(existed ? 200 : 201).send(publicBinding(binding, options));
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-provision', ...walletControlProviderDiagnostic(error) },
        'Wallet control provider operation failed');
      return reply.code(502).send({ type: 'wallet-control-provider-error', title: 'Sandbox wallet control could not be verified', status: 502 });
    }
  });

  app.post('/v1/wallet-controls/:petId/update-policy', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) {
      return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    }
    const body = provisionBody.parse(request.body);
    let scope: ReturnType<typeof policyUpdateScope>;
    try {
      const validated = validatedScope(options, petId, body.validUntil, clock());
      scope = policyUpdateScope(options, binding, validated.validUntil);
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ type: 'validation', title: error.message, status: 400 });
      throw error;
    }
    if (!(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'policy-change', consumedStepUpTokens, {
      resourceId: owned.ownerId, intentHash: stepUpIntentHash(scope),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    try {
      const prepared = await options.service.prepareClientPolicyRotation({
        ownerId: owned.ownerId, petId, appWalletId: owned.pet.walletId, privyUserId: options.privyOwnerId,
        policyConfig: {
          ownerPrivyUserId: options.privyOwnerId, petId, allowedRecipients: options.allowedRecipients,
          perTransactionLimitAtomic: options.perTransactionLimitAtomic, validUntil: scope.validUntil,
        },
      });
      if (prepared.status === 'owner-authorization-required') {
        return reply.code(202).send({
          status: prepared.status,
          attachment: prepared.attachment,
        });
      }
      if (!syncPetWalletControl(store, prepared.binding, options, mandateSigner, clock())) {
        return reply.code(409).send({
          type: 'wallet-control-policy-review-required', title: 'Pet wallet spending access could not be synchronized', status: 409,
          ...publicBinding(prepared.binding, options),
        });
      }
      return publicBinding(prepared.binding, options);
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-policy-preparation', ...walletControlProviderDiagnostic(error) },
        'Wallet control provider operation failed');
      return reply.code(502).send({ type: 'wallet-control-policy-update-unverified', title: 'Pet wallet spending access could not be verified', status: 502 });
    }
  });

  app.post('/v1/wallet-controls/batch-update-policies', async (request, reply) => {
    const body = batchPolicyUpdateBody.parse(request.body);
    const bindings = ownedPolicyBindings(request, body.petIds);
    if (!bindings) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) {
      return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    }
    let validUntil: string;
    let scope: ReturnType<typeof batchPolicyUpdateScope>;
    try {
      validUntil = validatedScope(options, bindings[0]!.petId, body.validUntil, clock()).validUntil;
      scope = batchPolicyUpdateScope(options, bindings, validUntil);
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ type: 'validation', title: error.message, status: 400 });
      throw error;
    }
    if (!(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'policy-change', consumedStepUpTokens, {
      resourceId: store.owner.ownerId, intentHash: stepUpIntentHash(scope),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    try {
      const results: Array<Record<string, unknown>> = [];
      for (const binding of bindings) {
        const pet = store.pets.find((item) => item.petId === binding.petId && item.ownerId === store.owner.ownerId)!;
        const prepared = await options.service.prepareClientPolicyRotation({
          ownerId: store.owner.ownerId, petId: binding.petId, appWalletId: pet.walletId, privyUserId: options.privyOwnerId,
          policyConfig: {
            ownerPrivyUserId: options.privyOwnerId, petId: binding.petId, allowedRecipients: options.allowedRecipients,
            perTransactionLimitAtomic: options.perTransactionLimitAtomic, validUntil,
          },
        });
        if (prepared.status === 'owner-authorization-required') {
          results.push({ petId: binding.petId, status: prepared.status, attachment: prepared.attachment });
          continue;
        }
        if (!syncPetWalletControl(store, prepared.binding, options, mandateSigner, clock())) {
          return reply.code(409).send({
            type: 'wallet-control-policy-review-required', title: 'Pet wallet spending access could not be synchronized', status: 409,
            petId: binding.petId,
          });
        }
        results.push({ petId: binding.petId, status: 'current', walletControl: publicBinding(prepared.binding, options) });
      }
      const requiresOwnerAuthorization = results.some((result) => result.status === 'owner-authorization-required');
      return reply.code(requiresOwnerAuthorization ? 202 : 200).send({ results });
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-batch-policy-preparation', ...walletControlProviderDiagnostic(error) },
        'Wallet control provider operation failed');
      return reply.code(502).send({ type: 'wallet-control-policy-update-unverified', title: 'Pet wallet spending access could not be verified', status: 502 });
    }
  });

  app.post('/v1/wallet-controls/:petId/complete-policy-update', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) {
      return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    }
    const body = policyCompletionBody.parse(request.body);
    let validUntil: string;
    try {
      validUntil = validatedScope(options, petId, body.validUntil, clock()).validUntil;
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ type: 'validation', title: error.message, status: 400 });
      throw error;
    }
    try {
      const rotated = await options.service.completeClientPolicyRotation({
        ownerId: owned.ownerId, petId, appWalletId: owned.pet.walletId, privyUserId: options.privyOwnerId,
        policyConfig: {
          ownerPrivyUserId: options.privyOwnerId, petId, allowedRecipients: options.allowedRecipients,
          perTransactionLimitAtomic: options.perTransactionLimitAtomic, validUntil,
        },
      }, {
        agentPolicyId: body.agentPolicyId,
        expectedPolicyDigest: body.expectedPolicyDigest,
      });
      if (!syncPetWalletControl(store, rotated, options, mandateSigner, clock())) {
        return reply.code(409).send({
          type: 'wallet-control-policy-review-required', title: 'Pet wallet spending access could not be synchronized', status: 409,
          ...publicBinding(rotated, options),
        });
      }
      return publicBinding(rotated, options);
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-policy-completion', ...walletControlProviderDiagnostic(error) },
        'Wallet control provider operation failed');
      return reply.code(502).send({ type: 'wallet-control-policy-update-unverified', title: 'Pet wallet spending access could not be verified', status: 502 });
    }
  });

  app.post('/v1/wallet-controls/:petId/verify', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    try {
      const binding = await options.service.verify(owned.ownerId, petId);
      if (!syncPetWalletControl(store, binding, options, mandateSigner, clock())) {
        return reply.code(409).send({
          type: 'wallet-control-policy-review-required', title: 'Pet wallet spending access needs owner review', status: 409,
          ...publicBinding(binding, options),
        });
      }
      return publicBinding(binding, options);
    } catch {
      return reply.code(502).send({ type: 'wallet-control-verification-unavailable', title: 'Sandbox wallet control verification is unavailable', status: 502 });
    }
  });

  app.post('/v1/wallet-controls/:petId/pause', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const body = mutationBody.parse(request.body);
    // Check pausability before spending the one-use step-up token: an illegal transition threw
    // out of service.pause() as a 500 after the token was already consumed, so the owner had to
    // obtain a fresh confirmation just to learn the action was never possible.
    if (!['active', 'recovered', 'paused'].includes(binding.status)) {
      return reply.code(409).send({
        type: 'wallet-control-not-pausable',
        title: 'This pet wallet control cannot be paused in its current state',
        status: 409,
        ...publicBinding(binding, options),
      });
    }
    const intent = { operation: 'wallet-control-pause', petId, bindingId: binding.bindingId, bindingVersion: binding.version };
    if (!(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'wallet-control-pause', consumedStepUpTokens, {
      resourceId: petId, intentHash: stepUpIntentHash(intent),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    let paused;
    try {
      paused = options.service.pause(owned.ownerId, petId);
    } catch {
      // The binding changed between the guard and the transition.
      const current = options.repository.getBinding(owned.ownerId, petId);
      return reply.code(409).send({
        type: 'wallet-control-not-pausable',
        title: 'This pet wallet control cannot be paused in its current state',
        status: 409,
        ...(current ? publicBinding(current, options) : {}),
      });
    }
    const wallet = store.wallets.get(petId);
    if (wallet) { wallet.paused = true; wallet.pauseReason = 'owner'; }
    return publicBinding(paused, options);
  });

  /**
   * The closer for `paused`. Without it the owner-facing panel read "needs owner review" for a
   * review nothing could clear, and /verify -- the route the panel polls -- 409'd forever.
   *
   * Same asymmetry POST /v1/wallet/pause uses: pausing rides on the bearer, resuming costs a fresh
   * one-use credential. It is deliberately the *same* credential, `wallet-resume`, that route already
   * spends -- modules/sandbox-auth.ts mints it against this pet's wallet and discloses it as "Let
   * <pet>'s wallet spend again after your pause", which is exactly what this undoes. Inventing a new
   * action name would have been unmintable: `ownerStepUpActions` is a closed set, so the route would
   * have been a second door with no key.
   *
   * That mint is only available while the wallet is paused, so the credential is required only while
   * it is -- an owner who already resumed the wallet itself has nothing left to hold, and this call
   * then only catches the binding record up with a wallet that is spending again. The same reason
   * POST /v1/wallet/pause skips the check on an idempotent resume.
   */
  app.post('/v1/wallet-controls/:petId/resume', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const body = mutationBody.parse(request.body);
    // Checked before the token is spent, for the reason the pause route states.
    if (binding.status === 'active' || binding.status === 'recovered') return publicBinding(binding, options);
    if (binding.status !== 'paused') {
      return reply.code(409).send({
        type: 'wallet-control-not-resumable',
        title: 'This pet wallet control cannot be resumed in its current state',
        status: 409,
        ...publicBinding(binding, options),
      });
    }
    const wallet = store.wallets.get(petId);
    // A revoked signer outranks a pause, exactly as in modules/controls.ts: recovering it is the
    // named way out (POST /v1/wallet-controls/:petId/recover-agent, or POST /v1/wallet/recover).
    if (wallet?.signerRevoked) {
      return reply.code(409).send({
        type: 'signer-revoked', title: 'Recover the restricted signer before resuming spending', status: 409,
        ...publicBinding(binding, options),
      });
    }
    if (wallet?.paused && !(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'wallet-resume', consumedStepUpTokens, {
      resourceId: petId,
      intentHash: stepUpIntentHash({ operation: 'wallet-resume', petId, walletId: wallet.walletId }),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    let resumed;
    try {
      resumed = options.service.resume(owned.ownerId, petId);
    } catch {
      // The binding changed between the guard and the transition.
      const current = options.repository.getBinding(owned.ownerId, petId);
      return reply.code(409).send({
        type: 'wallet-control-not-resumable',
        title: 'This pet wallet control cannot be resumed in its current state',
        status: 409,
        ...(current ? publicBinding(current, options) : {}),
      });
    }
    // Only the pause this control set. Any other reason stays authoritative.
    if (wallet && wallet.pauseReason === 'owner') { wallet.paused = false; delete wallet.pauseReason; }
    // Re-synchronizing the mandate is /verify's job, and it is reachable again from here.
    return publicBinding(resumed, options);
  });

  app.get('/v1/wallet-controls/:petId/revoke-agent-intent', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const scope = walletControlRevokeIntent(binding);
    return { action: 'wallet-revoke', resourceId: owned.ownerId, intentHash: stepUpIntentHash(scope), scope };
  });

  app.post('/v1/wallet-controls/:petId/revoke-agent', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const body = mutationBody.parse(request.body);
    if (!(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'wallet-revoke', consumedStepUpTokens, {
      resourceId: owned.ownerId, intentHash: stepUpIntentHash(walletControlRevokeIntent(binding)),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    try {
      const prepared = options.service.prepareClientSignerRevocation(owned.ownerId, petId);
      // Contain first. This is the emergency control, so MeowWa stops spending here, not when a
      // client that may already be compromised gets around to calling complete-agent-revocation.
      // Detaching the signer is the owner's own step at Privy and the binding stays 'active' until
      // that completion call verifies it, so the confirmation must promise the stop, not the detach.
      markPetSignerRevoked(store, petId, false);
      if (prepared.status === 'revoked') return publicBinding(prepared.binding, options);
      return reply.code(202).send(prepared);
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-revocation-preparation', ...walletControlProviderDiagnostic(error) },
        'Wallet control revocation preparation failed');
      return reply.code(502).send({ type: 'wallet-control-revocation-unverified', title: 'Agent signer revocation could not be verified', status: 502 });
    }
  });

  app.post('/v1/wallet-controls/:petId/complete-agent-revocation', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    const body = signerRevocationCompletionBody.parse(request.body);
    try {
      // A repeat completion returns the already-revoked binding without re-inspecting Privy, so it
      // proves nothing new and must not append a second confirmation line.
      const confirmsDetachment = options.repository.getBinding(owned.ownerId, petId)?.status !== 'revoked';
      const revoked = await options.service.completeClientSignerRevocation(
        owned.ownerId, petId, body.expectedBindingVersion,
      );
      if (revoked.status !== 'revoked' || revoked.signerStatus !== 'revoked') {
        return reply.code(409).send({
          type: 'wallet-control-revocation-unverified', title: 'Agent signer revocation requires review', status: 409,
          ...publicBinding(revoked, options),
        });
      }
      markPetSignerRevoked(store, petId, confirmsDetachment);
      return publicBinding(revoked, options);
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-revocation-completion', ...walletControlProviderDiagnostic(error) },
        'Wallet control revocation verification failed');
      return reply.code(502).send({ type: 'wallet-control-revocation-unverified', title: 'Agent signer revocation could not be verified', status: 502 });
    }
  });

  app.get('/v1/wallet-controls/:petId/recover-agent-intent', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const scope = walletControlRecoveryIntent(binding);
    return { action: 'wallet-recover', resourceId: owned.ownerId, intentHash: stepUpIntentHash(scope), scope };
  });

  app.post('/v1/wallet-controls/:petId/recover-agent', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const body = mutationBody.parse(request.body);
    if (!(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'wallet-recover', consumedStepUpTokens, {
      resourceId: owned.ownerId, intentHash: stepUpIntentHash(walletControlRecoveryIntent(binding)),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    if (petHasUnresolvedWalletActivity(store, petId)) {
      return reply.code(409).send({
        type: 'wallet-recovery-reconciliation-required',
        title: 'Reconcile submitted pet-wallet activity before restoring agent access', status: 409,
      });
    }
    try {
      return reply.code(202).send(options.service.prepareClientSignerRecovery(owned.ownerId, petId));
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-recovery-preparation', ...walletControlProviderDiagnostic(error) },
        'Wallet control recovery preparation failed');
      return reply.code(502).send({ type: 'wallet-control-recovery-unverified', title: 'Agent signer recovery could not be verified', status: 502 });
    }
  });

  app.post('/v1/wallet-controls/:petId/complete-agent-recovery', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    const body = signerRecoveryCompletionBody.parse(request.body);
    if (petHasUnresolvedWalletActivity(store, petId)) {
      return reply.code(409).send({
        type: 'wallet-recovery-reconciliation-required',
        title: 'Reconcile submitted pet-wallet activity before restoring agent access', status: 409,
      });
    }
    try {
      const recovered = await options.service.completeClientSignerRecovery(owned.ownerId, petId, body);
      markPetSignerRecovered(store, petId);
      return publicBinding(recovered, options);
    } catch (error) {
      request.log.warn({ operation: 'wallet-control-recovery-completion', ...walletControlProviderDiagnostic(error) },
        'Wallet control recovery verification failed');
      return reply.code(502).send({ type: 'wallet-control-recovery-unverified', title: 'Agent signer recovery could not be verified', status: 502 });
    }
  });

  app.get('/v1/wallet-controls/:petId/owner-escape-intent', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding?.smartWalletAddress) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet recovery is unavailable', status: 404 });
    const scope = walletControlOwnerEscapeIntent(binding);
    return { action: 'wallet-recover', resourceId: owned.ownerId, intentHash: stepUpIntentHash(scope), scope };
  });

  app.post('/v1/wallet-controls/:petId/prepare-owner-escape', async (request, reply) => {
    const { petId } = request.params as { petId: string };
    const owned = ownerAndPet(request, store, petId);
    if (!owned) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet control not found', status: 404 });
    if (!(await verifiedPrivyOwner(request, options))) return reply.code(403).send({ type: 'privy-owner-required', title: 'Verified Privy owner authorization is required', status: 403 });
    const binding = options.repository.getBinding(owned.ownerId, petId);
    if (!binding?.smartWalletAddress) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet recovery is unavailable', status: 404 });
    const body = mutationBody.parse(request.body);
    if (!(await consumeVerifiedStepUp(request.headers, body.stepUpVerified, 'wallet-recover', consumedStepUpTokens, {
      resourceId: owned.ownerId, intentHash: stepUpIntentHash(walletControlOwnerEscapeIntent(binding)),
    }))) return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    // This is the escape hatch an owner reaches for when they no longer trust MeowWa, so MeowWa
    // gives up what MeowWa holds -- and that is all it can give up. Detaching the agent signer takes
    // the owner's own Privy credential (updateWalletAdditionalSigner carries an owner JWT) and the
    // spend policy is user-owned by construction, so no server-side call can make the owner's
    // control sole. Say which step is still outstanding instead of letting a bare
    // 'owner-action-required' read as 'nothing left to do'.
    markPetSignerRevoked(store, petId, false);
    appendAudit(store, {
      eventType: 'WALLET_OWNER_ESCAPE_PREPARED', aggregateId: binding.bindingId,
      actorType: 'owner', actorId: owned.ownerId,
      summary: 'Owner recovery details released and MeowWa spending locked; the agent signer is still attached at the provider',
      metadata: { petId, agentSignerId: options.agentSignerId, agentPolicyId: binding.agentPolicyId, providerSignerDetached: false },
    });
    appendNotification(store, {
      // SIGNER_REVOKED is the type ownerVisibleNotifications keeps when in-app notices are switched
      // off, and this is the one an owner leaving MeowWa must not miss. Its own dedupe key so it
      // still lands on a wallet a previous revoke-agent had already locked.
      type: 'SIGNER_REVOKED',
      message: 'MeowWa can no longer spend from this pet wallet and you now hold its recovery details. ' +
        "MeowWa's agent signer is still attached at your wallet provider until you remove it there.",
      dedupeKey: `security:owner-escape:${petId}`,
    });
    return reply.code(202).send({
      status: 'owner-action-required',
      walletAddress: binding.smartWalletAddress,
      // The action, named. Removing the signer is the owner's to do at Privy; all this server can do
      // afterwards is verify it, which is what complete-agent-revocation inspects.
      remainingOwnerAction: {
        detachAgentSigner: options.agentSignerId,
        agentPolicyId: binding.agentPolicyId,
        confirmWith: `POST /v1/wallet-controls/${petId}/complete-agent-revocation`,
        expectedBindingVersion: binding.version,
      },
    });
  });

  if (options.closeRepositoryOnClose) app.addHook('onClose', async () => options.repository.close());
}
