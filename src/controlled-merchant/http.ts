import { timingSafeEqual } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { MerchantIdentityConflictError } from '../merchant-reconciliation/repository.js';
import type { FirstPartyControlledMerchantService } from './service.js';
import { EVM_HASH_PATTERN } from '@meowwa/chain-domain';

const hash = z.string().regex(EVM_HASH_PATTERN).transform((value) => value.toLowerCase() as `0x${string}`);
const orderReference = z.string().regex(/^mwo_[a-f0-9]{61}$/);
const refundReference = z.string().regex(/^mwr_[a-f0-9]{61}$/);
const createOrderSchema = z.object({
  providerReference: orderReference,
  quoteId: z.string().min(1).max(255),
  requestId: z.string().min(1).max(255),
  amountMinor: z.number().int().positive(),
  paymentTransactionHash: hash,
}).strict();
const createRefundSchema = z.object({
  providerReference: refundReference,
  providerOrderId: z.string().min(1).max(255),
  requestId: z.string().min(1).max(255),
  amountMinor: z.number().int().positive(),
}).strict();

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function idempotencyMatches(header: string | string[] | undefined, reference: string): boolean {
  if (typeof header !== 'string') return false;
  const supplied = Buffer.from(header);
  const expected = Buffer.from(reference);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function clientInputError(error: unknown): boolean {
  return error instanceof Error && /^(Invalid controlled merchant|Controlled merchant quote is|Controlled merchant refund does)/.test(error.message);
}

export function buildControlledMerchantApp(options: {
  service: FirstPartyControlledMerchantService;
  apiKey: string;
  ready(): Promise<boolean>;
}) {
  if (!/^merchant_[A-Za-z0-9_-]{32,}$/.test(options.apiKey)) throw new Error('Controlled merchant API key is invalid');
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 72_000,
    forceCloseConnections: 'idle',
    return503OnClosing: true,
  });
  void app.register(helmet, {
    global: true,
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });
  // Gate on the route fastify actually matched, never on request.url. Testing the raw target
  // meant anything that did not look like `/v1/` skipped the key check, and the router accepts
  // request targets that do not: an absolute-form `POST http://any/v1/orders` matched the handler
  // while the string here kept its `http://any` prefix. A pattern is what was dispatched, and an
  // unmatched request has none, so this fails closed.
  const PUBLIC_ROUTES = new Set(['/healthz']);
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? '')) return;
    const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    if (!bearerMatches(authorization, options.apiKey)) {
      await reply.code(401).send({ type: 'merchant-auth-required', title: 'Merchant authentication required', status: 401 });
    }
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError || clientInputError(error)) {
      return reply.code(400).send({ type: 'invalid-merchant-request', title: 'Invalid merchant request', status: 400 });
    }
    if (error instanceof MerchantIdentityConflictError) {
      return reply.code(409).send({ type: 'merchant-identity-conflict', title: 'Merchant identity conflict', status: 409 });
    }
    return reply.code(503).send({ type: 'merchant-unavailable', title: 'Merchant temporarily unavailable', status: 503 });
  });

  app.get('/healthz', async (_request, reply) => {
    const ready = await Promise.race([
      options.ready().catch(() => false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_500);
        timer.unref?.();
      }),
    ]);
    return ready ? { status: 'ok' } : reply.code(503).send({ status: 'not-ready' });
  });
  app.get('/v1/quotes', async () => options.service.fetchQuotes());
  app.post('/v1/orders', async (request, reply) => {
    const input = createOrderSchema.parse(request.body);
    if (!idempotencyMatches(request.headers['idempotency-key'], input.providerReference)) {
      return reply.code(400).send({ type: 'invalid-idempotency-key', title: 'Idempotency key must match provider reference', status: 400 });
    }
    return options.service.createOrder(input);
  });
  app.get<{ Params: { providerReference: string } }>('/v1/orders/by-reference/:providerReference', async (request, reply) => {
    const reference = orderReference.parse(request.params.providerReference);
    const order = await options.service.getOrder(reference);
    return order ?? reply.code(404).send({ type: 'merchant-order-not-found', title: 'Merchant order not found', status: 404 });
  });
  app.post('/v1/refunds', async (request, reply) => {
    const input = createRefundSchema.parse(request.body);
    if (!idempotencyMatches(request.headers['idempotency-key'], input.providerReference)) {
      return reply.code(400).send({ type: 'invalid-idempotency-key', title: 'Idempotency key must match provider reference', status: 400 });
    }
    return options.service.createRefund(input);
  });
  app.get<{ Params: { providerReference: string } }>('/v1/refunds/by-reference/:providerReference', async (request, reply) => {
    const reference = refundReference.parse(request.params.providerReference);
    const refund = await options.service.getRefund(reference);
    return refund ?? reply.code(404).send({ type: 'merchant-refund-not-found', title: 'Merchant refund not found', status: 404 });
  });
  return app;
}
