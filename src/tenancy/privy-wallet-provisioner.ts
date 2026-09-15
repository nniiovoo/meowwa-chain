import { createHash } from 'node:crypto';
import { encryptTenantJson } from './crypto.js';
import { isCanonicalTenantId } from '../auth.js';
import { isControlChainKey, type ControlChainKey } from '../funding/types.js';
import { buildAgentSignerPolicy, policyDigest } from '../wallet-control/policy.js';
import type { WalletControlProvider, WalletControlProviderInspection } from '../wallet-control/provider.js';
import { solanaWalletId, type TenantWalletBinding } from './financial-repository.js';
import type {
  TenantWalletProvisioningAttachment,
  TenantWalletProvisioningClient,
  TenantWalletProvisioningResult,
} from './funding-routes.js';
import { CHAINS, isChainAddress, sameChainAddress } from '@meowwa/chain-domain';

/** A control-plane network descriptor: the test network a pet wallet is provisioned and attested on. */
export type ControlChainDescriptor = (typeof CHAINS)[ControlChainKey];

export interface TenantWalletBindingWriter {
  getVerifiedBinding(tenantId: string, petId: string, chainKey?: ControlChainKey): Promise<TenantWalletBinding | undefined>;
  stageExpiredPolicyRotation(input: {
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
  }): Promise<TenantWalletBinding>;
  recordPolicyRotationTarget(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    expectedPolicyId: string;
    targetPolicyId: string;
    policyDigest: string;
    policyValidUntil: string;
  }): Promise<TenantWalletBinding>;
  activateVerifiedPolicyRotation(input: {
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
  }): Promise<TenantWalletBinding>;
  saveVerifiedBinding(input: {
    tenantId: string;
    walletId: string;
    petId: string;
    chainKey: ControlChainKey;
    privyEmbeddedWalletId: string;
    smartWalletAddress: string;
    ownerQuorumId: string;
    ownerIdentityCiphertext: string;
    agentSignerId: string;
    agentPolicyId: string;
    policyDigest: string;
    policyValidUntil: string;
    controlVerifiedAt: string;
    productionFunding?: boolean;
  }): Promise<TenantWalletBinding>;
  close?(): Promise<void>;
}

interface TenantWalletControlConfig {
  agentSignerId: string;
  /** Encrypts the owner DID at rest. Provisioner-only key; api and worker never hold it. */
  identityKey: Buffer;
  /** Recipients of this provisioner's family: EVM addresses for Base Sepolia, base58 for Solana Devnet. */
  allowedRecipients: readonly string[];
  perTransactionLimitAtomic: string;
  maxDurationSeconds: number;
  productionFunding?: boolean;
  /**
   * The control-plane network this provisioner serves. One provisioner (and one Privy control
   * provider) per family; the default is the Base Sepolia sandbox every existing binding lives on.
   */
  chain?: ControlChainDescriptor;
  now?: () => Date;
}

function validIdentifier(value: string, maximum = 512): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value;
}

/**
 * The wallet id a binding on a control chain carries. The API names a pet's wallet once (the
 * store's `pet.walletId`); the pet's Solana binding is that id with the `_solana` suffix the
 * repository requires, so both families' rows sit under the one (tenant_id, wallet_id) key space
 * without colliding. Tolerates an id that already carries the suffix.
 */
export function bindingWalletIdFor(chainKey: ControlChainKey, walletId: string): string {
  if (chainKey !== 'solana_devnet') return walletId;
  return walletId.endsWith('_solana') ? walletId : solanaWalletId(walletId);
}

/** The control chain a provisioning request names; Base Sepolia when it names none. */
export function requestedControlChain(chain: string | undefined): ControlChainKey {
  if (chain === undefined) return 'base_sepolia';
  if (!isControlChainKey(chain)) throw new Error('Tenant Privy wallet provisioning chain is invalid');
  return chain;
}

function stableId(
  prefix: string,
  input: { tenantId: string; petId: string; walletId: string },
  discriminator = '',
): string {
  const rotationSuffix = discriminator ? `\0${discriminator}` : '';
  const digest = createHash('sha256')
    .update(`meowwa:tenant-wallet-control:v1\0${input.tenantId}\0${input.petId}\0${input.walletId}${rotationSuffix}`, 'utf8')
    .digest('hex');
  return `${prefix}_${digest.slice(0, 48)}`;
}

function legacyStableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash('sha256').update(values.join(':')).digest('hex').slice(0, 32)}`;
}

function legacyWalletExternalId(input: {
  ownerSubject: string;
  privyUserId: string;
  petId: string;
  walletId: string;
}): string {
  const bindingId = legacyStableId('wcb', [input.ownerSubject, input.petId, input.walletId, input.privyUserId]);
  return legacyStableId('meowwa_control', [bindingId]);
}

interface RecoverableProviderWallet {
  embeddedWalletId: string;
  smartWalletAddress: string;
  removeExistingSigners: boolean;
}

type WalletProvisioningStage =
  | 'load-binding'
  | 'recover-wallet'
  | 'validate-recovery'
  | 'create-policy'
  | 'validate-policy'
  | 'create-wallet'
  | 'rotate-policy'
  | 'inspect-control'
  | 'validate-control'
  | 'save-binding';

export class TenantWalletProvisioningStageError extends Error {
  constructor(readonly stage: WalletProvisioningStage, cause: unknown) {
    super('Tenant wallet provisioning step failed', { cause });
    this.name = 'TenantWalletProvisioningStageError';
  }
}

async function atProvisioningStage<T>(stage: WalletProvisioningStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TenantWalletProvisioningStageError) throw error;
    throw new TenantWalletProvisioningStageError(stage, error);
  }
}

function exactInspection(
  chain: ControlChainDescriptor,
  inspection: WalletControlProviderInspection,
  input: { privyUserId: string; embeddedWalletId: string; address: string; agentSignerId: string; policyId: string; digest: string },
): boolean {
  return inspection.userLinked && inspection.privyUserId === input.privyUserId &&
    inspection.embeddedWalletId === input.embeddedWalletId &&
    sameChainAddress(chain, inspection.smartWalletAddress, input.address) &&
    inspection.smartWalletType === 'embedded_hd' && typeof inspection.ownerResourceId === 'string' &&
    inspection.ownerResourceId.length > 0 && inspection.policy.ownerResourceId === inspection.ownerResourceId &&
    inspection.policy.policyId === input.policyId &&
    inspection.policy.digest === input.digest && inspection.policy.ownerType === 'privy_user' &&
    inspection.agentSigners.length === 1 && inspection.agentSigners[0]?.signerId === input.agentSignerId &&
    inspection.agentSigners[0].overridePolicyIds.length === 1 &&
    inspection.agentSigners[0].overridePolicyIds[0] === input.policyId;
}

interface ProvisioningRequest {
  tenantId: string;
  ownerSubject: string;
  privyUserId: string;
  petId: string;
  walletId: string;
  chain?: ControlChainKey | undefined;
}

interface ProvisioningCompletion extends ProvisioningRequest {
  agentPolicyId: string;
  expectedPolicyDigest: string;
  policyValidUntil: string;
}

/** A request with its wallet id resolved to the binding id of this provisioner's chain. */
type ResolvedRequest = Omit<ProvisioningRequest, 'chain'>;

/**
 * Provisions one Privy pet wallet per pet on ONE control-plane network. The chain decides the
 * Privy wallet type, the policy's network and recipient shape, how addresses compare, and the
 * binding's wallet id; a request naming another chain is refused rather than silently served on
 * this one. `TenantWalletProvisioningRouter` puts one of these per family behind the client
 * contract.
 */
export class TenantPrivyPetWalletProvisioner implements TenantWalletProvisioningClient {
  readonly #inFlight = new Map<string, Promise<TenantWalletProvisioningResult>>();
  readonly #completions = new Map<string, Promise<TenantWalletBinding>>();
  readonly #now: () => Date;
  readonly #chain: ControlChainDescriptor;

  constructor(
    private readonly provider: WalletControlProvider,
    private readonly repository: TenantWalletBindingWriter,
    private readonly control: TenantWalletControlConfig,
  ) {
    this.#now = control.now ?? (() => new Date());
    this.#chain = control.chain ?? CHAINS.base_sepolia;
  }

  get chain(): ControlChainDescriptor {
    return this.#chain;
  }

  #policy(input: { privyUserId: string; petId: string }, validUntil: string) {
    return buildAgentSignerPolicy({
      ownerPrivyUserId: input.privyUserId,
      petId: input.petId,
      allowedRecipients: this.control.allowedRecipients,
      perTransactionLimitAtomic: this.control.perTransactionLimitAtomic,
      validUntil,
    }, this.#chain);
  }

  #resolve<T extends ProvisioningRequest>(input: T): Omit<T, 'chain'> | undefined {
    let chain: ControlChainKey;
    try { chain = requestedControlChain(input.chain); } catch { return undefined; }
    if (chain !== this.#chain.key) return undefined;
    const { chain: _chain, ...rest } = input;
    void _chain;
    const walletId = bindingWalletIdFor(chain, input.walletId);
    if (!validIdentifier(walletId, 255)) return undefined;
    return { ...rest, walletId };
  }

  provision(input: ProvisioningRequest): Promise<TenantWalletProvisioningResult> {
    const resolved = this.#resolve(input);
    if (!resolved || !isCanonicalTenantId(input.tenantId) || !validIdentifier(input.ownerSubject) ||
      !validIdentifier(input.privyUserId) || !input.privyUserId.startsWith('did:privy:') ||
      !validIdentifier(input.petId, 255) || !validIdentifier(input.walletId, 255)) {
      return Promise.reject(new Error('Tenant Privy wallet provisioning request is invalid'));
    }
    const key = `${input.tenantId}:${input.petId}:${this.#chain.key}`;
    const active = this.#inFlight.get(key);
    if (active) return active;
    const operation = this.#provision(resolved).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, operation);
    return operation;
  }

  async #provision(input: ResolvedRequest): Promise<TenantWalletProvisioningResult> {
    const existing = await atProvisioningStage('load-binding', () =>
      this.repository.getVerifiedBinding(input.tenantId, input.petId, this.#chain.key));
    if (existing && (existing.walletId !== input.walletId || existing.chainKey !== this.#chain.key ||
      !['active', 'provisioning'].includes(existing.status))) {
      throw new Error('Pet already has a different verified wallet binding');
    }
    const verifiedAt = this.#now();
    if (!Number.isFinite(verifiedAt.getTime())) throw new Error('Wallet control verification time is invalid');
    const proposedValidUntil = new Date(
      verifiedAt.getTime() + this.control.maxDurationSeconds * 1_000,
    ).toISOString();

    if (existing?.agentSignerId && existing.agentSignerId !== this.control.agentSignerId) {
      throw new Error('Stored tenant wallet control uses a different agent signer');
    }
    if (existing?.status === 'provisioning' ||
      (existing?.policyValidUntil !== null && existing?.policyValidUntil !== undefined &&
        Date.parse(existing.policyValidUntil) <= verifiedAt.getTime())) {
      return this.#rotatePolicy(input, existing, proposedValidUntil, verifiedAt);
    }

    const validUntil = existing?.policyValidUntil ?? proposedValidUntil;
    const policy = this.#policy(input, validUntil);
    const digest = policyDigest(policy);
    let agentPolicyId = existing?.agentPolicyId ?? null;
    let embeddedWalletId = existing?.privyEmbeddedWalletId;
    let address = existing?.smartWalletAddress;
    const recoverableWallet = existing ? undefined : await this.#findRecoverableProviderWallet(input);

    if (existing?.policyDigest) {
      if (existing.policyDigest !== digest) {
        throw new Error('Stored tenant wallet control policy does not match current rules');
      }
    }
    if (!agentPolicyId) {
      const created = await atProvisioningStage('create-policy', () => this.provider.createUserOwnedPolicy({
        privyUserId: input.privyUserId,
        policy,
        // The expiry is part of the policy body. Scope retries to that exact body so a later
        // owner-authorized recovery never reuses an idempotency key with changed rules.
        idempotencyKey: stableId('meowwa_policy', input, digest),
      }));
      if (created.ownerType !== 'privy_user' || created.digest !== digest) {
        throw new TenantWalletProvisioningStageError(
          'validate-policy', new Error('Privy wallet policy did not match the tenant control rules'),
        );
      }
      agentPolicyId = created.policyId;
    }

    if (recoverableWallet) {
      return this.#ownerAuthorizationRequired(
        recoverableWallet.smartWalletAddress,
        agentPolicyId,
        digest,
        validUntil,
        recoverableWallet.removeExistingSigners,
      );
    } else if (!existing) {
      const wallet = await atProvisioningStage('create-wallet', () => this.provider.provisionUserWallet({
        privyUserId: input.privyUserId,
        externalId: stableId('meowwa_wallet', input),
        agentSignerId: this.control.agentSignerId,
        agentPolicyId,
        // The request body includes the policy id. A new policy must therefore use a distinct
        // provider idempotency key while the write-once external id remains stable.
        idempotencyKey: stableId('meowwa_wallet', input, agentPolicyId),
      }));
      if (!isChainAddress(this.#chain, wallet.smartWalletAddress)) {
        throw new TenantWalletProvisioningStageError(
          'create-wallet', new Error(`Privy wallet address is not a ${this.#chain.displayName} address`),
        );
      }
      embeddedWalletId = wallet.embeddedWalletId;
      address = wallet.smartWalletAddress;
    } else if (!existing.agentSignerId) {
      throw new Error('Existing wallet requires owner-client signer authorization');
    }
    if (!embeddedWalletId || !address) throw new Error('Privy wallet control binding is incomplete');
    const inspection = await atProvisioningStage('inspect-control', () => this.provider.inspectBinding({
      privyUserId: input.privyUserId,
      embeddedWalletId,
      smartWalletAddress: address,
      agentPolicyId,
      expectedPolicy: policy,
    }));
    if (!exactInspection(this.#chain, inspection, {
      privyUserId: input.privyUserId,
      embeddedWalletId,
      address,
      agentSignerId: this.control.agentSignerId,
      policyId: agentPolicyId,
      digest,
    })) {
      throw new TenantWalletProvisioningStageError(
        'validate-control', new Error('Privy wallet control could not be verified'),
      );
    }
    return atProvisioningStage('save-binding', () => this.repository.saveVerifiedBinding({
      tenantId: input.tenantId,
      walletId: input.walletId,
      petId: input.petId,
      chainKey: this.#chain.key,
      privyEmbeddedWalletId: embeddedWalletId,
      smartWalletAddress: address,
      ownerQuorumId: inspection.ownerResourceId!,
      // Encrypted here so the raw DID never reaches the repository or its SQL.
      ownerIdentityCiphertext: encryptTenantJson(
        this.control.identityKey, `meowwa:wallet-owner-identity:${input.tenantId}:${input.petId}`, input.privyUserId,
      ),
      agentSignerId: this.control.agentSignerId,
      agentPolicyId,
      policyDigest: digest,
      policyValidUntil: validUntil,
      controlVerifiedAt: verifiedAt.toISOString(),
      productionFunding: this.control.productionFunding === true,
    }));
  }

  #ownerAuthorizationRequired(
    walletAddress: string,
    agentPolicyId: string,
    expectedPolicyDigest: string,
    policyValidUntil: string,
    removeExistingSigners: boolean,
  ): { status: 'owner-authorization-required'; attachment: TenantWalletProvisioningAttachment } {
    return {
      status: 'owner-authorization-required',
      attachment: {
        // In the chain's own form: hex here on Base Sepolia, base58 on Solana Devnet. The client
        // knows which chain it asked for and picks the matching Privy signer API from that.
        walletAddress,
        agentSignerId: this.control.agentSignerId,
        agentPolicyId,
        expectedPolicyDigest,
        policyValidUntil,
        removeExistingSigners,
      },
    };
  }

  complete(input: ProvisioningCompletion): Promise<TenantWalletBinding> {
    const resolved = this.#resolve(input);
    if (!resolved || !isCanonicalTenantId(input.tenantId) || !validIdentifier(input.ownerSubject) ||
      !validIdentifier(input.privyUserId) || !input.privyUserId.startsWith('did:privy:') ||
      !validIdentifier(input.petId, 255) || !validIdentifier(input.walletId, 255) ||
      !validIdentifier(input.agentPolicyId, 255) || !/^[0-9a-f]{64}$/.test(input.expectedPolicyDigest) ||
      !Number.isFinite(Date.parse(input.policyValidUntil))) {
      return Promise.reject(new Error('Tenant Privy wallet provisioning completion is invalid'));
    }
    const key = `${input.tenantId}:${input.petId}:${this.#chain.key}`;
    const active = this.#completions.get(key);
    if (active) return active;
    const operation = this.#complete(resolved).finally(() => this.#completions.delete(key));
    this.#completions.set(key, operation);
    return operation;
  }

  async #complete(input: Omit<ProvisioningCompletion, 'chain'>): Promise<TenantWalletBinding> {
    const verifiedAt = this.#now();
    const policyValidUntil = new Date(input.policyValidUntil).toISOString();
    const policyValidUntilMs = Date.parse(policyValidUntil);
    if (!Number.isFinite(verifiedAt.getTime()) || policyValidUntilMs <= verifiedAt.getTime()) {
      throw new Error('Tenant Privy wallet provisioning authorization has expired');
    }
    // The browser completes an owner-authorized provider operation, but it does not choose the
    // lifetime of the agent authority. Bind that lifetime to the server's configured maximum so a
    // modified client cannot turn a short-lived preparation into an arbitrarily long policy.
    if (policyValidUntilMs > verifiedAt.getTime() + this.control.maxDurationSeconds * 1_000) {
      throw new Error('Tenant Privy wallet provisioning authorization exceeds the configured lifetime');
    }
    const policy = this.#policy(input, policyValidUntil);
    const digest = policyDigest(policy);
    if (digest !== input.expectedPolicyDigest) {
      throw new Error('Tenant Privy wallet provisioning policy does not match current rules');
    }
    const created = await atProvisioningStage('create-policy', () => this.provider.createUserOwnedPolicy({
      privyUserId: input.privyUserId,
      policy,
      idempotencyKey: stableId('meowwa_policy', input, digest),
    }));
    if (created.ownerType !== 'privy_user' || created.digest !== digest || created.policyId !== input.agentPolicyId) {
      throw new TenantWalletProvisioningStageError(
        'validate-policy', new Error('Privy wallet policy did not match the prepared tenant control rules'),
      );
    }

    const existing = await atProvisioningStage('load-binding', () =>
      this.repository.getVerifiedBinding(input.tenantId, input.petId, this.#chain.key));
    let embeddedWalletId: string;
    let smartWalletAddress: string;
    if (existing) {
      if (existing.walletId !== input.walletId || existing.chainKey !== this.#chain.key ||
        existing.agentSignerId !== this.control.agentSignerId ||
        existing.agentPolicyId !== input.agentPolicyId || existing.policyDigest !== digest ||
        existing.policyValidUntil !== policyValidUntil || !['active', 'provisioning'].includes(existing.status)) {
        throw new Error('Tenant wallet provisioning completion is stale');
      }
      embeddedWalletId = existing.privyEmbeddedWalletId;
      smartWalletAddress = existing.smartWalletAddress;
    } else {
      const recoverable = await this.#findRecoverableProviderWallet(input);
      if (!recoverable) throw new Error('Prepared Privy pet wallet could not be recovered');
      embeddedWalletId = recoverable.embeddedWalletId;
      smartWalletAddress = recoverable.smartWalletAddress;
    }

    const inspection = await atProvisioningStage('inspect-control', () => this.provider.inspectBinding({
      privyUserId: input.privyUserId,
      embeddedWalletId,
      smartWalletAddress,
      agentPolicyId: input.agentPolicyId,
      expectedPolicy: policy,
    }));
    if (!exactInspection(this.#chain, inspection, {
      privyUserId: input.privyUserId,
      embeddedWalletId,
      address: smartWalletAddress,
      agentSignerId: this.control.agentSignerId,
      policyId: input.agentPolicyId,
      digest,
    })) {
      throw new TenantWalletProvisioningStageError(
        'validate-control', new Error('Privy wallet control could not be verified after owner authorization'),
      );
    }
    if (existing?.status === 'provisioning') {
      return atProvisioningStage('save-binding', () => this.repository.activateVerifiedPolicyRotation({
        tenantId: input.tenantId,
        walletId: input.walletId,
        petId: input.petId,
        chainKey: this.#chain.key,
        ownerQuorumId: inspection.ownerResourceId!,
        agentSignerId: this.control.agentSignerId,
        targetPolicyId: input.agentPolicyId,
        policyDigest: digest,
        policyValidUntil,
        controlVerifiedAt: verifiedAt.toISOString(),
        productionFunding: this.control.productionFunding === true,
      }));
    }
    return atProvisioningStage('save-binding', () => this.repository.saveVerifiedBinding({
      tenantId: input.tenantId,
      walletId: input.walletId,
      petId: input.petId,
      chainKey: this.#chain.key,
      privyEmbeddedWalletId: embeddedWalletId,
      smartWalletAddress,
      ownerQuorumId: inspection.ownerResourceId!,
      ownerIdentityCiphertext: encryptTenantJson(
        this.control.identityKey, `meowwa:wallet-owner-identity:${input.tenantId}:${input.petId}`, input.privyUserId,
      ),
      agentSignerId: this.control.agentSignerId,
      agentPolicyId: input.agentPolicyId,
      policyDigest: digest,
      policyValidUntil,
      controlVerifiedAt: verifiedAt.toISOString(),
      productionFunding: this.control.productionFunding === true,
    }));
  }

  async #findRecoverableProviderWallet(input: ResolvedRequest): Promise<RecoverableProviderWallet | undefined> {
    if (!this.provider.findProvisionedWallet) return undefined;
    const currentExternalId = stableId('meowwa_wallet', input);
    // Legacy (pre-stable-id) wallets only ever existed on the EVM sandbox; a Solana wallet is
    // never adopted under that derivation.
    const externalIds = this.#chain.family === 'evm'
      ? [currentExternalId, legacyWalletExternalId(input)]
      : [currentExternalId];
    for (const externalId of externalIds) {
      const wallet = await atProvisioningStage('recover-wallet', () => this.provider.findProvisionedWallet!({
        externalId,
        privyUserId: input.privyUserId,
      }));
      if (!wallet) continue;
      const signer = wallet.agentSigners[0];
      const signerStateSafe = wallet.agentSigners.length === 0 ||
        (wallet.agentSigners.length === 1 && signer?.signerId === this.control.agentSignerId &&
          signer.overridePolicyIds.length === 1);
      if (wallet.userLinked !== true || typeof wallet.ownerResourceId !== 'string' || !wallet.ownerResourceId ||
        typeof wallet.smartWalletAddress !== 'string' || !isChainAddress(this.#chain, wallet.smartWalletAddress) ||
        !signerStateSafe) {
        throw new TenantWalletProvisioningStageError(
          'validate-recovery', new Error('Existing Privy pet wallet could not be safely recovered'),
        );
      }
      return {
        embeddedWalletId: wallet.embeddedWalletId,
        smartWalletAddress: wallet.smartWalletAddress,
        removeExistingSigners: wallet.agentSigners.length === 1,
      };
    }
    return undefined;
  }

  async #rotatePolicy(
    input: ResolvedRequest,
    existing: TenantWalletBinding,
    proposedValidUntil: string,
    verifiedAt: Date,
  ): Promise<TenantWalletProvisioningResult> {
    if (existing.agentSignerId !== this.control.agentSignerId || existing.agentPolicyId === null ||
      existing.policyDigest === null || existing.policyValidUntil === null || existing.controlVerifiedAt === null ||
      existing.ownerQuorumId === null) {
      throw new Error('Existing wallet requires owner-client signer authorization');
    }
    if (existing.status === 'active') {
      const currentPolicy = this.#policy(input, existing.policyValidUntil);
      if (existing.policyDigest !== policyDigest(currentPolicy)) {
        throw new Error('Stored tenant wallet control policy does not match current rules');
      }
    }
    const proposedPolicy = this.#policy(input, proposedValidUntil);
    let staged = await this.repository.stageExpiredPolicyRotation({
      tenantId: input.tenantId,
      walletId: input.walletId,
      petId: input.petId,
      chainKey: this.#chain.key,
      privyEmbeddedWalletId: existing.privyEmbeddedWalletId,
      smartWalletAddress: existing.smartWalletAddress,
      agentSignerId: this.control.agentSignerId,
      proposedPolicyDigest: policyDigest(proposedPolicy),
      proposedPolicyValidUntil: proposedValidUntil,
      plannedAt: verifiedAt.toISOString(),
    });
    if (staged.status !== 'provisioning' || staged.agentPolicyId === null || staged.policyDigest === null ||
      staged.policyValidUntil === null) {
      throw new Error('Tenant wallet policy rotation plan is invalid');
    }
    const targetPolicy = this.#policy(input, staged.policyValidUntil);
    const targetDigest = policyDigest(targetPolicy);
    if (staged.policyDigest !== targetDigest) {
      throw new Error('Stored tenant wallet policy rotation does not match current rules');
    }
    const created = await this.provider.createUserOwnedPolicy({
      privyUserId: input.privyUserId,
      policy: targetPolicy,
      idempotencyKey: stableId('meowwa_policy', input, targetDigest),
    });
    if (created.ownerType !== 'privy_user' || created.digest !== targetDigest) {
      throw new Error('Privy wallet policy did not match the tenant control rules');
    }
    staged = await this.repository.recordPolicyRotationTarget({
      tenantId: input.tenantId,
      walletId: input.walletId,
      petId: input.petId,
      expectedPolicyId: staged.agentPolicyId,
      targetPolicyId: created.policyId,
      policyDigest: targetDigest,
      policyValidUntil: staged.policyValidUntil,
    });
    return this.#ownerAuthorizationRequired(
      staged.smartWalletAddress, created.policyId, targetDigest, staged.policyValidUntil!, true,
    );
  }

  async close(): Promise<void> {
    await this.repository.close?.();
  }
}

interface SelectedProvisioner {
  chain: ControlChainKey;
  provisioner: TenantWalletProvisioningClient;
}

/**
 * The client contract over one provisioner per enabled control chain. A request names its chain
 * (`chain`, Base Sepolia when absent) and is served by that family's provisioner; a chain nobody
 * was configured for is refused before any provider call, which is how the Solana rail stays
 * inert until it is switched on.
 */
export class TenantWalletProvisioningRouter implements TenantWalletProvisioningClient {
  readonly #provisioners: ReadonlyMap<ControlChainKey, TenantWalletProvisioningClient>;
  readonly #close: (() => Promise<void>) | undefined;

  constructor(
    provisioners: ReadonlyMap<ControlChainKey, TenantWalletProvisioningClient>,
    options: {
      /**
       * Closes what the provisioners share. Without it each provisioner is closed once; with a
       * shared repository that would end the same pool twice, so the caller closes it here instead.
       */
      close?: () => Promise<void>;
    } = {},
  ) {
    if (provisioners.size === 0) throw new Error('At least one tenant wallet provisioner chain is required');
    this.#provisioners = provisioners;
    this.#close = options.close;
  }

  get chains(): ControlChainKey[] {
    return [...this.#provisioners.keys()];
  }

  #select(chain: string | undefined): SelectedProvisioner {
    const key = requestedControlChain(chain);
    const provisioner = this.#provisioners.get(key);
    if (!provisioner) throw new Error(`Tenant wallet provisioning is not enabled on ${CHAINS[key].displayName}`);
    return { chain: key, provisioner };
  }

  provision(input: ProvisioningRequest): Promise<TenantWalletProvisioningResult> {
    let selected: SelectedProvisioner;
    try { selected = this.#select(input.chain); } catch (error) { return Promise.reject(error); }
    return selected.provisioner.provision({ ...input, chain: selected.chain });
  }

  complete(input: ProvisioningCompletion): Promise<TenantWalletBinding> {
    let selected: SelectedProvisioner;
    try { selected = this.#select(input.chain); } catch (error) { return Promise.reject(error); }
    return selected.provisioner.complete({ ...input, chain: selected.chain });
  }

  async close(): Promise<void> {
    if (this.#close) {
      await this.#close();
      return;
    }
    for (const provisioner of new Set(this.#provisioners.values())) await provisioner.close?.();
  }
}
