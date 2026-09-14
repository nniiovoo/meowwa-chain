import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rawBodyOf } from '../funding/raw-body.js';
import { pocUsdcAtomicBalance, type AppStore } from '../store/memory-store.js';
import { WalletExecutionReconciliationWorker, type WalletExecutionReconciler } from './reconciler.js';
import { SubmissionConflictError, WalletExecutionRepository } from './repository.js';
import { PetWalletReceiveError, type PetWalletReceiveReconciler, type PetWalletReceiveResult } from './receive.js';
import type { BaseSepoliaReceiveIndexer } from './receive-indexer.js';
import type { WalletExecutionSubmission } from './types.js';
import { EVM_ADDRESS_PATTERN, EVM_HASH_PATTERN } from '@meowwa/chain-domain';

export interface WalletExecutionWebhookVerifier {
  verify(rawBody: string, headers: {
    'svix-id': string;
    'svix-timestamp': string;
    'svix-signature': string;
  }): unknown;
}

type PetWalletReceiveReconcilerFactory = (store: AppStore) => PetWalletReceiveReconciler;
type PetWalletReceiveIndexerFactory = (store: AppStore, receiveReconciler: PetWalletReceiveReconciler, repository: WalletExecutionRepository) => BaseSepoliaReceiveIndexer;

export interface WalletExecutionModuleOptions {
  repository: WalletExecutionRepository;
  reconciler: WalletExecutionReconciler;
  webhookVerifier: WalletExecutionWebhookVerifier;
  /** An instance uses the application store supplied by the caller. */
  receiveReconciler?: PetWalletReceiveReconciler;
  /** Resolve against the active application store after durable state is loaded. */
  receiveReconcilerFactory?: PetWalletReceiveReconcilerFactory;
  /** Automatic Base Sepolia receive scanning, resolved after the active store is known. */
  receiveIndexer?: BaseSepoliaReceiveIndexer;
  receiveIndexerFactory?: PetWalletReceiveIndexerFactory;
  /** Persist the active application store after an automatic receive scan commits. */
  onReceiveCommit?: () => void | Promise<void>;
  pollMs?: number;
  closeRepositoryOnClose?: boolean;
}

const transactionEventSchema = z.object({
  type: z.enum([
    'transaction.broadcasted', 'transaction.confirmed', 'transaction.execution_reverted',
    'transaction.failed', 'transaction.provider_error', 'transaction.replaced', 'transaction.still_pending',
  ]),
  wallet_id: z.string().min(3).max(255),
  transaction_id: z.string().min(3).max(255),
  caip2: z.string().min(3).max(64),
  reference_id: z.string().nullable().optional(),
  transaction_hash: z.string().nullable().optional(),
}).passthrough();

const privyTestEventSchema = z.object({ type: z.literal('privy.test') }).passthrough();
const verifiedPrivyEventSchema = z.union([transactionEventSchema, privyTestEventSchema]);

const receiveReconcileSchema = z.object({
  petId: z.string().min(1).max(255),
  transactionHash: z.string().regex(EVM_HASH_PATTERN),
  sender: z.string().regex(EVM_ADDRESS_PATTERN),
  amountAtomic: z.string().regex(/^[1-9][0-9]*$/),
}).strict();

function publicExecution(value: WalletExecutionSubmission) {
  return {
    requestId: value.requestId,
    petId: value.petId,
    status: value.status,
    network: 'Base Sepolia' as const,
    asset: 'test USDC' as const,
    recipient: value.recipient,
    amountAtomic: value.amountAtomic,
    transactionHash: value.transactionHash,
    confirmedAt: value.confirmedAt,
    ...(value.failureCode ? { failureCode: value.failureCode } : {}),
    updatedAt: value.updatedAt,
  };
}

function markIdentityReview(repository: WalletExecutionRepository, submission: WalletExecutionSubmission): WalletExecutionSubmission {
  if (!['submitting', 'submitted', 'provider_confirmed', 'unknown'].includes(submission.status)) return submission;
  return repository.markReviewRequired(submission.submissionId, submission.version, 'signed-webhook-identity-mismatch');
}

function publicReceiveReconciliation(value: PetWalletReceiveResult) {
  return {
    duplicate: value.duplicate,
    transfer: value.transfer,
    wallet: {
      walletId: value.wallet.walletId,
      petId: value.transfer.petId,
      chainId: value.wallet.chainId ?? 84532,
      balanceMinor: value.wallet.balanceMinor,
      balanceAtomic: pocUsdcAtomicBalance(value.wallet.balanceMinor),
    },
  };
}

export interface WalletExecutionReconciliationSummary {
  attempted: number;
  confirmed: number;
  reviewRequired: number;
  failed: number;
}

export class WalletExecutionBatchError extends Error {
  readonly summary: WalletExecutionReconciliationSummary;

  constructor(summary: WalletExecutionReconciliationSummary) {
    super(`Wallet execution reconciliation batch failed for ${summary.failed} submissions`);
    this.name = 'WalletExecutionBatchError';
    this.summary = summary;
  }
}

export async function reconcileWalletExecutionBatch(
  options: Pick<WalletExecutionModuleOptions, 'repository' | 'reconciler'>,
  limit: number,
): Promise<WalletExecutionReconciliationSummary> {
  const candidates = options.repository.listReconcileCandidates(limit);
  let confirmed = 0;
  let reviewRequired = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await options.reconciler.reconcile(candidate.submissionId);
      if (result.status === 'confirmed') confirmed += 1;
      if (result.status === 'review_required') reviewRequired += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: candidates.length, confirmed, reviewRequired, failed };
}

export function requireSuccessfulWalletExecutionBatch(
  summary: WalletExecutionReconciliationSummary,
): WalletExecutionReconciliationSummary {
  if (summary.failed > 0) throw new WalletExecutionBatchError(summary);
  return summary;
}

export function registerWalletExecutionRoutes(app: FastifyInstance, options: WalletExecutionModuleOptions): void {
  let activeBatch: Promise<WalletExecutionReconciliationSummary> | undefined;
  const runBatch = (limit: number): Promise<WalletExecutionReconciliationSummary> => {
    if (activeBatch) return activeBatch;
    const operation = reconcileWalletExecutionBatch(options, limit);
    activeBatch = operation;
    void operation.finally(() => {
      if (activeBatch === operation) activeBatch = undefined;
    }).catch(() => undefined);
    return operation;
  };
  const worker = new WalletExecutionReconciliationWorker({ runBatch: async () => {
    requireSuccessfulWalletExecutionBatch(await runBatch(25));
  } });
  const receiveWorker = options.receiveIndexer
    ? new WalletExecutionReconciliationWorker({ runBatch: async () => {
      return options.receiveIndexer!.scanOnce(options.onReceiveCommit);
    } })
    : undefined;

  app.get('/v1/wallet-executions', async (request, reply) => {
    const ownerId = request.headers['x-owner-id'];
    if (typeof ownerId !== 'string') return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    return { executions: options.repository.listByOwner(ownerId).map(publicExecution) };
  });

  app.get('/v1/wallet-executions/:requestId', async (request, reply) => {
    const ownerId = request.headers['x-owner-id'];
    const { requestId } = request.params as { requestId: string };
    if (typeof ownerId !== 'string') return reply.code(403).send({ type: 'owner-required', title: 'Owner access required', status: 403 });
    const execution = options.repository.getByRequestId(requestId);
    if (!execution || execution.ownerId !== ownerId) return reply.code(404).send({ type: 'not-found', title: 'Wallet execution not found', status: 404 });
    return { execution: publicExecution(execution) };
  });

  app.post('/v1/webhooks/privy', async (request, reply) => {
    const id = request.headers['svix-id'];
    const timestamp = request.headers['svix-timestamp'];
    const signature = request.headers['svix-signature'];
    if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
      return reply.code(400).send({ type: 'invalid-privy-signature', title: 'Privy webhook signature is required', status: 400 });
    }
    const raw = rawBodyOf(request).toString('utf8');
    let verified: unknown;
    try {
      verified = options.webhookVerifier.verify(raw, {
        'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature,
      });
    } catch {
      return reply.code(400).send({ type: 'invalid-privy-signature', title: 'Privy webhook signature verification failed', status: 400 });
    }
    const parsed = verifiedPrivyEventSchema.safeParse(verified);
    if (!parsed.success) return reply.code(400).send({ type: 'invalid-privy-event', title: 'Privy webhook event is invalid', status: 400 });
    const event = parsed.data;
    let inserted: boolean;
    try {
      inserted = options.repository.recordWebhookDelivery({
        deliveryId: id, eventType: event.type, payloadSha256: createHash('sha256').update(raw).digest('hex'),
      });
    } catch (error) {
      if (error instanceof SubmissionConflictError) {
        return reply.code(400).send({ type: 'invalid-privy-event', title: 'Privy webhook delivery identity conflicts', status: 400 });
      }
      throw error;
    }
    if (!inserted && options.repository.isWebhookProcessed(id)) return { received: true, duplicate: true };

    if (event.type === 'privy.test') {
      options.repository.markWebhookProcessed(id);
      return { received: true, duplicate: false };
    }

    const submission = (event.reference_id ? options.repository.getByReferenceId(event.reference_id) : undefined) ??
      options.repository.getByProviderTransactionId(event.transaction_id);
    if (submission) {
      const providerTransactionMatches = submission.providerTransactionId === event.transaction_id ||
        (event.type === 'transaction.confirmed' && submission.providerTransactionId === null &&
          ['submitting', 'unknown'].includes(submission.status));
      const identityMatches = submission.providerWalletId === event.wallet_id && providerTransactionMatches &&
        submission.referenceId === event.reference_id && event.caip2 === 'eip155:84532';
      if (!identityMatches) {
        markIdentityReview(options.repository, submission);
      } else if (event.type === 'transaction.confirmed') {
        if (typeof event.transaction_hash !== 'string' || !EVM_HASH_PATTERN.test(event.transaction_hash)) {
          markIdentityReview(options.repository, submission);
        } else {
          const providerConfirmed = options.reconciler.recordProviderConfirmed({
            providerTransactionId: event.transaction_id, providerWalletId: event.wallet_id,
            referenceId: event.reference_id!, caip2: event.caip2,
            transactionHash: event.transaction_hash.toLowerCase() as `0x${string}`,
          });
          await options.reconciler.reconcile(providerConfirmed.submissionId);
        }
      } else {
        await options.reconciler.reconcile(submission.submissionId);
      }
    }
    options.repository.markWebhookProcessed(id);
    return { received: true, duplicate: false };
  });

  app.post('/v1/system/wallet-executions/reconcile', async (request) => {
    const { limit } = z.object({ limit: z.number().int().min(1).max(100).default(25) }).parse(request.body ?? {});
    return { reconciliation: await runBatch(limit) };
  });

  if (options.receiveReconciler) {
    app.post('/v1/system/wallet-receives/reconcile', async (request, reply) => {
      const input = receiveReconcileSchema.parse(request.body ?? {});
      try {
        return { receive: publicReceiveReconciliation(await options.receiveReconciler!.reconcile(input)) };
      } catch (error) {
        if (!(error instanceof PetWalletReceiveError)) throw error;
        if (error.code === 'CHAIN_CONFIRMATION_PENDING') {
          return reply.code(202).send({ receive: { status: 'pending', code: error.code, message: error.message } });
        }
        return reply.code(error.statusCode).send({ type: error.code.toLowerCase().replaceAll('_', '-'), title: error.message, status: error.statusCode });
      }
    });
  }

  if (options.pollMs !== undefined) {
    worker.start(options.pollMs, (error) => app.log.error({ err: error }, 'Wallet execution reconciliation failed'));
    receiveWorker?.start(options.pollMs, (error) => app.log.error({ err: error }, 'Wallet receive indexing failed'));
  }
  app.addHook('onClose', async () => {
    await receiveWorker?.stop();
    await worker.stop();
    if (options.closeRepositoryOnClose) options.repository.close();
  });
}
