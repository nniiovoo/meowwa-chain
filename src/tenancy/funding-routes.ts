import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CHAINS,
  isChainAddress,
  isChainTransactionId,
  normalizeChainAddress,
  sameChainAddress,
  type ChainDescriptor,
} from '@meowwa/chain-domain';
import { consumeVerifiedStepUp, isCanonicalTenantId, stepUpIntentHash, type StepUpReplayStore } from '../auth.js';
import type { OwnerIdentityVerifier } from '../funding/privy.js';
import {
  StripeOnrampError,
  stripeOnrampNetwork,
  type OnrampSessionProvider,
  type VerifiedOnrampSession,
} from '../funding/stripe-onramp.js';
import {
  canonicalChainTransactionId,
  controlChainFor,
  fundingChainFor,
  type ControlChainKey,
  type FundingChainKey,
} from '../funding/types.js';
import { archivedPetFundingRefusal } from '../modules/pet-archive.js';
import { DISCLOSABLE_TEXT_REQUIREMENT, isDisclosableText } from '../modules/sandbox-auth.js';
import { appendAudit, appendNotification, nextId, parseIdempotencyKey, newReceiveToken, retireDerivedReceiveToken, syncPocUsdcHolding, walletForPet, type AppStore } from '../store/memory-store.js';
import {
  TenantFundingIdempotencyConflictError,
  TenantWithdrawalIdempotencyConflictError,
  TenantWithdrawalDispatchConflictError,
  TenantWithdrawalInsufficientFundsError,
  TenantWithdrawalSettledError,
  solanaWalletId,
  tenantWalletBindingFingerprint,
  type TenantFundingTransaction,
  type TenantWalletBinding,
  type TenantWithdrawal,
  type TenantWithdrawalDestination,
} from './financial-repository.js';
import type { TenantIdentityResolver } from './identity.js';

export interface TenantFundingRouteRepository {
  /** The pet's active binding on one control network; Base Sepolia when the caller names none. */
  getActiveWalletBinding(tenantId: string, petId: string, chainKey?: ControlChainKey): Promise<TenantWalletBinding | undefined>;
  /**
   * Every active binding the pet holds, one per control network. Optional: a repository that
   * serves a single rail answers through `getActiveWalletBinding` alone.
   */
  listActiveWalletBindings?(tenantId: string, petId: string): Promise<TenantWalletBinding[]>;
  setPetArchived?(tenantId: string, petId: string, archivedAt: string | null): Promise<boolean>;
  inspectPetDeletion?(tenantId: string, petId: string): Promise<{
    blockers: Array<'not_found' | 'not_archived' | 'signer_not_revoked' | 'nonzero_balance' |
      'funding_unsettled' | 'payment_unsettled' | 'merchant_unsettled' | 'withdrawal_unsettled' |
      'financial_review_open'>;
    deletedAt: string | null;
    deletionReceiptId: string | null;
  }>;
  finalizePetDeletion?(input: { tenantId: string; petId: string; deletionReceiptId: string }): Promise<{
    deletedAt: string; deletionReceiptId: string; newlyDeleted: boolean;
  }>;
  getWalletLedgerBalance?(tenantId: string, walletId: string): Promise<string>;
  createPendingFunding(input: {
    tenantId: string;
    operation: string;
    idempotencyKey: string;
    requestFingerprint: string;
    fundingId: string;
    petId: string;
    walletId: string;
    chainKey: FundingChainKey;
    walletAddress: string;
    rail: 'stripe_onramp';
    sourceAmountMinor: number | null;
  }): Promise<{ transaction: TenantFundingTransaction; reused: boolean }>;
  attachProviderSession(tenantId: string, fundingId: string, providerSessionId: string): Promise<TenantFundingTransaction>;
  getFunding(tenantId: string, fundingId: string): Promise<TenantFundingTransaction | undefined>;
  listFunding(tenantId: string, limit?: number): Promise<TenantFundingTransaction[]>;
  registerWithdrawalDestination(input: {
    tenantId: string; destinationId: string; chainKey: FundingChainKey; address: string; label: string; registeredBy: string;
  }): Promise<TenantWithdrawalDestination>;
  listWithdrawalDestinations(tenantId: string): Promise<TenantWithdrawalDestination[]>;
  retireWithdrawalDestination(tenantId: string, destinationId: string): Promise<TenantWithdrawalDestination | undefined>;
  createPreparedWithdrawal(input: {
    tenantId: string; idempotencyKey: string; requestFingerprint: string; withdrawalId: string;
    ownerSubject: string; petId: string; walletId: string; chainKey: FundingChainKey; walletAddress: string;
    bindingFingerprint: string; destinationId: string; destinationAddress: string;
    amountAtomic: string; tokenAddress: string;
  }): Promise<{ withdrawal: TenantWithdrawal; reused: boolean }>;
  listWithdrawals(tenantId: string, limit?: number): Promise<TenantWithdrawal[]>;
  expireStaleWithdrawals(tenantId: string, walletId: string): Promise<TenantWithdrawal[]>;
  markWithdrawalDispatched(
    tenantId: string, withdrawalId: string,
  ): Promise<{ withdrawal: TenantWithdrawal; applied: boolean } | undefined>;
  cancelPreparedWithdrawal(
    tenantId: string, withdrawalId: string,
  ): Promise<{ withdrawal: TenantWithdrawal; applied: boolean } | undefined>;
  /** The hash is in the rail's storage form already: lowercase hex on Base, the base58 signature verbatim on Solana. */
  acknowledgeWithdrawalBroadcast(
    tenantId: string, withdrawalId: string, transactionHash: string,
  ): Promise<{ withdrawal: TenantWithdrawal; applied: boolean } | undefined>;
  close?(): Promise<void>;
}

export interface TenantWalletProvisioningClient {
  provision(input: {
    tenantId: string;
    ownerSubject: string;
    privyUserId: string;
    petId: string;
    /** The pet's wallet id. The provisioner derives the Solana binding's id from it (`solanaWalletId`). */
    walletId: string;
    /** The control network the wallet is provisioned and attested on. */
    chain: ControlChainKey;
  }): Promise<TenantWalletProvisioningResult>;
  complete(input: {
    tenantId: string;
    ownerSubject: string;
    privyUserId: string;
    petId: string;
    walletId: string;
    chain: ControlChainKey;
    agentPolicyId: string;
    expectedPolicyDigest: string;
    policyValidUntil: string;
  }): Promise<TenantWalletBinding>;
  /** Confirms an owner-authorized detachment. Only the provisioner can: it holds the Privy secret. */
  verifyRevocation?(input: { tenantId: string; petId: string }): Promise<{ status: 'revoked' | 'drifted'; reason: string }>;
  close?(): Promise<void>;
}

export interface TenantWalletProvisioningAttachment {
  /** The wallet address in its chain's form: hex on an EVM network, base58 on Solana. */
  walletAddress: string;
  agentSignerId: string;
  agentPolicyId: string;
  expectedPolicyDigest: string;
  policyValidUntil: string;
  /** False after a previous owner-side replacement already removed every additional signer. */
  removeExistingSigners: boolean;
}

export type TenantWalletProvisioningResult = TenantWalletBinding | {
  status: 'owner-authorization-required';
  attachment: TenantWalletProvisioningAttachment;
};

export interface TenantWalletProvisioningModuleOptions {
  repository: TenantFundingRouteRepository;
  provisioner: TenantWalletProvisioningClient;
  identityVerifier: OwnerIdentityVerifier;
  identityResolver: TenantIdentityResolver;
  /**
   * The production rails this deployment funds (MEOWWA_FUNDING_CHAINS). A pet wallet is
   * provisioned on the control network of one of these and nothing else; absent, as in the
   * development provisioning exercise, only the Base pair is reachable.
   */
  fundingChains?: readonly FundingChainKey[];
  closeResourcesOnClose?: boolean;
}

export interface TenantFundingModuleOptions extends TenantWalletProvisioningModuleOptions {
  provider: OnrampSessionProvider;
  stripeLivemode: boolean;
  /**
   * The rails a withdrawal may settle on, from the same runtime configuration the indexer reads.
   * The chain id and token a withdrawal names come from the registry entry for one of these: when
   * the route carried its own constants it named a chain the indexer did not watch, and the
   * resulting outflow never became a ledger debit. A destination on any other rail is not
   * spendable here for the same reason.
   */
  fundingChains: readonly FundingChainKey[];
  stepUpReplay?: Set<string> | StepUpReplayStore;
}

const DEFAULT_FUNDING_CHAINS: readonly FundingChainKey[] = ['base'];

/** The public explorer each rail's notifications point the owner at. */
const EXPLORER_NAMES: Readonly<Record<FundingChainKey, string>> = { base: 'BaseScan', solana: 'Solscan' };

/** Optional on every rail-scoped body; absent means Base, which is what every pre-Solana client sends. */
const fundingChainBody: z.ZodType<FundingChainKey> = z.enum(['base', 'solana']);

const createSessionBody = z.object({
  petId: z.string().min(1).max(255),
  sourceAmountMinor: z.number().int().min(100).max(100_000).optional(),
  chain: fundingChainBody.optional(),
}).strict();
const provisionWalletBody = z.object({
  petId: z.string().min(1).max(255),
  chain: fundingChainBody.optional(),
}).strict();
const completeProvisionWalletBody = z.object({
  petId: z.string().min(1).max(255),
  chain: fundingChainBody.optional(),
  agentPolicyId: z.string().min(1).max(255),
  expectedPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  policyValidUntil: z.iso.datetime(),
}).strict();
const fundingParams = z.object({ fundingId: z.string().min(1).max(255) }).strict();

function stableHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The EVM chain id a rail is known by, or null on Solana, where the registry key is the identity. */
function evmChainIdOf(chain: ChainDescriptor): number | null {
  return chain.family === 'evm' ? chain.chainId : null;
}

function enabledFundingChains(options: TenantWalletProvisioningModuleOptions): readonly FundingChainKey[] {
  return options.fundingChains ?? DEFAULT_FUNDING_CHAINS;
}

function chainNotEnabled(reply: FastifyReply, chainKey: FundingChainKey) {
  return reply.code(409).send({
    type: 'chain-not-enabled', title: `${CHAINS[chainKey].displayName} is not an enabled funding rail`, status: 409,
  });
}

/** 'Base' for one rail, 'Base or Solana' for two: the rails a hash may belong to. */
function networkNames(chainKeys: readonly FundingChainKey[]): string {
  return chainKeys.map((chainKey) => CHAINS[chainKey].displayName).join(' or ');
}

function deterministicFundingId(tenantId: string, ownerSubject: string, idempotencyKey: string): string {
  const digest = stableHash(`meowwa:tenant-funding:v1\0${tenantId}\0${ownerSubject}\0create_onramp\0${idempotencyKey}`);
  return `funding_${digest.slice(0, 48)}`;
}

function requestFingerprint(input: {
  tenantId: string; ownerSubject: string; petId: string; chainKey: FundingChainKey; sourceAmountMinor?: number;
}): string {
  return stableHash(JSON.stringify({
    version: 1,
    tenantId: input.tenantId,
    ownerSubject: input.ownerSubject,
    petId: input.petId,
    sourceAmountMinor: input.sourceAmountMinor ?? null,
    destinationCurrency: 'usdc',
    // Stripe's name for the rail: 'base' is the literal every stored Base fingerprint was made
    // with, so those keep replaying, and a Solana session under a reused key conflicts instead
    // of resuming a Base one.
    destinationNetwork: stripeOnrampNetwork(input.chainKey),
  }));
}

function stripeIdempotencyKey(tenantId: string, ownerSubject: string, idempotencyKey: string): string {
  return `meowwa_${stableHash(`meowwa:stripe-onramp:v1\0${tenantId}\0${ownerSubject}\0${idempotencyKey}`)}`;
}

function deterministicWithdrawalId(tenantId: string, ownerSubject: string, idempotencyKey: string): string {
  const digest = stableHash(`meowwa:tenant-withdrawal:v1\0${tenantId}\0${ownerSubject}\0${idempotencyKey}`);
  return `withdrawal_${digest.slice(0, 48)}`;
}

function withdrawalRequestFingerprint(input: {
  tenantId: string; ownerSubject: string; petId: string; walletId: string;
  bindingFingerprint: string; destinationId: string; destinationAddress: string;
  amountAtomic: string; tokenAddress: string; chainKey: FundingChainKey;
}): string {
  const { chainKey, ...request } = input;
  const chain = CHAINS[chainKey];
  // Version 1 named Base by its numeric chain id alone. Those bytes stay exactly as they were, so
  // every stored Base fingerprint keeps verifying; a Solana rail has no numeric id and is named
  // by its key instead, which no Base fingerprint ever contained.
  return stableHash(JSON.stringify({
    version: 1,
    chainId: evmChainIdOf(chain),
    ...(chainKey === 'base' ? {} : { chainKey }),
    ...request,
  }));
}

/**
 * The `chain` field of a step-up intent as modules/sandbox-auth.ts hashes it: present only off
 * Base. The pre-Solana intents carried no chain, and their hash is what every Base credential in
 * flight verifies against, so Base keeps hashing the same bytes.
 */
function railIntentField(chainKey: FundingChainKey): { chain?: FundingChainKey } {
  return chainKey === 'base' ? {} : { chain: chainKey };
}

function ownerContext(store: AppStore, headers: Record<string, unknown>): { tenantId: string; ownerSubject: string } | undefined {
  const tenantId = headers['x-meowwa-tenant-id'];
  const ownerSubject = headers['x-owner-id'];
  if (typeof tenantId !== 'string' || !isCanonicalTenantId(tenantId) ||
    typeof ownerSubject !== 'string' || ownerSubject !== store.owner.ownerId) return undefined;
  return { tenantId, ownerSubject };
}

interface ExpectedBinding { tenantId: string; petId: string; walletId: string; chainKey: ControlChainKey }

/**
 * The binding a pet must hold on one control network. The pet's wallet id names its EVM binding;
 * the Solana binding's id is derived from it, so a pet can hold one binding per family under one
 * profile.
 */
function expectedBinding(tenantId: string, pet: { petId: string; walletId: string }, chainKey: ControlChainKey): ExpectedBinding {
  return {
    tenantId,
    petId: pet.petId,
    walletId: CHAINS[chainKey].family === 'solana' ? solanaWalletId(pet.walletId) : pet.walletId,
    chainKey,
  };
}

function walletControlBindingMatches(value: TenantWalletBinding, expected: ExpectedBinding): boolean {
  const fundingChainKey = fundingChainFor(expected.chainKey);
  const productionFunding = value.fundingChainKey === fundingChainKey &&
    value.fundingChainId === evmChainIdOf(CHAINS[fundingChainKey]) && value.fundingEnvironment === 'production' &&
    value.custodyClassification === 'owner_controlled' && typeof value.fundingVerifiedAt === 'string';
  const sandboxOnly = value.fundingChainKey === undefined && value.fundingChainId === undefined &&
    value.fundingEnvironment === undefined && value.custodyClassification === undefined && value.fundingVerifiedAt === undefined;
  return value.tenantId === expected.tenantId && value.petId === expected.petId && value.walletId === expected.walletId &&
    value.provider === 'privy' && value.chainKey === expected.chainKey &&
    value.chainId === evmChainIdOf(CHAINS[expected.chainKey]) && value.status === 'active' && (productionFunding || sandboxOnly) &&
    value.ownerQuorumId !== null &&
    value.agentSignerId !== null && value.agentPolicyId !== null && value.policyDigest !== null &&
    value.policyValidUntil !== null && value.controlVerifiedAt !== null;
}

function productionFundingBindingMatches(value: TenantWalletBinding, expected: ExpectedBinding): boolean {
  return walletControlBindingMatches(value, expected) && value.fundingChainKey === fundingChainFor(expected.chainKey) &&
    value.fundingEnvironment === 'production' && value.custodyClassification === 'owner_controlled' &&
    typeof value.fundingVerifiedAt === 'string';
}

function sessionMatches(
  session: VerifiedOnrampSession,
  transaction: TenantFundingTransaction,
  ownerSubject: string,
  livemode: boolean,
): boolean {
  const chain = CHAINS[transaction.chainKey];
  return session.providerSessionId === transaction.providerSessionId && session.livemode === livemode &&
    session.chainKey === transaction.chainKey &&
    sameChainAddress(chain, session.walletAddress, transaction.walletAddress) &&
    session.destinationCurrency === 'usdc' && session.destinationNetwork === stripeOnrampNetwork(transaction.chainKey) &&
    session.metadata.meowwa_tenant_id === transaction.tenantId &&
    session.metadata.meowwa_funding_id === transaction.fundingId &&
    session.metadata.meowwa_owner_id === ownerSubject &&
    session.metadata.meowwa_pet_id === transaction.petId &&
    session.metadata.meowwa_wallet_id === transaction.walletId;
}

function publicWallet(binding: TenantWalletBinding) {
  // Development creates a control wallet without production funding columns. Never return an
  // undefined chain to the client just because mainnet funding is disabled: the control network
  // is named instead, exactly as its numeric id always was.
  const chainKey = binding.fundingChainKey ?? binding.chainKey;
  return {
    petId: binding.petId,
    walletId: binding.walletId,
    address: binding.smartWalletAddress,
    chainKey,
    chainId: binding.fundingChainId ?? binding.chainId,
    network: CHAINS[chainKey].displayName,
    status: binding.status,
  };
}

function syncProvisionedWallet(store: AppStore, binding: TenantWalletBinding): void {
  const wallet = store.wallets.get(binding.petId);
  const controlChain = CHAINS[binding.chainKey];
  if (!wallet || binding.walletId !== expectedBinding(binding.tenantId, wallet, binding.chainKey).walletId) {
    throw new Error('Provisioned wallet does not match the pet profile');
  }
  if (controlChain.family !== 'evm') {
    // The in-memory pet wallet is the EVM control wallet: its address, chain id, holdings and
    // receive link are what the sandbox spend path reads and what the durable snapshot validator
    // admits, and a base58 address there would make every later save of this tenant refuse the
    // snapshot. A Solana binding is served from its repository row (modules/core.ts projects one
    // funding wallet per rail), so nothing of it is mirrored here.
    return;
  }
  const address = normalizeChainAddress(controlChain, binding.smartWalletAddress);
  if ([...store.wallets.values()].some((candidate) => candidate.petId !== binding.petId && candidate.address.toLowerCase() === address)) {
    throw new Error('Provisioned wallet address is already assigned to another pet');
  }
  if (wallet.address.toLowerCase() !== address) {
    // The reconciled transfers belong to the old address and cannot be carried over, so the credits
    // they made come back out. What must NOT come out is the rest of the accounted balance -- the
    // seeded and granted test funds. That is the only pot the policy engine spends from
    // (modules/workflow.ts walletBalanceMinor), it is not chain-derived, and no route in tenant
    // funding mode ever credits it: zeroing it here left the owner with a real Base wallet, real
    // USDC in the tenant ledger, and every purchase refused INSUFFICIENT_BALANCE for good.
    // Mainnet funding is a separate, withdrawable pot -- it is not spendable by a Base Sepolia
    // payment path, and pretending otherwise would let the same money be spent and withdrawn.
    const creditedAtOldAddress = (wallet.receiveTransfers ?? [])
      .reduce((total, transfer) => transfer.accounting === 'refund' ? total : total + transfer.amountMinor, 0);
    wallet.balanceMinor = Math.max(0, wallet.balanceMinor - creditedAtOldAddress);
    wallet.address = address;
    wallet.receiveTransfers = [];
    wallet.holdings = [];
  }
  wallet.chainId = 84532;
  // Enabling the link is where it is minted, and where a token still holding the old unkeyed
  // sha256(ownerId, petId) is retired.
  retireDerivedReceiveToken(wallet, store.owner.ownerId);
  wallet.receiveToken ??= newReceiveToken();
  wallet.receiveEnabled = true;
  // A verified binding proves that Privy created the wallet and attached the expected restricted
  // signer. Clear only the provisioning sentinel; an explicit owner/closure pause remains in force.
  wallet.signerRevoked = false;
  if (wallet.pauseReason === 'signer_revoked') {
    wallet.paused = false;
    delete wallet.pauseReason;
  }
  // Provisioning stays open for an archived pet -- it is what mints the receive token and keeps the
  // withdrawal binding active, and the archive contract keeps both. What it must not do is hand the
  // agent back: archiving stops spending by suspending the agent and the mandate, and reactivating
  // here undid half of that off-switch on the archived pet's own funding route.
  const agent = store.agents.get(binding.petId);
  const archived = Boolean(store.pets.find((pet) => pet.petId === binding.petId)?.archivedAt);
  if (agent && !wallet.paused && !archived) agent.status = 'ACTIVE';
  syncPocUsdcHolding(wallet);
}

export function registerTenantWalletProvisioningRoute(
  app: FastifyInstance,
  store: AppStore,
  options: TenantWalletProvisioningModuleOptions,
): void {
  app.post('/v1/funding/wallets', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const input = provisionWalletBody.parse(request.body);
    const chainKey = input.chain ?? 'base';
    const pet = store.pets.find((item) => item.petId === input.petId && item.ownerId === context.ownerSubject);
    if (!pet) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    if (!enabledFundingChains(options).includes(chainKey)) return chainNotEnabled(reply, chainKey);
    const freshAccessToken = request.headers['x-privy-access-token'];
    delete request.headers['x-privy-access-token'];
    if (typeof freshAccessToken !== 'string' || freshAccessToken.length < 8 || freshAccessToken.length > 8_192) {
      return reply.code(403).send({ type: 'privy-owner-proof-required', title: 'A fresh Privy owner proof is required', status: 403 });
    }

    let privyUserId: string;
    try {
      ({ privyUserId } = await options.identityVerifier.verify(freshAccessToken));
    } catch {
      return reply.code(403).send({ type: 'privy-owner-proof-required', title: 'A fresh Privy owner proof is required', status: 403 });
    }
    let resolved;
    try {
      resolved = await options.identityResolver.resolve('privy', privyUserId);
    } catch {
      return reply.code(503).send({ type: 'identity-resolution-unavailable', title: 'Owner verification is temporarily unavailable', status: 503 });
    }
    if (!resolved || resolved.memberId !== undefined || resolved.tenantId !== context.tenantId || resolved.ownerSubject !== context.ownerSubject) {
      return reply.code(403).send({ type: 'privy-owner-mismatch', title: 'Privy owner proof does not match this account', status: 403 });
    }

    const controlChainKey = controlChainFor(chainKey);
    const expected = expectedBinding(context.tenantId, pet, controlChainKey);
    const provisioned = await options.provisioner.provision({
      tenantId: context.tenantId,
      ownerSubject: context.ownerSubject,
      privyUserId,
      petId: pet.petId,
      walletId: pet.walletId,
      chain: controlChainKey,
    });
    if ('status' in provisioned && provisioned.status === 'owner-authorization-required') {
      process.stderr.write(`${JSON.stringify({ level: 'info', event: 'tenant-wallet-provisioning.prepared', chain: controlChainKey })}\n`);
      return reply.code(202).send(provisioned);
    }
    const persisted = await options.repository.getActiveWalletBinding(context.tenantId, pet.petId, controlChainKey);
    if (!persisted || !walletControlBindingMatches(provisioned, expected) || !walletControlBindingMatches(persisted, expected) ||
      provisioned.privyEmbeddedWalletId !== persisted.privyEmbeddedWalletId ||
      !sameChainAddress(CHAINS[controlChainKey], provisioned.smartWalletAddress, persisted.smartWalletAddress)) {
      throw new Error('Wallet provisioner did not persist one exact verified pet wallet binding');
    }
    syncProvisionedWallet(store, persisted);
    process.stderr.write(`${JSON.stringify({ level: 'info', event: 'tenant-wallet-provisioning.completed', chain: controlChainKey })}\n`);
    return { wallet: publicWallet(persisted) };
  });

  app.post('/v1/funding/wallets/complete', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const input = completeProvisionWalletBody.parse(request.body);
    const chainKey = input.chain ?? 'base';
    const pet = store.pets.find((item) => item.petId === input.petId && item.ownerId === context.ownerSubject);
    if (!pet) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    if (!enabledFundingChains(options).includes(chainKey)) return chainNotEnabled(reply, chainKey);
    const freshAccessToken = request.headers['x-privy-access-token'];
    delete request.headers['x-privy-access-token'];
    if (typeof freshAccessToken !== 'string' || freshAccessToken.length < 8 || freshAccessToken.length > 8_192) {
      return reply.code(403).send({ type: 'privy-owner-proof-required', title: 'A fresh Privy owner proof is required', status: 403 });
    }

    let privyUserId: string;
    try {
      ({ privyUserId } = await options.identityVerifier.verify(freshAccessToken));
    } catch {
      return reply.code(403).send({ type: 'privy-owner-proof-required', title: 'A fresh Privy owner proof is required', status: 403 });
    }
    let resolved;
    try {
      resolved = await options.identityResolver.resolve('privy', privyUserId);
    } catch {
      return reply.code(503).send({ type: 'identity-resolution-unavailable', title: 'Owner verification is temporarily unavailable', status: 503 });
    }
    if (!resolved || resolved.memberId !== undefined || resolved.tenantId !== context.tenantId || resolved.ownerSubject !== context.ownerSubject) {
      return reply.code(403).send({ type: 'privy-owner-mismatch', title: 'Privy owner proof does not match this account', status: 403 });
    }

    const controlChainKey = controlChainFor(chainKey);
    const expected = expectedBinding(context.tenantId, pet, controlChainKey);
    const completed = await options.provisioner.complete({
      tenantId: context.tenantId,
      ownerSubject: context.ownerSubject,
      privyUserId,
      petId: pet.petId,
      walletId: pet.walletId,
      chain: controlChainKey,
      agentPolicyId: input.agentPolicyId,
      expectedPolicyDigest: input.expectedPolicyDigest,
      policyValidUntil: input.policyValidUntil,
    });
    const persisted = await options.repository.getActiveWalletBinding(context.tenantId, pet.petId, controlChainKey);
    if (!persisted || !walletControlBindingMatches(completed, expected) || !walletControlBindingMatches(persisted, expected) ||
      completed.privyEmbeddedWalletId !== persisted.privyEmbeddedWalletId ||
      !sameChainAddress(CHAINS[controlChainKey], completed.smartWalletAddress, persisted.smartWalletAddress)) {
      throw new Error('Wallet provisioner did not persist one exact verified pet wallet binding');
    }
    syncProvisionedWallet(store, persisted);
    process.stderr.write(`${JSON.stringify({ level: 'info', event: 'tenant-wallet-provisioning.owner-completed', chain: controlChainKey })}\n`);
    return { wallet: publicWallet(persisted) };
  });

  if (options.closeResourcesOnClose) app.addHook('onClose', async () => {
    await options.provisioner.close?.();
    await options.repository.close?.();
  });
}

export function registerTenantFundingRoutes(app: FastifyInstance, store: AppStore, options: TenantFundingModuleOptions): void {
  const fundingChains = options.fundingChains;
  // Fail closed and loud: no rail means no route can name a chain the indexer watches, which is
  // the condition this option exists to rule out.
  if (fundingChains.length === 0) throw new Error('Tenant funding requires at least one funding chain');
  registerTenantWalletProvisioningRoute(app, store, { ...options, closeResourcesOnClose: false });

  /** Every active binding the pet holds, one per rail, for the paths that act on all of them. */
  async function activeBindings(tenantId: string, petId: string): Promise<TenantWalletBinding[]> {
    if (options.repository.listActiveWalletBindings) return options.repository.listActiveWalletBindings(tenantId, petId);
    const base = await options.repository.getActiveWalletBinding(tenantId, petId, 'base_sepolia');
    return base ? [base] : [];
  }

  /**
   * The addresses a pet wallet holds on one rail. The in-memory wallets are the EVM control
   * wallets, so Base reads them; a Solana pet wallet exists only as its repository binding.
   */
  async function petWalletAddresses(tenantId: string, chainKey: FundingChainKey): Promise<string[]> {
    if (chainKey === 'base') return [...store.wallets.values()].map((wallet) => wallet.address);
    const controlChainKey = controlChainFor(chainKey);
    const bindings = await Promise.all(store.pets.map((pet) =>
      options.repository.getActiveWalletBinding(tenantId, pet.petId, controlChainKey)));
    return bindings.flatMap((binding) => binding ? [binding.smartWalletAddress] : []);
  }

  /** The network a withdrawal settles on, for a refusal raised before the row itself was read. */
  async function withdrawalNetworkName(tenantId: string, withdrawalId: string): Promise<string> {
    const withdrawal = (await options.repository.listWithdrawals(tenantId)).find((item) => item.withdrawalId === withdrawalId);
    const chainKey = withdrawal?.chainKey ?? (fundingChains.length === 1 ? fundingChains[0] : undefined);
    return chainKey ? CHAINS[chainKey].displayName : 'The chain';
  }

  app.post('/v1/funding/sessions', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const input = createSessionBody.parse(request.body);
    const chainKey = input.chain ?? 'base';
    const rawIdempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!rawIdempotencyKey) {
      return reply.code(400).send({ type: 'validation', title: 'A valid idempotency key is required', status: 400 });
    }
    const pet = store.pets.find((item) => item.petId === input.petId && item.ownerId === context.ownerSubject);
    if (!pet) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    // Ahead of the pending-funding row and the provider call, so an archived pet leaves no
    // half-started onramp for the owner to resume and no Stripe session to reconcile.
    const archived = archivedPetFundingRefusal(store, pet.petId);
    if (archived) return reply.code(archived.status).send(archived);
    if (!fundingChains.includes(chainKey)) return chainNotEnabled(reply, chainKey);
    const controlChainKey = controlChainFor(chainKey);
    const wallet = await options.repository.getActiveWalletBinding(context.tenantId, pet.petId, controlChainKey);
    if (!wallet || !productionFundingBindingMatches(wallet, expectedBinding(context.tenantId, pet, controlChainKey))) {
      return reply.code(409).send({
        type: 'wallet-not-provisioned', title: 'Create and verify this pet wallet before funding it', status: 409,
      });
    }

    const providerIdempotencyKey = stripeIdempotencyKey(context.tenantId, context.ownerSubject, rawIdempotencyKey);
    try {
      const created = await options.repository.createPendingFunding({
        tenantId: context.tenantId,
        operation: 'create_onramp',
        idempotencyKey: rawIdempotencyKey,
        requestFingerprint: requestFingerprint({
          ...context,
          petId: pet.petId,
          chainKey,
          ...(input.sourceAmountMinor === undefined ? {} : { sourceAmountMinor: input.sourceAmountMinor }),
        }),
        fundingId: deterministicFundingId(context.tenantId, context.ownerSubject, rawIdempotencyKey),
        petId: pet.petId,
        walletId: wallet.walletId,
        chainKey,
        walletAddress: wallet.smartWalletAddress,
        rail: 'stripe_onramp',
        sourceAmountMinor: input.sourceAmountMinor ?? null,
      });
      const transaction = created.transaction;
      if (transaction.status === 'failed' || transaction.status === 'refunded') {
        return reply.code(409).send({ type: 'funding-not-resumable', title: 'Start a new funding attempt', status: 409 });
      }
      if (transaction.providerSessionId) {
        const session = await options.provider.retrieveSession(transaction.providerSessionId);
        if (!sessionMatches(session, transaction, context.ownerSubject, options.stripeLivemode)) {
          throw new Error('Stripe Onramp session does not match the stored tenant funding destination');
        }
        if (!session.redirectUrl) {
          return reply.code(409).send({
            type: 'funding-session-progressed',
            title: 'This funding session has progressed; refresh activity for its verified status',
            status: 409,
          });
        }
        return reply.send({ funding: transaction, redirectUrl: session.redirectUrl });
      }
      if (transaction.status !== 'pending' || transaction.reconciliationStatus !== 'awaiting_provider') {
        throw new Error('Tenant funding cannot create a provider session from its current state');
      }
      const session = await options.provider.createSession({
        tenantId: context.tenantId,
        fundingId: transaction.fundingId,
        ownerId: context.ownerSubject,
        petId: transaction.petId,
        walletId: transaction.walletId,
        chainKey: transaction.chainKey,
        walletAddress: transaction.walletAddress,
        ...(transaction.sourceAmountMinor === null ? {} : { sourceAmountMinor: transaction.sourceAmountMinor }),
        customerIpAddress: request.ip,
        idempotencyKey: providerIdempotencyKey,
      });
      const attached = await options.repository.attachProviderSession(context.tenantId, transaction.fundingId, session.providerSessionId);
      return reply.code(created.reused ? 200 : 201).send({ funding: attached, redirectUrl: session.redirectUrl });
    } catch (error) {
      if (error instanceof TenantFundingIdempotencyConflictError) {
        return reply.code(409).send({ type: 'idempotency-conflict', title: error.message, status: 409 });
      }
      if (error instanceof StripeOnrampError) {
        // Stripe's own message and code name the key mode and Stripe-side identifiers ("No such
        // crypto_onramp_session: cos_live_...", "test mode key"). The owner gets the status they
        // can act on; the provider's text stays server-side.
        const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 502;
        return reply.code(status).send({
          type: 'funding-provider-rejected', title: 'The funding provider could not start this session', status,
          // The one question this screen raises. This route only mints the hosted session; the card
          // is entered and charged afterwards on the provider's own page, so a failure here is
          // provably before any money moves, and the same idempotency key resumes the same attempt.
          detail: 'Your card was not charged — payment happens on the funding provider\'s page, after this step. Try again with the same amount; retrying is safe.',
        });
      }
      throw error;
    }
  });

  // Revoking the agent signer is a two-step flow because Privy requires the owner's own credential
  // to detach it: MeowWa cannot do it server-side. Step one tells the client what to detach, the
  // owner detaches it with their own Privy session, step two verifies the result and records it.
  app.post('/v1/wallet-controls/:petId/prepare-revocation', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { petId } = z.object({ petId: z.string().min(1).max(255) }).parse(request.params);
    const pet = store.pets.find((item) => item.petId === petId && item.ownerId === context.ownerSubject);
    if (!pet) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    const binding = await options.repository.getActiveWalletBinding(context.tenantId, petId);
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet binding not found', status: 404 });
    return {
      status: 'owner-authorization-required',
      attachment: {
        walletAddress: binding.smartWalletAddress,
        agentSignerId: binding.agentSignerId,
      },
    };
  });

  app.post('/v1/wallet-controls/:petId/complete-revocation', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { petId } = z.object({ petId: z.string().min(1).max(255) }).parse(request.params);
    const pet = store.pets.find((item) => item.petId === petId && item.ownerId === context.ownerSubject);
    if (!pet) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    if (!options.provisioner.verifyRevocation) {
      return reply.code(503).send({
        type: 'revocation-verification-unavailable',
        title: 'Signer revocation cannot be verified right now', status: 503,
      });
    }
    let outcome: { status: 'revoked' | 'drifted'; reason: string };
    try {
      outcome = await options.provisioner.verifyRevocation({ tenantId: context.tenantId, petId });
    } catch {
      // Never record a revocation the provider did not confirm.
      return reply.code(503).send({
        type: 'revocation-verification-unavailable',
        title: 'Signer revocation could not be verified', status: 503,
      });
    }
    // Both outcomes stop MeowWa spending: 'drifted' means something is still attached, which is a
    // worse state than a clean revocation, not a safer one.
    const wallet = walletForPet(store, petId);
    if (wallet) {
      wallet.signerRevoked = true;
      if (!wallet.paused) wallet.pauseReason = 'signer_revoked';
      wallet.paused = true;
    }
    appendAudit(store, {
      eventType: 'SIGNER_REVOKED', aggregateId: wallet?.walletId ?? petId, actorType: 'owner', actorId: context.ownerSubject,
      summary: outcome.status === 'revoked'
        ? 'Owner detachment verified with the wallet provider and the agent signer is gone'
        : 'Owner detachment could not be confirmed and the binding is marked drifted',
      metadata: { petId, providerSignerDetached: outcome.status === 'revoked', reason: outcome.reason },
    });
    return outcome;
  });

  app.get('/v1/funding', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    return { funding: await options.repository.listFunding(context.tenantId) };
  });

  app.get('/v1/funding/:fundingId', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { fundingId } = fundingParams.parse(request.params);
    const transaction = await options.repository.getFunding(context.tenantId, fundingId);
    if (!transaction) return reply.code(404).send({ type: 'not-found', title: 'Funding transaction not found', status: 404 });
    return { funding: transaction };
  });

  // Registering a withdrawal destination is deliberately separate from withdrawing to one. It gets
  // its own audit event and notification, so swapping the address an owner can withdraw to is a
  // visible act rather than a field on a request that looks like every other request.
  app.post('/v1/withdrawal-destinations', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const body = z.object({
      address: z.string(),
      // The label is signed verbatim and quoted back in every later withdrawal notification, so it
      // accepts exactly what a confirmation can state -- no more, so it can always be signed, and
      // no less, so the signed bytes and the stored bytes are the same bytes.
      label: z.string().min(1).max(120).refine(isDisclosableText, DISCLOSABLE_TEXT_REQUIREMENT),
      chain: fundingChainBody.optional(),
      stepUpVerified: z.boolean().optional(),
    }).parse(request.body);
    const chainKey = body.chain ?? 'base';
    if (!fundingChains.includes(chainKey)) return chainNotEnabled(reply, chainKey);
    const chain = CHAINS[chainKey];
    if (!isChainAddress(chain, body.address)) {
      return reply.code(400).send({
        type: 'invalid-address',
        title: `Withdrawal address is not a valid ${chain.family === 'evm' ? 'EVM' : chain.displayName} address`,
        status: 400,
      });
    }
    // The stored form: lowercase hex on Base, so the owner cannot be shown one casing and charged
    // another; the base58 value untouched on Solana, where case is part of the address.
    const address = normalizeChainAddress(chain, body.address);
    // A pet wallet is not a withdrawal destination: sending there moves nothing out and would let a
    // caller register an address that reads as owner-controlled in the audit trail.
    if ((await petWalletAddresses(context.tenantId, chainKey)).some((candidate) => sameChainAddress(chain, candidate, address))) {
      return reply.code(409).send({ type: 'destination-is-pet-wallet', title: 'A pet wallet cannot be a withdrawal destination', status: 409 });
    }
    // Visibility was the only control here, and an audit row plus an in-app notification are both
    // things a compromised client can keep out of the owner's view. A registration is permanent and
    // reusable -- `createPreparedWithdrawal` only re-checks that the row is still active -- so it
    // costs the owner's key, bound to the address being installed exactly as the withdrawal itself
    // is bound to the address it pays out to. The rail is in the hash off Base: the same base58
    // string is not the same destination on another network.
    const registered = await consumeVerifiedStepUp(
      request.headers, body.stepUpVerified, 'withdrawal-destination-register',
      options.stepUpReplay ?? new Set<string>(),
      {
        resourceId: context.ownerSubject,
        intentHash: stepUpIntentHash({
          operation: 'withdrawal-destination-register', address, label: body.label, ...railIntentField(chainKey),
        }),
      },
    );
    if (!registered) {
      return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    }
    let destination: TenantWithdrawalDestination;
    try {
      destination = await options.repository.registerWithdrawalDestination({
        tenantId: context.tenantId, destinationId: nextId(store, 'destination'),
        chainKey, address, label: body.label, registeredBy: context.ownerSubject,
      });
    } catch (error) {
      if (error instanceof Error && /duplicate key/i.test(error.message)) {
        return reply.code(409).send({ type: 'destination-already-registered', title: 'That address is already registered', status: 409 });
      }
      throw error;
    }
    appendAudit(store, {
      eventType: 'WITHDRAWAL_DESTINATION_REGISTERED', aggregateId: destination.destinationId,
      actorType: 'owner', actorId: context.ownerSubject,
      summary: 'Owner registered an address that pet wallets may withdraw to',
      metadata: {
        address: destination.address, label: destination.label,
        chainKey: destination.chainKey, chainId: destination.chainId,
      },
    });
    appendNotification(store, {
      type: 'WITHDRAWAL_DESTINATION_REGISTERED',
      message: `${destination.address}, saved as ${destination.label}, was registered as a withdrawal address for your pet wallets.`,
      dedupeKey: `withdrawal-destination:${destination.destinationId}`,
    });
    return reply.code(201).send({ destination });
  });

  app.get('/v1/withdrawal-destinations', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    return { destinations: await options.repository.listWithdrawalDestinations(context.tenantId) };
  });

  app.post('/v1/withdrawal-destinations/:destinationId/retire', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { destinationId } = z.object({ destinationId: z.string().min(1).max(255) }).parse(request.params);
    const destination = await options.repository.retireWithdrawalDestination(context.tenantId, destinationId);
    if (!destination) return reply.code(404).send({ type: 'not-found', title: 'Active withdrawal destination not found', status: 404 });
    appendAudit(store, {
      eventType: 'WITHDRAWAL_DESTINATION_RETIRED', aggregateId: destination.destinationId,
      actorType: 'owner', actorId: context.ownerSubject,
      summary: 'Owner retired a withdrawal address',
      metadata: { address: destination.address, label: destination.label },
    });
    appendNotification(store, {
      type: 'WITHDRAWAL_DESTINATION_RETIRED',
      message: `${destination.label} can no longer receive withdrawals from your pet wallets.`,
      dedupeKey: `withdrawal-destination-retired:${destination.destinationId}`,
    });
    return { destination };
  });

  // Settles, closes or flags intents that have reserved funds with no broadcast, so an interrupted
  // withdrawal can never lock a wallet's balance forever. Deliberately step-up-free: it moves no
  // money and only ever narrows what a stale intent can still do. An intent whose transfer the
  // chain already shows is attributed that debit and reads confirmed. Only a never-dispatched
  // intent expires — expiry releases the reservation, and only that case may claim nothing was
  // sent. A dispatched intent with no observed outcome is flagged for review instead and its
  // reservation stays held until a late broadcast acknowledgement or the owner cancelling it
  // resolves it — unless a debit matches it and a rival intent alike, in which case it never held
  // one, and the notice below has to say so rather than repeat a sentence about money that is not
  // held.
  async function sweepStaleWithdrawals(tenantId: string, walletId: string): Promise<TenantWithdrawal[]> {
    const touched = await options.repository.expireStaleWithdrawals(tenantId, walletId);
    for (const withdrawal of touched) {
      // Every sentence names the rail the intent was prepared on, not a fixed network.
      const network = CHAINS[withdrawal.chainKey].displayName;
      const explorer = EXPLORER_NAMES[withdrawal.chainKey];
      // Three outcomes, and the notice has to name the right one. `confirmed` here means the sweep
      // attributed a debit the chain already shows to an intent whose acknowledgement never
      // arrived -- the amount is spent, not reserved, and the earlier "cancel it to release the
      // amount" notice is answered rather than left standing.
      const outcome = withdrawal.status === 'confirmed'
        ? 'CONFIRMED' : withdrawal.status === 'dispatch_review' ? 'REVIEW' : 'EXPIRED';
      // A flagged intent does not always reserve anything. Two identical dispatched withdrawals and
      // one chain debit read that debit as theirs alike, so both release and neither can be
      // attributed — and the review notice still told the owner their money was held and named a
      // cancellation the server then refused every time. `holdsReservation` is the server's own
      // predicate, the same one the balance is netted with, so it is the only honest source for
      // which half of that sentence applies.
      const reserved = withdrawal.holdsReservation;
      appendAudit(store, {
        eventType: `WITHDRAWAL_${outcome === 'CONFIRMED' ? 'CONFIRMED' : outcome === 'REVIEW' ? 'REVIEW_REQUIRED' : 'EXPIRED'}`,
        aggregateId: withdrawal.withdrawalId,
        actorType: 'system', actorId: 'withdrawal-reaper',
        summary: outcome === 'CONFIRMED'
          ? `${network} shows this withdrawal settled; the transfer was attributed to the intent and its reservation released`
          : outcome === 'REVIEW'
            ? reserved
              ? 'Withdrawal was handed to the wallet provider and no outcome was ever observed; the amount stays reserved until a late broadcast or the owner cancelling it resolves the review'
              : `Withdrawal was handed to the wallet provider and no outcome was ever observed; a ${network} debit matches it but also matches another open withdrawal, so nothing is reserved for it and cancelling one of them is what attributes the transfer to the other`
            : 'Withdrawal intent expired before it was handed to the wallet provider; nothing was sent',
        metadata: {
          petId: withdrawal.petId,
          destinationId: withdrawal.destinationId,
          amountAtomic: withdrawal.amountAtomic,
          dispatchedAt: withdrawal.dispatchedAt,
          ...(outcome === 'CONFIRMED' ? { transactionHash: withdrawal.transactionHash } : {}),
        },
      });
      appendNotification(store, {
        type: outcome === 'CONFIRMED'
          ? 'WITHDRAWAL_CONFIRMED' : outcome === 'REVIEW' ? 'WITHDRAWAL_REVIEW_REQUIRED' : 'WITHDRAWAL_EXPIRED',
        message: outcome === 'CONFIRMED'
          ? `${network} confirmed a withdrawal whose result never reached MeowWa. Nothing is reserved for it any more, and Activity shows the transaction.`
          : outcome === 'REVIEW'
            ? reserved
              ? `An interrupted withdrawal has an unknown outcome. The amount stays reserved until you resolve it. Check Activity and ${explorer}; if the transfer never happened, cancel the withdrawal to release the amount.`
              : `An interrupted withdrawal has an unknown outcome, but a ${network} transfer matches it and another withdrawal alike, so nothing is reserved for it. Cancel the one you did not make and the transfer is attributed to the other.`
            : 'A withdrawal that was never handed to Privy expired. Nothing was sent, and the amount is available again.',
        dedupeKey: outcome === 'CONFIRMED'
          ? `withdrawal-confirmed:${withdrawal.withdrawalId}`
          : outcome === 'REVIEW'
            ? `withdrawal-review:${withdrawal.withdrawalId}`
            : `withdrawal-expired:${withdrawal.withdrawalId}`,
      });
    }
    return touched;
  }

  // MeowWa cannot sign this. The agent signer's policy allowlists merchant recipients, so it has no
  // authority to send anywhere else, and that restriction is the point of the policy rather than a
  // gap to route around. What this does is gate the withdrawal on a fresh step-up, check the
  // destination against the registered list, record the intent, and hand back the exact transfer
  // for the owner's own key to sign. The chain indexer records the resulting outflow as a debit.
  app.post('/v1/pets/:petId/withdrawals', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { petId } = z.object({ petId: z.string().min(1).max(255) }).parse(request.params);
    const body = z.object({
      destinationId: z.string().min(1).max(255),
      amountAtomic: z.string().regex(/^[1-9][0-9]{0,29}$/),
      bindingFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      stepUpVerified: z.boolean().optional(),
    }).parse(request.body);
    const rawIdempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!rawIdempotencyKey) {
      return reply.code(400).send({ type: 'validation', title: 'A valid idempotency key is required', status: 400 });
    }

    // The destination names the rail, and the rail names which of the pet's bindings pays: a
    // Solana address is paid from the pet's Solana wallet and never from its Base one. With no
    // active destination the Base binding stands in, so a pet with no wallet is answered exactly
    // as it always was, ahead of the destination refusal below.
    const destinations = await options.repository.listWithdrawalDestinations(context.tenantId);
    const destination = destinations.find((item) => item.destinationId === body.destinationId && item.status === 'active');
    const chainKey: FundingChainKey = destination?.chainKey ?? 'base';
    const chain = CHAINS[chainKey];
    const binding = await options.repository.getActiveWalletBinding(context.tenantId, petId, controlChainFor(chainKey));
    if (!binding) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet binding not found', status: 404 });
    // `createPreparedWithdrawal` is the only reader of the in-flight reservation, so this is the
    // one place a stale one can actually cost the owner anything: it is measured against their
    // balance a few lines below. Sweep first and an interrupted withdrawal either releases its
    // reservation or is flagged, audited and notified here — rather than sitting unreported until
    // someone happens to open the management panel, which was the only other caller. Ahead of the
    // step-up so a failing sweep never burns the owner's single-use credential.
    await sweepStaleWithdrawals(context.tenantId, binding.walletId);
    const bindingFingerprint = tenantWalletBindingFingerprint(binding);
    if (body.bindingFingerprint !== bindingFingerprint) {
      return reply.code(409).send({
        type: 'wallet-binding-changed',
        title: 'Wallet controls changed; review the withdrawal again',
        status: 409,
      });
    }

    // Spendable only on a rail this deployment settles, and only when the row's numeric id agrees
    // with its rail: a destination the indexer does not watch is how that defect produced an outflow the
    // ledger never recorded.
    if (!destination || !fundingChains.includes(destination.chainKey) ||
      destination.chainId !== evmChainIdOf(CHAINS[destination.chainKey])) {
      return reply.code(409).send({
        type: 'destination-not-registered',
        title: 'Withdrawals can only go to an address you registered beforehand', status: 409,
      });
    }

    // Binding the step-up to the amount and destination is what stops a captured credential from
    // being replayed against a different withdrawal than the one the owner approved. The address is
    // in the hash as well as the id: the id is an ordinal that discloses nothing, so the owner's
    // confirmation states the address instead (modules/sandbox-auth.ts), and this is the check that
    // makes the stated address binding — a client that shows one address and withdraws to another
    // resolves a different `destination.address` here and the credential no longer verifies.
    const replay = options.stepUpReplay ?? new Set<string>();
    const preImage = {
      destinationId: destination.destinationId,
      amountAtomic: body.amountAtomic,
      bindingFingerprint,
    };
    const spend = (intent: Record<string, unknown>) => consumeVerifiedStepUp(
      request.headers, body.stepUpVerified, 'wallet-withdrawal', replay,
      { resourceId: binding.walletId, intentHash: stepUpIntentHash(intent) },
    );
    // No compatibility branch for the address-less pre-image the previous build minted. During a
    // roll a challenge from an old replica is refused here, so withdrawals 403 for the length of
    // the deploy and the owner retries once it finishes: nothing is at risk and no money moves.
    // Accepting it instead would reopen address substitution for that window, because an attacker
    // picks the replica -- mint the address-less form on an old pod, spend it on a new one -- which
    // is exactly the binding this route exists to enforce. Fail closed on the only real-money outflow.
    const verified = await spend({
      ...preImage,
      destinationAddress: normalizeChainAddress(chain, destination.address),
      ...railIntentField(chainKey),
    });
    if (!verified) {
      return reply.code(403).send({ type: 'step-up-required', title: 'Strong authentication required', status: 403 });
    }

    const wallet = walletForPet(store, petId);
    if (wallet?.paused || wallet?.signerRevoked) {
      return reply.code(409).send({ type: 'wallet-paused', title: 'Wallet spending is paused', status: 409 });
    }

    // Canonical USDC on the rail from the registry: the ERC-20 contract on Base, the SPL mint on
    // Solana. Runtime configuration verifies the same registry entry the indexer watches.
    const tokenAddress = chain.usdc.asset;
    let prepared: { withdrawal: TenantWithdrawal; reused: boolean };
    try {
      prepared = await options.repository.createPreparedWithdrawal({
        tenantId: context.tenantId,
        idempotencyKey: rawIdempotencyKey,
        requestFingerprint: withdrawalRequestFingerprint({
          ...context,
          petId,
          walletId: binding.walletId,
          bindingFingerprint,
          destinationId: destination.destinationId,
          destinationAddress: destination.address,
          amountAtomic: body.amountAtomic,
          tokenAddress,
          chainKey,
        }),
        withdrawalId: deterministicWithdrawalId(context.tenantId, context.ownerSubject, rawIdempotencyKey),
        ownerSubject: context.ownerSubject,
        petId,
        walletId: binding.walletId,
        chainKey,
        walletAddress: binding.smartWalletAddress,
        bindingFingerprint,
        destinationId: destination.destinationId,
        destinationAddress: destination.address,
        amountAtomic: body.amountAtomic,
        tokenAddress,
      });
    } catch (error) {
      if (error instanceof TenantWithdrawalIdempotencyConflictError) {
        return reply.code(409).send({ type: 'idempotency-conflict', title: error.message, status: 409 });
      }
      if (error instanceof TenantWithdrawalInsufficientFundsError) {
        return reply.code(409).send({
          type: 'withdrawal-insufficient-funds',
          title: 'This amount exceeds the reconciled balance not already committed to another withdrawal',
          status: 409,
          availableAtomic: error.availableAtomic,
        });
      }
      throw error;
    }

    if (!prepared.reused) appendAudit(store, {
      eventType: 'WITHDRAWAL_AUTHORIZED', aggregateId: binding.walletId, actorType: 'owner', actorId: context.ownerSubject,
      summary: 'Owner authorized a withdrawal to a registered address',
      metadata: {
        petId, destinationId: destination.destinationId, destinationAddress: destination.address,
        amountAtomic: body.amountAtomic, chainKey: destination.chainKey, chainId: destination.chainId,
      },
    });
    if (!prepared.reused) appendNotification(store, {
      type: 'WITHDRAWAL_AUTHORIZED',
      // The address leads, because the address is where the money went. A label is owner-authored
      // free text and may perfectly legally contain a second, unrelated address ("cold storage
      // 0xdead...beef"), so a notification naming only the label read as if the funds had gone
      // somewhere they had not -- the same wording the signed confirmation uses.
      message: `A withdrawal to ${destination.address}, saved as ${destination.label}, was authorized from your pet wallet.`,
      // Keyed on the durable withdrawal, not on wallet+destination+amount: cancelling and retrying
      // the same transfer is a routine path now, and a value-shaped key silently swallowed the
      // notification for every attempt after the first.
      dedupeKey: `withdrawal:${prepared.withdrawal.withdrawalId}`,
    });

    return reply.code(202).send({
      status: 'owner-signature-required',
      withdrawal: prepared.withdrawal,
      // The exact transfer for the owner's own key: an ERC-20 transfer on Base, an SPL transfer
      // of the mint on Solana. The client builds it from the rail, not from a numeric id.
      transfer: {
        chainKey,
        chainId: evmChainIdOf(chain),
        from: binding.smartWalletAddress,
        to: destination.address,
        token: tokenAddress,
        amountAtomic: body.amountAtomic,
      },
    });
  });

  app.get('/v1/withdrawals', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    return { withdrawals: await options.repository.listWithdrawals(context.tenantId) };
  });

  app.post('/v1/pets/:petId/withdrawals/expire-stale', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { petId } = z.object({ petId: z.string().min(1).max(255) }).parse(request.params);
    // Every rail the pet holds a wallet on: a stale Solana intent reserves that wallet's balance
    // exactly as a Base one does, and the sweep only ever narrows what an intent can still do.
    const bindings = await activeBindings(context.tenantId, petId);
    if (bindings.length === 0) return reply.code(404).send({ type: 'not-found', title: 'Pet wallet not found', status: 404 });
    const withdrawals: TenantWithdrawal[] = [];
    for (const binding of bindings) withdrawals.push(...await sweepStaleWithdrawals(context.tenantId, binding.walletId));
    return { withdrawals };
  });

  // Recorded before the owner's wallet provider is invoked, so that everything after it is treated
  // as possibly-sent. Without this marker the cancel path cannot tell an owner who declined in
  // Privy apart from an owner whose transfer is already on the chain.
  app.post('/v1/withdrawals/:withdrawalId/dispatch', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { withdrawalId } = z.object({ withdrawalId: z.string().min(1).max(255) }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    let result: { withdrawal: TenantWithdrawal; applied: boolean } | undefined;
    try {
      result = await options.repository.markWithdrawalDispatched(context.tenantId, withdrawalId);
    } catch (error) {
      if (error instanceof TenantWithdrawalDispatchConflictError) {
        return reply.code(409).send({
          type: 'withdrawal-dispatch-conflict', title: 'This withdrawal can no longer be handed to your wallet', status: 409,
        });
      }
      throw error;
    }
    if (!result) return reply.code(404).send({ type: 'not-found', title: 'Withdrawal not found', status: 404 });
    if (result.applied) appendAudit(store, {
      eventType: 'WITHDRAWAL_DISPATCHED', aggregateId: result.withdrawal.withdrawalId,
      actorType: 'owner', actorId: context.ownerSubject,
      summary: 'Withdrawal was handed to the owner wallet provider for signature',
      metadata: {
        petId: result.withdrawal.petId,
        destinationId: result.withdrawal.destinationId,
        amountAtomic: result.withdrawal.amountAtomic,
      },
    });
    return { withdrawal: result.withdrawal };
  });

  app.post('/v1/withdrawals/:withdrawalId/cancel', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { withdrawalId } = z.object({ withdrawalId: z.string().min(1).max(255) }).parse(request.params);
    // The reason is recorded, not required. It used to be the only key that opened this door for a
    // dispatched intent, and the sole caller that sent it was the web client's inline decline
    // handler -- so an owner whose decline never reached the server (tab closed, laptop asleep) had
    // no reachable way to release their own reservation, and 60 minutes later it became a
    // dispatch_review nothing else clears. What the transition may CLAIM still comes from
    // `dispatchedAt`, which the caller cannot forge.
    const body = z.object({ reason: z.literal('provider_user_rejected').optional() }).strict().parse(request.body ?? {});
    let result: { withdrawal: TenantWithdrawal; applied: boolean } | undefined;
    try {
      result = await options.repository.cancelPreparedWithdrawal(context.tenantId, withdrawalId);
    } catch (error) {
      if (error instanceof TenantWithdrawalSettledError) {
        return reply.code(409).send({
          type: 'withdrawal-already-settled',
          title: `${await withdrawalNetworkName(context.tenantId, withdrawalId)} already shows this transfer; it cannot be cancelled`,
          status: 409,
        });
      }
      throw error;
    }
    if (!result) return reply.code(404).send({ type: 'not-found', title: 'Withdrawal not found', status: 404 });
    if (!result.applied && result.withdrawal.status !== 'cancelled' && result.withdrawal.status !== 'provider_rejected') {
      return reply.code(409).send({
        type: 'withdrawal-cancellation-conflict',
        title: 'Withdrawal can no longer be cancelled',
        status: 409,
      });
    }
    const withdrawal = result.withdrawal;
    if (result.applied) appendAudit(store, {
      eventType: 'WITHDRAWAL_CANCELLED', aggregateId: withdrawal.withdrawalId,
      actorType: 'owner', actorId: context.ownerSubject,
      // Only an undispatched intent may claim nothing was sent. Once the transfer was handed to the
      // provider, all this server can state is that the owner closed it and no broadcast was
      // observed; whether they declined in Privy is their report, so it is metadata, not the claim.
      summary: withdrawal.status === 'cancelled'
        ? 'Owner cancelled the withdrawal before it was handed to the wallet provider'
        : `Owner cancelled a withdrawal already handed to the wallet provider; no broadcast was observed on ${CHAINS[withdrawal.chainKey].displayName}`,
      metadata: {
        petId: withdrawal.petId,
        destinationId: withdrawal.destinationId,
        destinationAddress: withdrawal.destinationAddress,
        amountAtomic: withdrawal.amountAtomic,
        dispatchedAt: withdrawal.dispatchedAt,
        ownerReportedProviderDecline: body.reason === 'provider_user_rejected',
      },
    });
    return { withdrawal };
  });

  app.post('/v1/withdrawals/:withdrawalId/broadcast', async (request, reply) => {
    const context = ownerContext(store, request.headers);
    if (!context) return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const { withdrawalId } = z.object({ withdrawalId: z.string().min(1).max(255) }).parse(request.params);
    const { transactionHash } = z.object({ transactionHash: z.string() }).strict().parse(request.body);
    // The hash's shape names its family -- hex can never be base58 and base58 has no `0x` -- so
    // the rail is read off the value among those this deployment settles on, and the repository
    // then holds it to the rail the intent was actually prepared on.
    const chain = fundingChains.map((chainKey) => CHAINS[chainKey]).find((candidate) => isChainTransactionId(candidate, transactionHash));
    if (!chain) {
      return reply.code(400).send({
        type: 'validation', title: `A valid ${networkNames(fundingChains)} transaction hash is required`, status: 400,
      });
    }
    let result: { withdrawal: TenantWithdrawal; applied: boolean } | undefined;
    try {
      result = await options.repository.acknowledgeWithdrawalBroadcast(
        context.tenantId, withdrawalId, canonicalChainTransactionId(chain.key, transactionHash),
      );
    } catch (error) {
      if (error instanceof Error && /cancelled before broadcast/i.test(error.message)) {
        return reply.code(409).send({
          type: 'withdrawal-cancelled', title: 'Cancelled withdrawal cannot be broadcast', status: 409,
        });
      }
      if (error instanceof Error && /different transaction|duplicate key/i.test(error.message)) {
        return reply.code(409).send({
          type: 'withdrawal-transaction-conflict', title: 'Withdrawal already references another transaction', status: 409,
        });
      }
      // A hash of the other family: the intent was prepared on a rail this value cannot name.
      if (error instanceof Error && /transaction hash is invalid|transaction id$/i.test(error.message)) {
        return reply.code(400).send({
          type: 'validation', title: `A valid ${await withdrawalNetworkName(context.tenantId, withdrawalId)} transaction hash is required`, status: 400,
        });
      }
      throw error;
    }
    if (!result) return reply.code(404).send({ type: 'not-found', title: 'Withdrawal not found', status: 404 });
    const withdrawal = result.withdrawal;
    if (result.applied) appendAudit(store, {
      eventType: 'WITHDRAWAL_BROADCAST_RECORDED', aggregateId: withdrawal.withdrawalId,
      actorType: 'owner', actorId: context.ownerSubject,
      summary: `Owner wallet returned a ${CHAINS[withdrawal.chainKey].displayName} transaction hash for an authorized withdrawal`,
      metadata: { petId: withdrawal.petId, transactionHash: withdrawal.transactionHash },
    });
    return { withdrawal };
  });

  if (options.closeResourcesOnClose) app.addHook('onClose', async () => {
    await options.provisioner.close?.();
    await options.repository.close?.();
  });
}
