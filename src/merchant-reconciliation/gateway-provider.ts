import { POC_CATALOG, EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN } from '@meowwa/chain-domain';
import { z } from 'zod';
import { discardResponseBody, readBoundedResponseText } from '../http-response.js';
import { isPinnedKubernetesHttpService } from '../kubernetes-service-url.js';
import type { ControlledMerchantProvider, MerchantProviderOrder, MerchantProviderRefund } from './provider.js';
import type { ControlledMerchantQuote } from './types.js';

const address = z.string().regex(EVM_ADDRESS_PATTERN).transform((value) => value.toLowerCase());
const hash = z.string().regex(EVM_HASH_PATTERN).transform((value) => value.toLowerCase() as `0x${string}`);
const quoteSchema = z.object({
  quoteId: z.string().min(3).max(255), providerRevision: z.string().min(1).max(255),
  merchantId: z.string().min(3).max(255), merchantName: z.string().min(1).max(255), merchantRecipient: address,
  productId: z.string().min(3).max(255), productName: z.string().min(1).max(255),
  amountMinor: z.number().int().positive(), taxMinor: z.number().int().nonnegative(),
  shippingMinor: z.number().int().nonnegative(), feesMinor: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }), verifiedAt: z.iso.datetime({ offset: true }),
}).strict();
const orderSchema = z.object({
  providerReference: z.string().regex(/^mwo_[a-f0-9]{61}$/), providerOrderId: z.string().min(3).max(255),
  status: z.enum(['pending', 'confirmed', 'fulfilled', 'cancelled', 'failed']), reason: z.string().min(1).max(500).optional(),
}).strict();
const refundSchema = z.object({
  providerReference: z.string().regex(/^mwr_[a-f0-9]{61}$/), providerRefundId: z.string().min(3).max(255),
  status: z.enum(['pending', 'confirmed', 'failed']), transactionHash: hash.optional(), reason: z.string().min(1).max(500).optional(),
}).strict();

export class GatewayMerchantProvider implements ControlledMerchantProvider {
  readonly #baseUrl: URL;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    allowInsecureLoopback?: boolean;
    allowInsecureKubernetesService?: boolean;
  }) {
    const parsed = new URL(options.baseUrl);
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    const loopback = options.allowInsecureLoopback === true && parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    const kubernetesService = options.allowInsecureKubernetesService === true &&
      isPinnedKubernetesHttpService(parsed, { port: 4010, pathname: '/v1/' });
    if ((!loopback && !kubernetesService && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Merchant gateway URL must be HTTPS or an explicitly allowed internal HTTP URL');
    }
    if (!/^merchant_[A-Za-z0-9_-]{32,}$/.test(options.apiKey)) throw new Error('Merchant gateway API key is invalid');
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error('Merchant gateway timeout is invalid');
    this.#baseUrl = parsed; this.#apiKey = options.apiKey; this.#fetch = options.fetch ?? fetch; this.#timeoutMs = timeoutMs;
  }

  async fetchQuotes(): Promise<ControlledMerchantQuote[]> {
    const quotes = z.array(quoteSchema).length(POC_CATALOG.length).parse(await this.#request('quotes', { method: 'GET' }));
    const expected = new Map<string, string>(POC_CATALOG.map((product) => [product.productId, product.merchantId]));
    if (new Set(quotes.map((quote) => quote.productId)).size !== expected.size ||
        quotes.some((quote) => expected.get(quote.productId) !== quote.merchantId)) {
      throw new Error('Merchant gateway product catalog is invalid');
    }
    return quotes;
  }

  async createOrder(input: {
    providerReference: string; quoteId: string; requestId: string; amountMinor: number; paymentTransactionHash: `0x${string}`;
  }): Promise<MerchantProviderOrder> {
    return orderSchema.parse(await this.#request('orders', {
      method: 'POST', idempotencyKey: input.providerReference, body: input,
    }));
  }

  async getOrder(providerReference: string): Promise<MerchantProviderOrder | undefined> {
    const result = await this.#request(`orders/by-reference/${encodeURIComponent(providerReference)}`, { method: 'GET', allowNotFound: true });
    return result === undefined ? undefined : orderSchema.parse(result);
  }

  async createRefund(input: { providerReference: string; providerOrderId: string; requestId: string; amountMinor: number }): Promise<MerchantProviderRefund> {
    return refundSchema.parse(await this.#request('refunds', {
      method: 'POST', idempotencyKey: input.providerReference, body: input,
    }));
  }

  async getRefund(providerReference: string): Promise<MerchantProviderRefund | undefined> {
    const result = await this.#request(`refunds/by-reference/${encodeURIComponent(providerReference)}`, { method: 'GET', allowNotFound: true });
    return result === undefined ? undefined : refundSchema.parse(result);
  }

  async #request(path: string, options: {
    method: 'GET' | 'POST'; idempotencyKey?: string; body?: unknown; allowNotFound?: boolean;
  }): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin || !url.pathname.startsWith(this.#baseUrl.pathname)) throw new Error('Merchant gateway path is invalid');
    const headers: Record<string, string> = {
      accept: 'application/json', authorization: `Bearer ${this.#apiKey}`,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: options.method, headers, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(this.#timeoutMs), ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch { throw new Error('Merchant gateway request failed'); }
    if (response.status === 404 && options.allowNotFound) {
      await discardResponseBody(response);
      return undefined;
    }
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`Merchant gateway returned HTTP ${response.status}`);
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      await discardResponseBody(response);
      throw new Error('Merchant gateway response is not JSON');
    }
    const text = await readBoundedResponseText(response, 128_000, 'Merchant gateway response is too large');
    try { return JSON.parse(text) as unknown; } catch { throw new Error('Merchant gateway response is invalid JSON'); }
  }
}
