import { PrivyClient, verifyAccessToken as verifyPrivyAccessToken } from '@privy-io/node';
import { recoverMessageAddress, type Hex } from 'viem';
import type { ChainDescriptor } from '@meowwa/chain-domain';
import { isEvmAddress } from './types.js';

/**
 * A bound on untrusted input, not a second opinion about how long an owner confirmation is. This
 * used to be 512 while the confirmation envelope in `modules/sandbox-auth.ts` had grown past it,
 * which never weakened a signature -- it fails closed -- but locked the owner out of the money
 * safety controls themselves: with the hosted Privy verifier wired in, a correctly signed policy
 * change, autonomy adjustment or support resolution came back `step-up-required` forever, because
 * the disclosure the same release had widened no longer fit. The envelope is derived from its own
 * formatter now and `privy.test.ts` asserts it stays under this ceiling, so the two cannot drift
 * apart again; keep this generous enough that it never becomes the binding constraint.
 */
export const MAX_OWNER_MESSAGE_CHARACTERS = 8_192;

export interface OwnerIdentityVerifier {
  verify(accessToken: string): Promise<{ privyUserId: string }>;
  verifyMessage?(accessToken: string, message: string, signature: string): Promise<boolean>;
}

type VerifyAccessToken = (input: {
  access_token: string;
  app_id: string;
  verification_key: string;
}) => Promise<{ user_id: string; app_id: string }>;

type AccessTokenVerifier = (accessToken: string) => Promise<{ user_id: string; app_id: string }>;

export class PrivyOwnerVerifier implements OwnerIdentityVerifier {
  readonly #appId: string;
  readonly #accessTokenVerifier: AccessTokenVerifier;
  readonly #userApi: Pick<PrivyUserWalletApi, 'getUser'> | undefined;

  constructor(options: {
    appId: string;
    verificationKey?: string;
    verifyAccessToken?: VerifyAccessToken;
    accessTokenVerifier?: AccessTokenVerifier;
    userApi?: Pick<PrivyUserWalletApi, 'getUser'>;
  }) {
    this.#appId = options.appId;
    if (options.accessTokenVerifier && options.verifyAccessToken) {
      throw new Error('Privy owner verification accepts only one token verifier');
    }
    if (options.accessTokenVerifier) {
      this.#accessTokenVerifier = options.accessTokenVerifier;
    } else {
      if (!options.verificationKey) throw new Error('Privy owner verification requires a key or JWKS verifier');
      const verify = options.verifyAccessToken ?? verifyPrivyAccessToken;
      this.#accessTokenVerifier = (accessToken) => verify({
        access_token: accessToken,
        app_id: this.#appId,
        verification_key: options.verificationKey!,
      });
    }
    this.#userApi = options.userApi;
  }

  async verify(accessToken: string): Promise<{ privyUserId: string }> {
    if (!accessToken) throw new Error('Privy access token is required');
    const claims = await this.#accessTokenVerifier(accessToken);
    if (claims.app_id !== this.#appId) throw new Error('Privy access token app does not match');
    if (!claims.user_id) throw new Error('Privy access token has no user');
    return { privyUserId: claims.user_id };
  }

  async verifyMessage(accessToken: string, message: string, signature: string): Promise<boolean> {
    if (!this.#userApi || !/^0x[0-9a-fA-F]{130}$/.test(signature) || !message ||
      message.length > MAX_OWNER_MESSAGE_CHARACTERS) return false;
    const { privyUserId } = await this.verify(accessToken);
    const user = await this.#userApi.getUser(privyUserId);
    // Owner identity is the owner's EVM key (EIP-191 personal_sign). A pet's Solana funding
    // wallet is a pet rail, not owner identity, so linked Solana accounts never prove a step-up.
    const addresses = user.linked_accounts.flatMap((account) => {
      const address = account.address;
      if (typeof address !== 'string' || !isEvmAddress(address)) return [];
      if (account.type === 'smart_wallet' || (account.type === 'wallet' && account.chain_type === 'ethereum')) return [address.toLowerCase()];
      return [];
    });
    if (addresses.length === 0) return false;
    let recovered: string;
    try {
      recovered = (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase();
    } catch {
      return false;
    }
    return addresses.includes(recovered);
  }
}

export interface PrivyUserRecord {
  id: string;
  linked_accounts: Array<Record<string, unknown>>;
}

export interface PrivyUserWalletApi {
  getUser(privyUserId: string): Promise<PrivyUserRecord>;
  /** Pregenerates embedded wallets of any registry family; the caller names the chain type. */
  pregenerateWallets(privyUserId: string, input: {
    wallets: Array<{ chain_type: ChainDescriptor['privyChainType']; external_id: string }>;
  }, idempotencyKey: string): Promise<PrivyUserRecord>;
  listWalletsByExternalId?(externalId: string): Promise<Array<{ id: string; external_id?: string }>>;
  getWallet?(walletId: string): Promise<{ id: string; address?: string; external_id?: string }>;
}

export function createPrivyUserWalletApi(client: PrivyClient): PrivyUserWalletApi {
  return {
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
    async getWallet(walletId) {
      return await client.wallets().get(walletId) as unknown as { id: string; address?: string; external_id?: string };
    },
  };
}

/**
 * Chosen against the API's own 10 s `connectionTimeout` (app.ts), which is what actually severs a
 * stalled client -- `requestTimeout` bounds request receipt, not the handler, and Fastify never
 * cancels a running handler. The SDK's defaults are 60 s per attempt with 2 retries and backoff,
 * i.e. ~181 s for one logical call, so during a Privy brownout the owner's request failed at 10 s
 * while the handler kept issuing Privy writes for minutes whose results nobody observed -- for
 * `prepareClientPolicyRotation` that means orphaned user-owned policies this server cannot delete.
 * 4 s x 2 attempts keeps one call inside the connection deadline. Every Privy client in the tree
 * is built here, so this covers wallet control, wallet execution, owner verification and the
 * provisioner worker. Residual: `inspectBinding` chains ~7 sequential calls and
 * `/v1/wallet-controls/batch-update-policies` loops it per pet, so an aggregate deadline around
 * those is still worth adding.
 */
const PRIVY_REQUEST_TIMEOUT_MS = 4_000;
const PRIVY_MAX_RETRIES = 1;

export function createPrivyClient(options: { appId: string; appSecret: string; jwtVerificationKey?: string }): PrivyClient {
  return new PrivyClient({
    appId: options.appId,
    appSecret: options.appSecret,
    ...(options.jwtVerificationKey ? { jwtVerificationKey: options.jwtVerificationKey } : {}),
    timeout: PRIVY_REQUEST_TIMEOUT_MS,
    maxRetries: PRIVY_MAX_RETRIES,
  });
}
