import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { CHAINS, isChainAddress, isChainTransactionId, type ChainDescriptor } from '@meowwa/chain-domain';
import { isCanonicalTenantId } from '../auth.js';
import { readBoundedResponseText } from '../http-response.js';
import { isAtomicAmount, isFundingChainKey, sameAddressOn, type FundingChainKey } from './types.js';

export type StripeOnrampStatus = 'initialized' | 'rejected' | 'requires_payment' | 'fulfillment_processing' | 'fulfillment_complete';

/** The `destination_network` values Stripe's Crypto Onramp uses for the production rails we fund. */
export type StripeOnrampNetwork = 'base' | 'solana';

const STRIPE_ONRAMP_NETWORKS: Readonly<Record<FundingChainKey, StripeOnrampNetwork>> = { base: 'base', solana: 'solana' };

/**
 * Stripe's network name for a production funding rail. Only production chains have an Onramp
 * rail (Stripe does not deliver to Base Sepolia or Solana devnet), so anything else throws.
 */
export function stripeOnrampNetwork(chainKey: FundingChainKey): StripeOnrampNetwork {
  if (!isFundingChainKey(chainKey)) throw new Error('Invalid Stripe Onramp chain');
  return STRIPE_ONRAMP_NETWORKS[chainKey];
}

/** The inverse of stripeOnrampNetwork: the funding rail a Stripe `destination_network` names, if any. */
export function stripeOnrampChainKey(network: unknown): FundingChainKey | undefined {
  if (typeof network !== 'string') return undefined;
  for (const chainKey of Object.keys(STRIPE_ONRAMP_NETWORKS) as FundingChainKey[]) {
    if (STRIPE_ONRAMP_NETWORKS[chainKey] === network) return chainKey;
  }
  return undefined;
}

export interface OnrampSessionInput {
  tenantId?: string;
  fundingId: string;
  ownerId: string;
  petId: string;
  walletId: string;
  chainKey: FundingChainKey;
  walletAddress: string;
  sourceAmountMinor?: number;
  customerIpAddress: string;
  idempotencyKey: string;
}

export interface VerifiedOnrampSession {
  providerSessionId: string;
  status: StripeOnrampStatus;
  livemode: boolean;
  chainKey: FundingChainKey;
  walletAddress: string;
  destinationCurrency: 'usdc';
  destinationNetwork: StripeOnrampNetwork;
  destinationAmountAtomic: string | null;
  transactionHash: string | null;
  metadata: Record<string, string>;
  redirectUrl: string | null;
}

export interface OnrampProvider {
  createSession(input: OnrampSessionInput): Promise<{ providerSessionId: string; redirectUrl: string; status: StripeOnrampStatus }>;
  retrieveSession(providerSessionId: string): Promise<VerifiedOnrampSession>;
  constructWebhook(rawBody: Buffer, signature: string): Stripe.Event;
}

export type OnrampSessionProvider = Pick<OnrampProvider, 'createSession' | 'retrieveSession'>;

export class StripeOnrampError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'StripeOnrampError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const statuses = new Set<StripeOnrampStatus>([
  'initialized', 'rejected', 'requires_payment', 'fulfillment_processing', 'fulfillment_complete',
]);

function objectValue(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function metadataValue(value: unknown): Record<string, string> {
  const metadata = objectValue(value, 'Stripe Onramp session metadata is invalid');
  if (Object.values(metadata).some((item) => typeof item !== 'string')) throw new Error('Stripe Onramp session metadata is invalid');
  return metadata as Record<string, string>;
}

function parseStatus(value: unknown): StripeOnrampStatus {
  if (typeof value !== 'string' || !statuses.has(value as StripeOnrampStatus)) throw new Error('Stripe Onramp session status is invalid');
  return value as StripeOnrampStatus;
}

function parseHostedRedirect(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Stripe Onramp redirect is invalid');
  let redirect: URL;
  try { redirect = new URL(value); } catch { throw new Error('Stripe Onramp hosted redirect is invalid'); }
  if (redirect.origin !== 'https://crypto.link.com' || redirect.username || redirect.password) {
    throw new Error('Stripe Onramp hosted redirect is invalid');
  }
  return redirect.toString();
}

function usdcDecimalToAtomic(value: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!match) throw new Error('Stripe Onramp USDC amount is invalid');
  const atomic = `${match[1]}${(match[2] ?? '').padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
  if (!isAtomicAmount(atomic)) throw new Error('Stripe Onramp USDC amount is invalid');
  return atomic;
}

/**
 * Strict re-parse of a Stripe session object. The network is read from the payload and mapped
 * back to a funding rail; callers compare the returned `chainKey` against what they asked for
 * (createSession) or what the funding row stores (the webhook processor and the funding route),
 * so a Solana session can never be taken for a Base one. Addresses and transaction ids are
 * validated per family and kept verbatim: base58 is case-sensitive, so nothing here lowercases.
 */
function parseSession(value: unknown): VerifiedOnrampSession & { redirectUrl: string | null } {
  const session = objectValue(value, 'Stripe Onramp session response is invalid');
  const details = objectValue(session.transaction_details, 'Stripe Onramp session transaction details are invalid');
  if (typeof session.id !== 'string' || !/^cos_[A-Za-z0-9_]+$/.test(session.id)) throw new Error('Stripe Onramp session ID is invalid');
  if (typeof session.livemode !== 'boolean') throw new Error('Stripe Onramp session mode is invalid');
  const chainKey = stripeOnrampChainKey(details.destination_network);
  if (details.destination_currency !== 'usdc' || chainKey === undefined || details.lock_wallet_address !== true) {
    throw new Error('Stripe Onramp session is not locked to a supported USDC network');
  }
  const chain: ChainDescriptor = CHAINS[chainKey];
  const network = stripeOnrampNetwork(chainKey);
  const walletAddresses = details.wallet_addresses && typeof details.wallet_addresses === 'object' && !Array.isArray(details.wallet_addresses)
    ? details.wallet_addresses as Record<string, unknown>
    : {};
  const walletAddress = typeof details.wallet_address === 'string' ? details.wallet_address : walletAddresses[network];
  if (typeof walletAddress !== 'string' || !isChainAddress(chain, walletAddress)) throw new Error('Stripe Onramp session wallet address is invalid');
  const transactionHash = details.transaction_id;
  if (transactionHash !== null && transactionHash !== undefined &&
    (typeof transactionHash !== 'string' || !isChainTransactionId(chain, transactionHash))) throw new Error('Stripe Onramp session transaction hash is invalid');
  if (session.status === 'fulfillment_complete' && (typeof transactionHash !== 'string' || !isChainTransactionId(chain, transactionHash))) {
    throw new Error('Stripe Onramp completed without a transaction hash');
  }
  const destinationAmountAtomic = details.destination_amount === null || details.destination_amount === undefined
    ? null
    : typeof details.destination_amount === 'string' ? usdcDecimalToAtomic(details.destination_amount) : (() => { throw new Error('Stripe Onramp USDC amount is invalid'); })();
  const redirectUrl = parseHostedRedirect(session.redirect_url);
  return {
    providerSessionId: session.id,
    status: parseStatus(session.status),
    livemode: session.livemode,
    chainKey,
    walletAddress,
    destinationCurrency: 'usdc',
    destinationNetwork: network,
    destinationAmountAtomic,
    transactionHash: transactionHash === null || transactionHash === undefined ? null : transactionHash,
    metadata: metadataValue(session.metadata ?? {}),
    redirectUrl,
  };
}

function sourceAmount(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('Stripe Onramp source amount must be positive integer cents');
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

function assertShortValue(value: string, name: string): void {
  if (!value || value.length > 255) throw new Error(`Invalid Stripe Onramp ${name}`);
}

/**
 * Stripe rejects a reused Idempotency-Key whose body differs (HTTP 409, type=idempotency_error),
 * and `customer_ip_address` is part of the body. Folding the IP into the wire key here — next to
 * the code that builds the body — keeps key and body in agreement for every caller: an exact retry
 * replays Stripe's cached response, while a retry from a new network mints a fresh session instead
 * of deadlocking until the key expires.
 *
 * The destination network is part of the body too, so the chain is folded in the same way — but
 * only when it is not Base, which keeps every existing Base key byte-identical to what was sent
 * before Solana existed (a Base retry in flight across the deploy must still replay, not 409).
 */
function wireIdempotencyKey(callerKey: string, customerIpAddress: string, chainKey: FundingChainKey): string {
  const chainSegment = chainKey === 'base' ? '' : `\0${chainKey}`;
  return `meowwa_${createHash('sha256').update(`meowwa:stripe-onramp-wire:v1\0${callerKey}\0${customerIpAddress}${chainSegment}`, 'utf8').digest('hex')}`;
}

export class StripeOnrampProvider implements OnrampProvider {
  readonly #secretKey: string;
  readonly #webhookSecret: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #stripe: Stripe;
  readonly #livemode: boolean;
  readonly #requestTimeoutMs: number;

  constructor(options: { secretKey: string; webhookSecret?: string; fetch?: typeof fetch; stripe?: Stripe; requestTimeoutMs?: number }) {
    this.#secretKey = options.secretKey;
    this.#webhookSecret = options.webhookSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#stripe = options.stripe ?? new Stripe(options.secretKey, { maxNetworkRetries: 2 });
    this.#livemode = options.secretKey.startsWith('sk_live_');
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 60_000) {
      throw new Error('Stripe Onramp request timeout is invalid');
    }
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async createSession(input: OnrampSessionInput): Promise<{ providerSessionId: string; redirectUrl: string; status: StripeOnrampStatus }> {
    if (!isFundingChainKey(input.chainKey)) throw new Error('Invalid Stripe Onramp chain');
    const chain: ChainDescriptor = CHAINS[input.chainKey];
    if (!isChainAddress(chain, input.walletAddress)) throw new Error('Invalid Stripe Onramp wallet address');
    if (input.tenantId !== undefined && !isCanonicalTenantId(input.tenantId)) {
      throw new Error('Invalid Stripe Onramp tenant ID');
    }
    for (const [name, value] of Object.entries({
      ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
      fundingId: input.fundingId, ownerId: input.ownerId, petId: input.petId,
      walletId: input.walletId, customerIpAddress: input.customerIpAddress, idempotencyKey: input.idempotencyKey,
    })) assertShortValue(value, name);
    const network = stripeOnrampNetwork(input.chainKey);
    const body = new URLSearchParams();
    body.set('source_currency', 'usd');
    if (input.sourceAmountMinor !== undefined) body.set('source_amount', sourceAmount(input.sourceAmountMinor));
    body.set('destination_currency', 'usdc');
    body.set('destination_currencies[0]', 'usdc');
    body.set('destination_network', network);
    body.set('destination_networks[0]', network);
    body.set(`wallet_addresses[${network}]`, input.walletAddress);
    body.set('lock_wallet_address', 'true');
    body.set('customer_ip_address', input.customerIpAddress);
    if (input.tenantId !== undefined) body.set('metadata[meowwa_tenant_id]', input.tenantId);
    body.set('metadata[meowwa_funding_id]', input.fundingId);
    body.set('metadata[meowwa_owner_id]', input.ownerId);
    body.set('metadata[meowwa_pet_id]', input.petId);
    body.set('metadata[meowwa_wallet_id]', input.walletId);
    const raw = await this.#request('https://api.stripe.com/v1/crypto/onramp_sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': wireIdempotencyKey(input.idempotencyKey, input.customerIpAddress, input.chainKey),
      },
      body: body.toString(),
    });
    const session = parseSession(raw);
    if (session.livemode !== this.#livemode) throw new Error('Stripe Onramp session mode does not match the configured key');
    if (session.chainKey !== input.chainKey || session.destinationNetwork !== network ||
      !sameAddressOn(input.chainKey, session.walletAddress, input.walletAddress) ||
      (input.tenantId !== undefined && session.metadata.meowwa_tenant_id !== input.tenantId) ||
      session.metadata.meowwa_funding_id !== input.fundingId || session.metadata.meowwa_owner_id !== input.ownerId ||
      session.metadata.meowwa_pet_id !== input.petId || session.metadata.meowwa_wallet_id !== input.walletId) {
      throw new Error('Stripe Onramp session response does not match the requested funding destination');
    }
    if (!session.redirectUrl) throw new Error('Stripe did not return a hosted Onramp redirect');
    return { providerSessionId: session.providerSessionId, redirectUrl: session.redirectUrl, status: session.status };
  }

  async retrieveSession(providerSessionId: string): Promise<VerifiedOnrampSession> {
    if (!/^cos_[A-Za-z0-9_]+$/.test(providerSessionId)) throw new Error('Invalid Stripe Onramp session ID');
    const raw = await this.#request(`https://api.stripe.com/v1/crypto/onramp_sessions/${encodeURIComponent(providerSessionId)}`, {
      method: 'GET', headers: { authorization: `Bearer ${this.#secretKey}` },
    });
    const session = parseSession(raw);
    if (session.providerSessionId !== providerSessionId) throw new Error('Stripe Onramp session ID does not match the request');
    if (session.livemode !== this.#livemode) throw new Error('Stripe Onramp session mode does not match the configured key');
    return session;
  }

  constructWebhook(rawBody: Buffer, signature: string): Stripe.Event {
    if (!this.#webhookSecret) throw new Error('Stripe webhook verification is not configured in this workload');
    if (!signature) throw new Error('Stripe webhook signature is required');
    const event = this.#stripe.webhooks.constructEvent(rawBody, signature, this.#webhookSecret, 300);
    if (event.livemode !== this.#livemode) throw new Error('Stripe webhook mode does not match the configured key');
    return event;
  }

  async #request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (cause) {
      // The timeout aborts with a TimeoutError DOMException and a dropped connection rejects with a
      // fetch TypeError. Neither is a StripeOnrampError, so both escaped every caller's mapping and
      // reached the owner as a bare 500 on the one screen where "was I charged?" matters. It is the
      // same answer as a 5xx from Stripe -- the provider did not answer -- so it is reported the
      // same way, and Stripe's own text stays server-side.
      throw new StripeOnrampError(
        cause instanceof Error ? cause.message : 'Stripe did not answer in time',
        'provider_unreachable',
        504,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedResponseText(response, 512 * 1024, 'Stripe returned an invalid response')) as unknown;
    } catch {
      throw new StripeOnrampError('Stripe returned an invalid response', 'invalid_response', response.status);
    }
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
        ? body.error as Record<string, unknown>
        : {};
      const code = typeof error.code === 'string' ? error.code : 'provider_error';
      const message = typeof error.message === 'string' ? error.message : 'Stripe could not create the Onramp session';
      throw new StripeOnrampError(message, code, response.status);
    }
    return body;
  }
}
