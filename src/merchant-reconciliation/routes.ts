import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MerchantAdapter } from '../adapters/merchant.js';
import { rawBodyOf } from '../funding/raw-body.js';
import type { MerchantWebhookHeaders } from './webhook.js';
import type { MerchantReconciliationRepository } from './repository.js';
import { MerchantIdentityConflictError } from './repository.js';
import { MerchantReconciliationWorker, type MerchantOrderSettlementInput, type MerchantRefundSettlementInput, type MerchantReconciler } from './reconciler.js';
import { merchantEventSchema } from './webhook-event.js';

interface MerchantWebhookVerifier {
  verify(rawBody: string, headers: MerchantWebhookHeaders): { deliveryId: string };
}

export interface MerchantReconciliationModuleOptions {
  repository: MerchantReconciliationRepository;
  reconciler: MerchantReconciler;
  webhookVerifier: MerchantWebhookVerifier;
  pollMs?: number;
  quoteRefreshMs?: number;
  closeRepositoryOnClose?: boolean;
}

interface MerchantReconciliationModule {
  adapter: MerchantAdapter;
  options: MerchantReconciliationModuleOptions;
}

interface MerchantReconciliationContext {
  resolvePurchase(requestId: string): import('./adapter.js').SettledPurchase | undefined;
  settleOrder(input: MerchantOrderSettlementInput): Promise<void>;
  settleRefund(input: MerchantRefundSettlementInput): Promise<void>;
}

export interface MerchantReconciliationSummary {
  ordersAttempted: number;
  refundsAttempted: number;
  ordersFailed: number;
  refundsFailed: number;
}

export class MerchantReconciliationBatchError extends Error {
  readonly summary: MerchantReconciliationSummary;

  constructor(summary: MerchantReconciliationSummary) {
    super(`Merchant reconciliation batch failed for ${summary.ordersFailed} orders and ${summary.refundsFailed} refunds`);
    this.name = 'MerchantReconciliationBatchError';
    this.summary = summary;
  }
}

export async function reconcileMerchantBatch(
  options: Pick<MerchantReconciliationModuleOptions, 'repository' | 'reconciler'>,
  limit: number,
): Promise<MerchantReconciliationSummary> {
  const orders = options.repository.listOrderCandidates(limit);
  const refunds = options.repository.listRefundCandidates(limit);
  let ordersFailed = 0;
  let refundsFailed = 0;
  for (const order of orders) {
    try { await options.reconciler.reconcileOrder(order.orderId); }
    catch { ordersFailed += 1; }
  }
  for (const refund of refunds) {
    try { await options.reconciler.reconcileRefund(refund.refundId); }
    catch { refundsFailed += 1; }
  }
  return { ordersAttempted: orders.length, refundsAttempted: refunds.length, ordersFailed, refundsFailed };
}

export async function reconcileMerchantBatchForWorker(
  options: Pick<MerchantReconciliationModuleOptions, 'repository' | 'reconciler'>,
  limit: number,
): Promise<MerchantReconciliationSummary> {
  const summary = await reconcileMerchantBatch(options, limit);
  if (summary.ordersFailed > 0 || summary.refundsFailed > 0) throw new MerchantReconciliationBatchError(summary);
  return summary;
}

export type MerchantReconciliationModuleFactory = (context: MerchantReconciliationContext) => MerchantReconciliationModule;

function publicOrder(order: ReturnType<MerchantReconciliationRepository['getOrder']>) {
  if (!order) return undefined;
  return {
    requestId: order.requestId, orderId: order.orderId, quoteId: order.quoteId,
    merchantId: order.merchantId, productId: order.productId, amountMinor: order.amountMinor,
    status: order.status, providerOrderId: order.providerOrderId, createdAt: order.createdAt, updatedAt: order.updatedAt,
  };
}

function publicRefund(refund: ReturnType<MerchantReconciliationRepository['getRefund']>) {
  if (!refund) return undefined;
  return {
    requestId: refund.requestId, refundId: refund.refundId, orderId: refund.orderId,
    amountMinor: refund.amountMinor, status: refund.status, transactionHash: refund.transactionHash,
    createdAt: refund.createdAt, updatedAt: refund.updatedAt,
  };
}

export function registerMerchantReconciliationRoutes(app: FastifyInstance, options: MerchantReconciliationModuleOptions): void {
  const runBatch = (limit: number) => reconcileMerchantBatch(options, limit);
  const worker = new MerchantReconciliationWorker(async () => { await reconcileMerchantBatchForWorker(options, 25); });
  const quoteWorker = new MerchantReconciliationWorker(async () => { await options.reconciler.refreshQuotes(); });

  app.get('/v1/merchant/orders', async (request, reply) => {
    const ownerId = request.headers['x-owner-id'];
    if (typeof ownerId !== 'string') return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    return { orders: options.repository.listOrdersByOwner(ownerId).map((order) => ({
      ...publicOrder(order), refund: publicRefund(options.repository.getRefundByRequestId(order.requestId)) ?? null,
    })) };
  });

  app.get('/v1/merchant/orders/:requestId', async (request, reply) => {
    const ownerId = request.headers['x-owner-id'];
    const { requestId } = request.params as { requestId: string };
    if (typeof ownerId !== 'string') return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const order = options.repository.getOrderByRequestId(requestId);
    if (!order || order.ownerId !== ownerId) return reply.code(404).send({ type: 'not-found', title: 'Merchant order not found', status: 404 });
    return { order: publicOrder(order), refund: publicRefund(options.repository.getRefundByRequestId(requestId)) ?? null };
  });

  app.post('/v1/webhooks/merchant', async (request, reply) => {
    const raw = rawBodyOf(request).toString('utf8');
    let verified: { deliveryId: string };
    try {
      verified = options.webhookVerifier.verify(raw, {
        'x-meowwa-merchant-event-id': typeof request.headers['x-meowwa-merchant-event-id'] === 'string' ? request.headers['x-meowwa-merchant-event-id'] : undefined,
        'x-meowwa-merchant-timestamp': typeof request.headers['x-meowwa-merchant-timestamp'] === 'string' ? request.headers['x-meowwa-merchant-timestamp'] : undefined,
        'x-meowwa-merchant-signature': typeof request.headers['x-meowwa-merchant-signature'] === 'string' ? request.headers['x-meowwa-merchant-signature'] : undefined,
      });
    } catch {
      return reply.code(400).send({ type: 'invalid-merchant-signature', title: 'Merchant webhook signature verification failed', status: 400 });
    }
    let parsed: z.infer<typeof merchantEventSchema>;
    try { parsed = merchantEventSchema.parse(request.body); }
    catch { return reply.code(400).send({ type: 'invalid-merchant-event', title: 'Merchant webhook event is invalid', status: 400 }); }
    let inserted: boolean;
    try {
      inserted = options.repository.recordWebhookDelivery({
        deliveryId: verified.deliveryId, eventType: parsed.type, payloadSha256: createHash('sha256').update(raw).digest('hex'),
      });
    } catch (error) {
      if (error instanceof MerchantIdentityConflictError) return reply.code(400).send({ type: 'invalid-merchant-event', title: 'Merchant webhook delivery identity conflicts', status: 400 });
      throw error;
    }
    if (!inserted && options.repository.isWebhookProcessed(verified.deliveryId)) return { received: true, duplicate: true };

    if ('providerOrderId' in parsed) {
      const status = parsed.type === 'order.confirmed' ? 'confirmed' : parsed.type === 'order.fulfilled' ? 'fulfilled' : parsed.type === 'order.cancelled' ? 'cancelled' : 'failed';
      const order = options.reconciler.recordOrderEvidence({
        providerReference: parsed.providerReference, providerOrderId: parsed.providerOrderId, status,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      });
      if (order) await options.reconciler.reconcileOrder(order.orderId);
    } else {
      const refund = options.reconciler.recordRefundEvidence({
        providerReference: parsed.providerReference, providerRefundId: parsed.providerRefundId,
        status: parsed.type === 'refund.confirmed' ? 'confirmed' : 'failed',
        ...(parsed.transactionHash ? { transactionHash: parsed.transactionHash.toLowerCase() as `0x${string}` } : {}),
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      });
      if (refund) await options.reconciler.reconcileRefund(refund.refundId);
    }
    options.repository.markWebhookProcessed(verified.deliveryId);
    return { received: true, duplicate: false };
  });

  app.post('/v1/system/merchant/reconcile', async (request) => {
    const { limit } = z.object({ limit: z.number().int().min(1).max(100).default(25) }).parse(request.body ?? {});
    return { reconciliation: await runBatch(limit) };
  });

  app.post('/v1/system/merchant/quotes/refresh', async () => ({ quotes: await options.reconciler.refreshQuotes() }));

  if (options.pollMs !== undefined) worker.start(options.pollMs, (error) => app.log.error({ error }, 'Merchant reconciliation failed'));
  if (options.quoteRefreshMs !== undefined) quoteWorker.start(options.quoteRefreshMs, (error) => app.log.error({ error }, 'Merchant quote refresh failed'));
  app.addHook('onClose', async () => {
    await worker.stop(); await quoteWorker.stop();
    if (options.closeRepositoryOnClose) options.repository.close();
  });
}
