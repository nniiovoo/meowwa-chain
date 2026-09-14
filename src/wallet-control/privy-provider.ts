import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrivyClient } from '@privy-io/node';
import { CHAINS, isChainAddress, sameChainAddress, type ChainDescriptor } from '@meowwa/chain-domain';
import { policyDigest, type PrivyAgentSignerPolicy } from './policy.js';
import type {
  WalletControlAttestationProvider,
  WalletControlProvider,
  WalletControlProviderInspection,
} from './provider.js';

type RawAccount = Record<string, unknown>;

interface PrivyPolicyRecord extends Record<string, unknown> {
  id: string;
  owner_id: string | null;
  chain_type: unknown;
  name: unknown;
  version: unknown;
  rules: unknown;
}

interface PrivyUserRecord {
  id: string;
  linked_accounts: RawAccount[];
}

interface PrivyWalletRecord {
  id: string;
  address?: string;
  chain_type?: string;
  owner_id?: string | null;
  external_id?: string;
  additional_signers: Array<{ signer_id: string; override_policy_ids?: string[] }>;
}

interface PrivyKeyQuorumRecord {
  id: string;
  authorization_keys: Array<unknown>;
  authorization_threshold: number | null;
  user_ids: string[] | null;
  key_quorum_ids?: string[];
}

export interface PrivyWalletControlApi {
  createPolicy(policy: PrivyAgentSignerPolicy, idempotencyKey: string): Promise<PrivyPolicyRecord>;
  getPolicy(policyId: string): Promise<PrivyPolicyRecord>;
  getUser(privyUserId: string): Promise<PrivyUserRecord>;
  pregenerateWallets(privyUserId: string, input: {
    wallets: Array<{
      chain_type: ChainDescriptor['privyChainType'];
      external_id: string;
      additional_signers: Array<{ signer_id: string; override_policy_ids: string[] }>;
    }>;
  }, idempotencyKey: string): Promise<PrivyUserRecord>;
  listWalletsByExternalId(externalId: string): Promise<Array<{ id: string; external_id?: string }>>;
  updateWalletAdditionalSigner(walletId: string, input: {
    signerId: string; policyId: string; authorizationToken: string;
  }): Promise<void>;
  getWallet(walletId: string): Promise<PrivyWalletRecord>;
  getKeyQuorum(keyQuorumId: string): Promise<PrivyKeyQuorumRecord>;
}

function isEmbeddedOn(chain: ChainDescriptor): (account: RawAccount) => account is RawAccount & { id: string } {
  return (account): account is RawAccount & { id: string } =>
    account.type === 'wallet' && account.chain_type === chain.privyChainType && account.connector_type === 'embedded' &&
    account.wallet_client === 'privy' && typeof account.id === 'string' && account.id.length > 0;
}

function findEmbeddedAccount(chain: ChainDescriptor, user: PrivyUserRecord, walletId: string, address: string): (RawAccount & { id: string }) | undefined {
  const isEmbedded = isEmbeddedOn(chain);
  return user.linked_accounts.find((account): account is RawAccount & { id: string } => isEmbedded(account) && account.id === walletId &&
    typeof account.address === 'string' && sameChainAddress(chain, account.address, address));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function normalizeCondition(condition: unknown, chain: ChainDescriptor): unknown {
  if (!condition || typeof condition !== 'object') return condition;
  const record = condition as Record<string, unknown>;
  let value = record.value;
  if (record.field === 'destination.address') {
    // Hex case carries nothing on EVM; base58 case is the address on Solana.
    const fold = (item: unknown) => typeof item === 'string' && chain.family === 'evm' ? item.toLowerCase() : item;
    if (typeof value === 'string') value = fold(value);
    if (Array.isArray(value)) value = value.map(fold).sort();
  }
  return {
    field: record.field,
    field_source: record.field_source,
    operator: record.operator,
    value,
    ...(record.abi === undefined ? {} : { abi: record.abi }),
  };
}

function comparablePolicy(value: Record<string, unknown>, chain: ChainDescriptor): unknown {
  const rules = Array.isArray(value.rules) ? value.rules.map((rule) => {
    const record = rule as Record<string, unknown>;
    return {
      name: record.name,
      action: record.action,
      method: record.method,
      conditions: Array.isArray(record.conditions) ? record.conditions.map((condition) => normalizeCondition(condition, chain)) : record.conditions,
    };
  }) : value.rules;
  return canonicalize({ chain_type: value.chain_type, name: value.name, version: value.version, rules });
}

function policyMatches(record: PrivyPolicyRecord, expected: PrivyAgentSignerPolicy, chain: ChainDescriptor): boolean {
  return JSON.stringify(comparablePolicy(record, chain)) === JSON.stringify(comparablePolicy(expected as unknown as Record<string, unknown>, chain));
}

function driftDigest(record: PrivyPolicyRecord, chain: ChainDescriptor): string {
  return createHash('sha256').update(JSON.stringify(comparablePolicy(record, chain))).digest('hex');
}

/**
 * Privy wallet-control operations for one network. The chain decides the wallet type Privy is
 * asked for, which linked accounts count as the pet's embedded wallet, and how addresses compare;
 * it defaults to the Base Sepolia sandbox that every existing binding was provisioned on.
 */
export class PrivyWalletControlProvider implements WalletControlProvider, WalletControlAttestationProvider {
  readonly #api: PrivyWalletControlApi;
  readonly #chain: ChainDescriptor;
  readonly #isEmbedded: (account: RawAccount) => account is RawAccount & { id: string };

  constructor(api: PrivyWalletControlApi, chain: ChainDescriptor = CHAINS.base_sepolia) {
    this.#api = api;
    this.#chain = chain;
    this.#isEmbedded = isEmbeddedOn(chain);
  }

  async createUserOwnedPolicy(input: {
    privyUserId: string;
    policy: PrivyAgentSignerPolicy;
    idempotencyKey: string;
  }): Promise<{ policyId: string; digest: string; ownerType: 'privy_user' | 'key_quorum' | 'unknown' }> {
    if (input.policy.owner.user_id !== input.privyUserId) throw new Error('Policy owner does not match the authenticated Privy user');
    const user = await this.#api.getUser(input.privyUserId);
    if (user.id !== input.privyUserId) throw new Error('Privy user lookup did not match the authenticated owner');
    const created = await this.#api.createPolicy(input.policy, input.idempotencyKey);
    if (!created.id) throw new Error('Privy returned a policy without an ID');
    const actualOwnerType = await this.#ownerType(created.owner_id, input.privyUserId);
    if (actualOwnerType !== 'privy_user') throw new Error('Policy returned by Privy is not user-owned');
    if (!policyMatches(created, input.policy, this.#chain)) throw new Error('Policy returned by Privy does not match the requested rules');
    return { policyId: created.id, digest: policyDigest(input.policy), ownerType: actualOwnerType };
  }

  async provisionUserWallet(input: {
    privyUserId: string;
    externalId: string;
    agentSignerId: string;
    agentPolicyId: string;
    idempotencyKey: string;
  }): Promise<{ embeddedWalletId: string; smartWalletAddress: string }> {
    const before = await this.#api.getUser(input.privyUserId);
    if (before.id !== input.privyUserId) throw new Error('Privy user lookup did not match the authenticated owner');
    const embeddedBefore = new Set(before.linked_accounts.filter(this.#isEmbedded).map((account) => account.id));
    const result = await this.#api.pregenerateWallets(input.privyUserId, {
      wallets: [{
        chain_type: this.#chain.privyChainType, external_id: input.externalId,
        additional_signers: [{ signer_id: input.agentSignerId, override_policy_ids: [input.agentPolicyId] }],
      }],
    }, input.idempotencyKey);
    if (result.id !== input.privyUserId) throw new Error('Privy provisioned a wallet for a different user');
    const newEmbedded = result.linked_accounts.filter(this.#isEmbedded).filter((account) => !embeddedBefore.has(account.id));

    let embeddedWallet: { id: string; address: string };
    if (newEmbedded.length === 1 && typeof newEmbedded[0]!.address === 'string' && isChainAddress(this.#chain, newEmbedded[0]!.address)) {
      embeddedWallet = { id: newEmbedded[0]!.id, address: newEmbedded[0]!.address as string };
    }
    else if (newEmbedded.length === 0) {
      const byExternalId = await this.#api.listWalletsByExternalId(input.externalId);
      if (byExternalId.length !== 1 || !byExternalId[0]?.id) throw new Error('Privy did not return one unambiguous embedded wallet');
      const wallet = await this.#api.getWallet(byExternalId[0].id);
      const linked = result.linked_accounts.find((account) => this.#isEmbedded(account) && account.id === wallet.id);
      if (typeof wallet.address !== 'string' || !isChainAddress(this.#chain, wallet.address) ||
        typeof linked?.address !== 'string' || !sameChainAddress(this.#chain, linked.address, wallet.address)) {
        throw new Error('Privy did not return one unambiguous embedded wallet');
      }
      embeddedWallet = { id: wallet.id, address: wallet.address };
    } else {
      throw new Error('Privy did not return one unambiguous embedded wallet');
    }
    return { embeddedWalletId: embeddedWallet.id, smartWalletAddress: embeddedWallet.address };
  }

  async rotateUserWalletPolicy(input: {
    privyUserId: string;
    authorizationToken: string;
    embeddedWalletId: string;
    agentSignerId: string;
    agentPolicyId: string;
  }): Promise<void> {
    if (!input.privyUserId.startsWith('did:privy:') || input.authorizationToken.length < 8 ||
      !input.embeddedWalletId || !input.agentSignerId || !input.agentPolicyId) {
      throw new Error('Privy wallet policy rotation input is invalid');
    }
    const user = await this.#api.getUser(input.privyUserId);
    if (user.id !== input.privyUserId) throw new Error('Privy user lookup did not match the authenticated owner');
    await this.#api.updateWalletAdditionalSigner(input.embeddedWalletId, {
      signerId: input.agentSignerId,
      policyId: input.agentPolicyId,
      authorizationToken: input.authorizationToken,
    });
  }

  async findProvisionedWallet(input: { externalId: string; privyUserId?: string }): Promise<
    {
      embeddedWalletId: string;
      smartWalletAddress?: string;
      ownerResourceId?: string | null;
      userLinked?: boolean;
      agentSigners: Array<{ signerId: string; overridePolicyIds: string[] }>;
    } | undefined
  > {
    const wallets = await this.#api.listWalletsByExternalId(input.externalId);
    if (wallets.length === 0) return undefined;
    if (wallets.length !== 1) throw new Error('Privy returned an ambiguous external wallet identity');
    const record = await this.#api.getWallet(wallets[0]!.id);
    let userLinked: boolean | undefined;
    if (input.privyUserId !== undefined) {
      const user = await this.#api.getUser(input.privyUserId);
      const linked = typeof record.address === 'string'
        ? findEmbeddedAccount(this.#chain, user, record.id, record.address)
        : undefined;
      const ownerType = await this.#ownerType(record.owner_id, input.privyUserId);
      userLinked = user.id === input.privyUserId && linked !== undefined && record.chain_type === this.#chain.privyChainType &&
        ownerType === 'privy_user';
    }
    return {
      embeddedWalletId: record.id,
      ...(typeof record.address === 'string' ? { smartWalletAddress: record.address } : {}),
      ownerResourceId: record.owner_id ?? null,
      ...(userLinked === undefined ? {} : { userLinked }),
      agentSigners: Array.isArray(record.additional_signers) ? record.additional_signers.map((signer) => ({
        signerId: signer.signer_id,
        overridePolicyIds: Array.isArray(signer.override_policy_ids) ? [...signer.override_policy_ids] : [],
      })) : [],
    };
  }

  async inspectBinding(input: {
    privyUserId: string;
    embeddedWalletId: string;
    smartWalletAddress: string;
    agentPolicyId: string;
    expectedPolicy: PrivyAgentSignerPolicy;
  }): Promise<WalletControlProviderInspection> {
    const [initialUser, wallet, policy] = await Promise.all([
      this.#api.getUser(input.privyUserId),
      this.#api.getWallet(input.embeddedWalletId),
      this.#api.getPolicy(input.agentPolicyId),
    ]);
    let user = initialUser;
    // ponytail: bounded retry for Privy's eventually consistent user linkage; use provider events if this exceeds 5s.
    for (const retryMs of [0, 500, 1_500, 3_000]) {
      if (user.id !== input.privyUserId || findEmbeddedAccount(this.#chain, user, input.embeddedWalletId, input.smartWalletAddress)) break;
      await delay(retryMs);
      user = await this.#api.getUser(input.privyUserId);
    }
    const embeddedAccount = findEmbeddedAccount(this.#chain, user, input.embeddedWalletId, input.smartWalletAddress);
    const embeddedLinked = user.id === input.privyUserId && embeddedAccount !== undefined;
    const walletAddressMatches = typeof wallet.address === 'string' && typeof embeddedAccount?.address === 'string' &&
      sameChainAddress(this.#chain, wallet.address, embeddedAccount.address);
    const [walletOwnerType, policyOwnerType] = await Promise.all([
      this.#ownerType(wallet.owner_id, input.privyUserId),
      this.#ownerType(policy.owner_id, input.privyUserId),
    ]);
    const userOwnedEthereumWallet = wallet.chain_type === this.#chain.privyChainType && walletOwnerType === 'privy_user';
    return {
      privyUserId: user.id,
      embeddedWalletId: wallet.id,
      smartWalletAddress: typeof embeddedAccount?.address === 'string' ? embeddedAccount.address : input.smartWalletAddress,
      smartWalletType: embeddedAccount ? 'embedded_hd' : 'unknown',
      userLinked: embeddedLinked && wallet.id === input.embeddedWalletId && userOwnedEthereumWallet && walletAddressMatches,
      ownerResourceId: wallet.owner_id ?? null,
      agentSigners: Array.isArray(wallet.additional_signers) ? wallet.additional_signers.map((signer) => ({
        signerId: signer.signer_id,
        overridePolicyIds: Array.isArray(signer.override_policy_ids) ? [...signer.override_policy_ids] : [],
      })) : [],
      policy: {
        policyId: policy.id,
        digest: policyMatches(policy, input.expectedPolicy, this.#chain) ? policyDigest(input.expectedPolicy) : driftDigest(policy, this.#chain),
        ownerType: policyOwnerType,
        ownerResourceId: policy.owner_id ?? null,
      },
    };
  }

  async verifyAttestedControl(input: {
    embeddedWalletId: string;
    smartWalletAddress: string;
    ownerResourceId: string;
    agentSignerId: string;
    agentPolicyId: string;
    expectedPolicy: PrivyAgentSignerPolicy;
    expectedPrivyUserId: string | null;
  }): Promise<boolean> {
    const [wallet, policy, userOnlyOwner] = await Promise.all([
      this.#api.getWallet(input.embeddedWalletId),
      this.#api.getPolicy(input.agentPolicyId),
      this.#isUserOnlyOwner(input.ownerResourceId, input.expectedPrivyUserId),
    ]);
    return userOnlyOwner && wallet.id === input.embeddedWalletId && wallet.chain_type === this.#chain.privyChainType &&
      typeof wallet.address === 'string' && sameChainAddress(this.#chain, wallet.address, input.smartWalletAddress) &&
      wallet.owner_id === input.ownerResourceId && policy.id === input.agentPolicyId &&
      policy.owner_id === input.ownerResourceId && policyMatches(policy, input.expectedPolicy, this.#chain) &&
      wallet.additional_signers.length === 1 && wallet.additional_signers[0]?.signer_id === input.agentSignerId &&
      wallet.additional_signers[0].override_policy_ids?.length === 1 &&
      wallet.additional_signers[0].override_policy_ids[0] === input.agentPolicyId;
  }

  async #ownerType(ownerId: string | null | undefined, privyUserId: string): Promise<'privy_user' | 'key_quorum' | 'unknown'> {
    if (ownerId === null) return 'privy_user';
    if (typeof ownerId !== 'string' || !ownerId) return 'unknown';
    const quorum = await this.#api.getKeyQuorum(ownerId);
    return quorum.id === ownerId && quorum.authorization_threshold === 1 &&
      quorum.user_ids?.length === 1 && quorum.user_ids[0] === privyUserId &&
      quorum.authorization_keys.length === 0 && (quorum.key_quorum_ids?.length ?? 0) === 0
      ? 'privy_user'
      : 'key_quorum';
  }

  /**
   * Mirrors the privy_user branch of #ownerType, identity comparison included. Without that
   * comparison a quorum whose sole member was swapped after provisioning still attested as
   * owner-controlled, and agent-signed transfers kept being submitted with no drift recorded.
   */
  async #isUserOnlyOwner(ownerId: string, privyUserId: string | null): Promise<boolean> {
    if (!ownerId || !privyUserId) return false;
    const quorum = await this.#api.getKeyQuorum(ownerId);
    return quorum.id === ownerId && quorum.authorization_threshold === 1 && quorum.user_ids?.length === 1 &&
      quorum.user_ids[0] === privyUserId &&
      quorum.authorization_keys.length === 0 && (quorum.key_quorum_ids?.length ?? 0) === 0;
  }
}

export function createPrivyWalletControlApi(client: PrivyClient): PrivyWalletControlApi {
  return {
    async createPolicy(policy, idempotencyKey) {
      return await client.policies().create({
        ...policy,
        'privy-idempotency-key': idempotencyKey,
      } as never) as unknown as PrivyPolicyRecord;
    },
    async getPolicy(policyId) {
      return await client.policies().get(policyId) as unknown as PrivyPolicyRecord;
    },
    async getUser(privyUserId) {
      return await client.users()._get(privyUserId) as unknown as PrivyUserRecord;
    },
    async pregenerateWallets(privyUserId, input, idempotencyKey) {
      return await client.users().pregenerateWallets(privyUserId, input, {
        headers: { 'privy-idempotency-key': idempotencyKey },
      }) as unknown as PrivyUserRecord;
    },
    async listWalletsByExternalId(externalId) {
      const wallets: Array<{ id: string; external_id?: string }> = [];
      for await (const wallet of client.wallets().list({ external_id: externalId })) {
        wallets.push({ id: wallet.id, ...(wallet.external_id ? { external_id: wallet.external_id } : {}) });
        if (wallets.length > 1) break;
      }
      return wallets;
    },
    async updateWalletAdditionalSigner(walletId, input) {
      await client.wallets().update(walletId, {
        additional_signers: [{ signer_id: input.signerId, override_policy_ids: [input.policyId] }],
        authorization_context: { user_jwts: [input.authorizationToken] },
      });
    },
    async getWallet(walletId) {
      return await client.wallets().get(walletId) as unknown as PrivyWalletRecord;
    },
    async getKeyQuorum(keyQuorumId) {
      return await client.keyQuorums().get(keyQuorumId) as unknown as PrivyKeyQuorumRecord;
    },
  };
}
