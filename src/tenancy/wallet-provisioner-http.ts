import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { PaymentIntent, WalletSubmission } from '../adapters/wallet.js';
import { authHeaderToken, isCanonicalTenantId } from '../auth.js';
import {
  CONTROL_CHAIN_KEYS,
  FUNDING_CHAIN_KEYS,
  fundingChainFor,
  isEvmAddress,
  type ControlChainKey,
} from '../funding/types.js';
import { discardResponseBody, readBoundedResponseText } from '../http-response.js';
import { rawBodyOf, registerRawJsonBodyParser } from '../funding/raw-body.js';
import type { TenantWalletBinding } from './financial-repository.js';
import type { TenantWalletProvisioningClient } from './funding-routes.js';
import {
  bindingWalletIdFor,
  requestedControlChain,
  TenantWalletProvisioningStageError,
} from './privy-wallet-provisioner.js';
import {
  TenantWalletWebhookEventError,
  TenantWalletWebhookVerificationError,
} from './tenant-wallet-reconciliation.js';
import { CHAINS, isChainAddress } from '@meowwa/chain-domain';

const controlChainKey = z.enum(CONTROL_CHAIN_KEYS);

const provisionRequest = z.object({
  tenantId: z.string().refine(isCanonicalTenantId),
  ownerSubject: z.string().min(1).max(512),
  privyUserId: z.string().min(11).max(512).startsWith('did:privy:'),
  petId: z.string().min(1).max(255),
  walletId: z.string().min(1).max(255),
  /** The control chain to provision on; Base Sepolia when absent, so a Base request is unchanged. */
  chain: controlChainKey.optional(),
}).strict();

/** The chains a provisioner can answer for; an attachment address must belong to one of them. */
const CONTROL_CHAINS = CONTROL_CHAIN_KEYS.map((key) => CHAINS[key]);

const provisioningAttachment = z.object({
  walletAddress: z.string().min(32).max(44).refine((value) => CONTROL_CHAINS.some((chain) => isChainAddress(chain, value))),
  agentSignerId: z.string().min(1).max(255),
  agentPolicyId: z.string().min(1).max(255),
  expectedPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  policyValidUntil: z.iso.datetime(),
  removeExistingSigners: z.boolean(),
}).strict();

const provisionCompletionRequest = provisionRequest.extend({
  agentPolicyId: z.string().min(1).max(255),
  expectedPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  policyValidUntil: z.iso.datetime(),
}).strict();

function providerFailureMetadata(error: TenantWalletProvisioningStageError): { status?: number; code?: string; detail?: string } {
  const cause = error.cause;
  if (!cause || typeof cause !== 'object') return {};
  const rawStatus = (cause as { status?: unknown }).status;
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : undefined;
  const body = (cause as { error?: unknown }).error;
  const rawCode = body && typeof body === 'object'
    ? ((body as { code?: unknown; type?: unknown }).code ?? (body as { type?: unknown }).type)
    : undefined;
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : undefined;
  const rawMessage = body && typeof body === 'object'
    ? ((body as { message?: unknown; error?: unknown; detail?: unknown }).message ??
      (body as { error?: unknown }).error ?? (body as { detail?: unknown }).detail)
    : undefined;
  const detail = typeof rawMessage === 'string'
    ? rawMessage
      .replace(/0x[0-9a-fA-F]{40}/g, '[address]')
      .replace(/did:privy:[A-Za-z0-9_.:-]+/g, '[privy-user]')
      .replace(/[A-Za-z0-9_-]{24,}/g, '[identifier]')
      .replace(/[^\x20-\x7E]/g, ' ')
      .slice(0, 240)
    : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * The wire binding. `chainKey` is optional only for the rollout window in which an older
 * provisioner still answers with `chainId` alone; it is then derived from the numeric id, which is
 * what the repository's row mapper does for pre-053 rows.
 */
const walletBindingFields = z.object({
  tenantId: z.string().refine(isCanonicalTenantId),
  walletId: z.string().min(1).max(255),
  petId: z.string().min(1).max(255),
  provider: z.literal('privy'),
  privyEmbeddedWalletId: z.string().min(1).max(255),
  smartWalletAddress: z.string().min(32).max(44),
  ownerQuorumId: z.string().min(1).max(255),
  agentSignerId: z.string().min(1).max(255),
  agentPolicyId: z.string().min(1).max(255),
  policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  policyValidUntil: z.iso.datetime(),
  controlVerifiedAt: z.iso.datetime(),
  chainKey: controlChainKey.optional(),
  chainId: z.number().int().nullable(),
  fundingChainKey: z.enum(FUNDING_CHAIN_KEYS).optional(),
  fundingChainId: z.number().int().nullable().optional(),
  fundingEnvironment: z.literal('production').optional(),
  custodyClassification: z.literal('owner_controlled').optional(),
  fundingVerifiedAt: z.iso.datetime().optional(),
  status: z.literal('active'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

type WireBinding = z.infer<typeof walletBindingFields>;

function wireChainKey(binding: Pick<WireBinding, 'chainKey' | 'chainId'>): ControlChainKey | undefined {
  if (binding.chainKey !== undefined) return binding.chainKey;
  return binding.chainId === CHAINS.base_sepolia.chainId ? 'base_sepolia' : undefined;
}

/** Whether the binding's chain, ids and address agree with the registry for one family. */
function consistentWireBinding(binding: WireBinding): boolean {
  const chainKey = wireChainKey(binding);
  if (chainKey === undefined) return false;
  const chain = CHAINS[chainKey];
  const fundingChain = CHAINS[fundingChainFor(chainKey)];
  const expectedChainId = chain.family === 'evm' ? chain.chainId : null;
  const expectedFundingChainId = fundingChain.family === 'evm' ? fundingChain.chainId : null;
  const attested = binding.fundingChainKey !== undefined || binding.fundingChainId != null ||
    binding.fundingEnvironment !== undefined || binding.custodyClassification !== undefined ||
    binding.fundingVerifiedAt !== undefined;
  return isChainAddress(chain, binding.smartWalletAddress) && binding.chainId === expectedChainId &&
    (!attested || (
      (binding.fundingChainKey ?? fundingChain.key) === fundingChain.key &&
      (binding.fundingChainId ?? expectedFundingChainId) === expectedFundingChainId &&
      binding.fundingEnvironment === 'production' && binding.custodyClassification === 'owner_controlled' &&
      binding.fundingVerifiedAt !== undefined
    ));
}

const walletBinding = walletBindingFields.refine(consistentWireBinding).transform((binding) => ({
  ...binding,
  chainKey: wireChainKey(binding)!,
}));

const provisionResponse = z.union([
  z.object({ wallet: walletBinding }).strict(),
  z.object({ status: z.literal('owner-authorization-required'), attachment: provisioningAttachment }).strict(),
]);

const revocationVerificationRequest = z.object({
  tenantId: z.string().refine(isCanonicalTenantId),
  petId: z.string().min(1).max(255),
  /** Which of the pet's bindings to verify; Base Sepolia when absent. */
  chain: controlChainKey.optional(),
}).strict();
const revocationVerificationResponse = z.object({
  status: z.enum(['revoked', 'drifted']),
  reason: z.string().min(1).max(255),
}).strict();

const paymentIntent = z.object({
  requestId: z.string().min(1).max(255),
  ownerId: z.string().min(1).max(512),
  petId: z.string().min(1).max(255),
  mandateId: z.string().min(1).max(255),
  merchantId: z.string().min(1).max(255),
  productId: z.string().min(1).max(255),
  quantity: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  currency: z.literal('USDC'),
  chainId: z.literal(84532),
  recipient: z.string().refine(isEvmAddress),
  contract: z.string().refine(isEvmAddress),
  quoteId: z.string().min(1).max(255),
  quoteExpiresAt: z.iso.datetime(),
  requestNonce: z.string().min(1).max(255),
  approvedBy: z.string().min(1).max(512).nullable(),
  ownerConfirmationStatus: z.enum(['confirmed', 'mandate_preapproved']),
  requestedApprovalMode: z.enum(['EVERY_REQUEST', 'LIMITED_AUTONOMY']),
  policyVersion: z.string().min(1).max(255),
  intentHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const executionRequest = z.object({
  tenantId: z.string().refine(isCanonicalTenantId),
  ownerSubject: z.string().min(1).max(512),
  payment: paymentIntent,
}).strict();

const walletSubmission = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('confirmed'), transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    network: z.literal('Base Sepolia'), token: z.literal('test USDC'),
  }).strict(),
  z.object({ status: z.literal('pending'), submissionId: z.string().regex(/^mw_[0-9a-f]{61}$/) }).strict(),
  z.object({ status: z.literal('failed'), reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,254}$/) }).strict(),
]);
const executionResponse = z.object({ submission: walletSubmission }).strict();

/**
 * Statuses the wallet service can only produce before it attempts the transfer: routing,
 * authentication, payload limits, and schema validation. A terminal `failed` is accurate for
 * these and nothing else — see `submit`.
 */
const PRE_SUBMISSION_REJECTIONS = new Set([400, 401, 403, 404, 413, 422]);

function strongToken(value: string): string {
  const decoded = Buffer.from(value, 'base64');
  if (value.trim() !== value || decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new Error('Wallet provisioner service token must be canonical base64 encoding of exactly 32 random bytes');
  }
  return value;
}

function exactOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Wallet provisioner URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Wallet provisioner URL must be an exact origin');
  }
  return url.origin;
}

/** A preparation's wallet must be an address of the chain the request named. */
function attachmentOnChain(attachment: z.infer<typeof provisioningAttachment>, chain: string | undefined): boolean {
  return isChainAddress(CHAINS[requestedControlChain(chain)], attachment.walletAddress);
}

function sameBinding(binding: TenantWalletBinding, request: z.infer<typeof provisionRequest>): boolean {
  const chainKey = requestedControlChain(request.chain);
  const chain = CHAINS[chainKey];
  return binding.tenantId === request.tenantId && binding.petId === request.petId &&
    binding.walletId === bindingWalletIdFor(chainKey, request.walletId) &&
    binding.provider === 'privy' && binding.chainKey === chainKey &&
    binding.chainId === (chain.family === 'evm' ? chain.chainId : null) &&
    isChainAddress(chain, binding.smartWalletAddress) && binding.status === 'active' &&
    binding.ownerQuorumId !== null &&
    binding.agentSignerId !== null && binding.agentPolicyId !== null && binding.policyDigest !== null &&
    binding.policyValidUntil !== null && binding.controlVerifiedAt !== null;
}

export class HttpTenantWalletProvisioningClient implements TenantWalletProvisioningClient {
  readonly #baseUrl: string;
  readonly #authToken: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl: string; authToken: string; requestTimeoutMs: number; fetch?: typeof fetch }) {
    this.#baseUrl = exactOrigin(options.baseUrl);
    this.#authToken = strongToken(options.authToken);
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 500 || options.requestTimeoutMs > 30_000) {
      throw new Error('Wallet provisioner request timeout is invalid');
    }
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Asks the provisioner whether the owner's detachment actually happened. */
  async verifyRevocation(
    input: { tenantId: string; petId: string; chain?: ControlChainKey | undefined },
  ): Promise<{ status: 'revoked' | 'drifted'; reason: string }> {
    const request = revocationVerificationRequest.parse(input);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/internal/v1/wallets/verify-revocation`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#authToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch {
      throw new Error('Wallet provisioner is unavailable');
    }
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error('Wallet provisioner is unavailable');
    }
    try {
      return revocationVerificationResponse.parse(JSON.parse(await readBoundedResponseText(
        response, 8_000, 'Wallet provisioner returned an invalid response',
      )));
    } catch { throw new Error('Wallet provisioner returned an invalid response'); }
  }

  async provision(input: Parameters<TenantWalletProvisioningClient['provision']>[0]) {
    const request = provisionRequest.parse(input);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/internal/v1/wallets/provision`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#authToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch {
      throw new Error('Wallet provisioner is unavailable');
    }
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error('Wallet provisioner is unavailable');
    }
    let parsed: z.infer<typeof provisionResponse>;
    try {
      parsed = provisionResponse.parse(JSON.parse(await readBoundedResponseText(
        response,
        128_000,
        'Wallet provisioner returned an invalid response',
      )));
    } catch { throw new Error('Wallet provisioner returned an invalid response'); }
    if ('status' in parsed) {
      if (!attachmentOnChain(parsed.attachment, request.chain)) throw new Error('Wallet provisioner returned an invalid response');
      return parsed;
    }
    // The owner DID is deliberately absent from the wire contract: only the provisioner workload
    // needs it, and it decrypts it locally during attestation.
    const wallet = { ...parsed.wallet, ownerPrivyUserId: null, revocationReason: null } as TenantWalletBinding;
    if (!sameBinding(wallet, request)) {
      throw new Error('Wallet provisioner response does not match the tenant wallet provisioning request');
    }
    return wallet;
  }

  async complete(input: Parameters<TenantWalletProvisioningClient['complete']>[0]): Promise<TenantWalletBinding> {
    const request = provisionCompletionRequest.parse(input);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/internal/v1/wallets/complete-provisioning`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#authToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch {
      throw new Error('Wallet provisioner is unavailable');
    }
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error('Wallet provisioner is unavailable');
    }
    let parsed: { wallet: z.output<typeof walletBinding> };
    try {
      const responseBody = provisionResponse.parse(JSON.parse(await readBoundedResponseText(
        response, 128_000, 'Wallet provisioner returned an invalid response',
      )));
      if ('status' in responseBody) throw new Error('Wallet provisioner returned an incomplete response');
      parsed = responseBody;
    } catch { throw new Error('Wallet provisioner returned an invalid response'); }
    const wallet = { ...parsed.wallet, ownerPrivyUserId: null, revocationReason: null } as TenantWalletBinding;
    if (!sameBinding(wallet, request)) throw new Error('Wallet provisioner response does not match the tenant wallet provisioning request');
    return wallet;
  }

  async submit(input: { tenantId: string; ownerSubject: string; payment: PaymentIntent }): Promise<WalletSubmission> {
    const request = executionRequest.parse(input);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/internal/v1/wallets/execute`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#authToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch {
      // The wallet service never answers 'failed' once it has attempted the Privy transfer —
      // on a provider throw it still returns 'pending'. A lost or aborted response therefore
      // means unknown, not "did not happen". Throwing routes this to executePayment's unknown
      // + reconciliation path instead of releasing the reservation and telling the owner that
      // no funds were deducted.
      throw new Error('Wallet service is unavailable');
    }
    if (!response.ok) {
      await discardResponseBody(response);
      // Routing, authentication, and schema validation all reject before the handler runs, so
      // for these the transfer was never attempted and a terminal failure is accurate. Every
      // other status (5xx, 408, 429, and 409, which the service may emit after submitting)
      // leaves the outcome unknown.
      if (PRE_SUBMISSION_REJECTIONS.has(response.status)) {
        return { status: 'failed', reason: 'WALLET_SERVICE_REJECTED' };
      }
      throw new Error('Wallet service is unavailable');
    }
    try {
      const parsed = executionResponse.parse(JSON.parse(await readBoundedResponseText(
        response,
        128_000,
        'Wallet provisioner returned an invalid response',
      )));
      return parsed.submission as WalletSubmission;
    } catch {
      // A 200 the service could not describe is still an outcome it may have applied.
      throw new Error('Wallet service returned an invalid submission');
    }
  }
}

export function buildTenantWalletProvisionerApp(options: {
  provisioner: TenantWalletProvisioningClient;
  execution?: { submit(input: z.infer<typeof executionRequest>): Promise<WalletSubmission> };
  webhookProcessor?: { process(rawBody: Buffer, headers: {
    'svix-id': string; 'svix-timestamp': string; 'svix-signature': string;
  }): Promise<{ received: true; duplicate: boolean; handled: boolean }> };
  revocation?: {
    verify(input: { tenantId: string; petId: string; chain?: ControlChainKey | undefined }): Promise<{ status: 'revoked' | 'drifted'; reason: string }>;
  };
  internalAuthToken: string;
  ready: () => Promise<boolean>;
}) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024, requestTimeout: 30_000, forceCloseConnections: 'idle' });
  const expected = createHash('sha256').update(strongToken(options.internalAuthToken), 'utf8').digest();
  registerRawJsonBodyParser(app);
  void app.register(helmet, {
    global: true,
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    let ready = false;
    try { ready = await options.ready(); } catch { /* unavailable is not ready */ }
    return ready ? { status: 'ready' } : reply.code(503).send({ status: 'not-ready' });
  });
  if (options.revocation) {
    const revocation = options.revocation;
    // The API cannot run this: verifying detachment needs the Privy app secret, and the API
    // workload is deliberately not given it. So the API asks this workload, which already holds
    // it, and only records what this endpoint reports.
    app.post('/internal/v1/wallets/verify-revocation', async (request, reply) => {
      const supplied = authHeaderToken(request.headers.authorization);
      const actual = createHash('sha256').update(supplied ?? '', 'utf8').digest();
      if (!supplied || !timingSafeEqual(expected, actual)) {
        return reply.code(401).send({ type: 'unauthorized', title: 'Service authentication required', status: 401 });
      }
      const input = revocationVerificationRequest.parse(request.body);
      return revocationVerificationResponse.parse(await revocation.verify(input));
    });
  }

  app.post('/internal/v1/wallets/provision', async (request, reply) => {
    const supplied = authHeaderToken(request.headers.authorization);
    const actual = createHash('sha256').update(supplied ?? '', 'utf8').digest();
    if (!supplied || !timingSafeEqual(expected, actual)) {
      return reply.code(401).send({ type: 'unauthorized', title: 'Service authentication required', status: 401 });
    }
    const parsed = provisionRequest.parse(request.body);
    // An API that predates chain keys names none; it means the Base Sepolia sandbox it always did.
    const input = { ...parsed, chain: requestedControlChain(parsed.chain) };
    const result = await options.provisioner.provision(input);
    if ('status' in result && result.status === 'owner-authorization-required') {
      if (!attachmentOnChain(result.attachment, input.chain)) throw new Error('Wallet provisioner produced a mismatched preparation');
      return reply.code(202).send(result);
    }
    const wallet = result;
    if (!sameBinding(wallet, input)) throw new Error('Wallet provisioner produced a mismatched binding');
    // The owner identity stays inside this workload; the client contract has no field for it.
    const { ownerPrivyUserId, revocationReason, ...wire } = wallet;
    void ownerPrivyUserId;
    void revocationReason;
    return { wallet: wire };
  });
  app.post('/internal/v1/wallets/complete-provisioning', async (request, reply) => {
    const supplied = authHeaderToken(request.headers.authorization);
    const actual = createHash('sha256').update(supplied ?? '', 'utf8').digest();
    if (!supplied || !timingSafeEqual(expected, actual)) {
      return reply.code(401).send({ type: 'unauthorized', title: 'Service authentication required', status: 401 });
    }
    const parsed = provisionCompletionRequest.parse(request.body);
    const input = { ...parsed, chain: requestedControlChain(parsed.chain) };
    const wallet = await options.provisioner.complete(input);
    if (!sameBinding(wallet, input)) throw new Error('Wallet provisioner produced a mismatched binding');
    const { ownerPrivyUserId, revocationReason, ...wire } = wallet;
    void ownerPrivyUserId;
    void revocationReason;
    return { wallet: wire };
  });
  if (options.execution) {
    app.post('/internal/v1/wallets/execute', async (request, reply) => {
      const supplied = authHeaderToken(request.headers.authorization);
      const actual = createHash('sha256').update(supplied ?? '', 'utf8').digest();
      if (!supplied || !timingSafeEqual(expected, actual)) {
        return reply.code(401).send({ type: 'unauthorized', title: 'Service authentication required', status: 401 });
      }
      const input = executionRequest.parse(request.body);
      return { submission: await options.execution!.submit(input) };
    });
  }
  if (options.webhookProcessor) {
    app.post('/v1/webhooks/privy', async (request, reply) => {
      const id = request.headers['svix-id'];
      const timestamp = request.headers['svix-timestamp'];
      const signature = request.headers['svix-signature'];
      if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
        return reply.code(400).send({
          type: 'invalid-privy-signature', title: 'Privy webhook signature is required', status: 400,
        });
      }
      try {
        return await options.webhookProcessor!.process(rawBodyOf(request), {
          'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature,
        });
      } catch (error) {
        if (error instanceof TenantWalletWebhookVerificationError) {
          return reply.code(400).send({
            type: 'invalid-privy-signature', title: 'Privy webhook signature verification failed', status: 400,
          });
        }
        if (error instanceof TenantWalletWebhookEventError) {
          return reply.code(400).send({ type: 'invalid-privy-event', title: 'Privy webhook event is invalid', status: 400 });
        }
        return reply.code(503).send({
          type: 'privy-processing-unavailable', title: 'Privy event processing is temporarily unavailable', status: 503,
        });
      }
    });
  }
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ type: 'validation', title: 'Invalid request', status: 400 });
    }
    if (error instanceof TenantWalletProvisioningStageError) {
      process.stderr.write(`${JSON.stringify({
        level: 'error', event: 'wallet-provisioner.stage-failed', stage: error.stage,
        ...providerFailureMetadata(error),
      })}\n`);
    }
    return reply.code(500).send({ type: 'about:blank', title: 'Internal Server Error', status: 500 });
  });
  app.addHook('onClose', async () => { await options.provisioner.close?.(); });
  return app;
}
