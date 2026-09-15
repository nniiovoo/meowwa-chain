import { createHash, timingSafeEqual } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { registerRawJsonBodyParser, rawBodyOf } from '../funding/raw-body.js';
import { safeErrorProjection } from '../observability/logger.js';
import { TenantBaseReorgDetectedError } from './base-usdc-indexer.js';
import type { FundingChainKey } from '../funding/types.js';
import type { LedgerSweepSummary } from './ledger-reconciliation.js';
import {
  TenantStripeEventError,
  TenantStripeWebhookVerificationError,
} from './stripe-event-processor.js';

export interface TenantStripeProcessor {
  process(rawBody: Buffer, signature: string): Promise<{ received: true; duplicate: boolean; handled: boolean }>;
}

export interface TenantFinancialIndexingWorker {
  start(pollMs: number, onError: (error: unknown) => void, onScan?: () => void): void;
  stop(): Promise<void>;
}

/**
 * A halt names the rail it happened on. Both rails follow the same runbook, but on a finalized-only
 * chain a changed checkpoint is an RPC identity problem rather than a reorganization, and the
 * operator needs to know which one they are looking at before they start reconciling.
 */
function reorgActionRequired(chainKey: FundingChainKey | undefined): string {
  const rail = chainKey === 'solana' ? 'the Solana' : 'the Base';
  return `follow docs/runbooks/BASE_REORG.md to reconcile ${rail} window before indexing resumes`;
}

/** The sweep hands its summary back, because a sweep that resolved is not a sweep that verified. */
export interface TenantFinancialSweepWorker {
  start(pollMs: number, onError: (error: unknown) => void, onSweep?: (summary: LedgerSweepSummary) => void): void;
  stop(): Promise<void>;
}

/**
 * The single "did this pass actually verify the fleet?" predicate. A pass verifies only if it
 * reached every listed wallet AND consulted the one truth source outside this database. Thrown
 * (walletErrors), dropped (walletsUnresolved) and skipped (onchainComparison !== 'ran') are all
 * "did not check": a skip is not a pass, and a discrepancy count produced by a pass that checked
 * nothing is not evidence that the books are clean. Returns the reason, or undefined when clean.
 */
function sweepUnverifiedReason(summary: LedgerSweepSummary): string | undefined {
  if (summary.walletsChecked === 0) return 'no_wallet_checked';
  if (summary.walletErrors > 0) return 'wallet_errors';
  if (summary.walletsUnresolved > 0) return 'wallets_unresolved';
  if (summary.onchainComparison !== 'ran') return summary.onchainComparison;
  return undefined;
}

function limitedReadiness(check: () => Promise<boolean>): Promise<boolean> {
  return Promise.race([
    check().catch(() => false),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_500);
      timer.unref?.();
    }),
  ]);
}

export function buildTenantFinancialWorkerApp(options: {
  processor: TenantStripeProcessor;
  indexer: TenantFinancialIndexingWorker;
  scanPollMs: number;
  /**
   * Durable halt bookkeeping for a detected mainnet reorganization. Optional so the sandbox worker
   * can run without it, but a production worker without it degrades to the stderr-only behaviour
   * this exists to replace, so server.ts wires it whenever the repository is available.
   */
  /** Independent ledger reconciliation: compares sources rather than trusting derived balances. */
  reconciliation?: {
    reconcileWalletLedger(tenantId: string, walletId: string): Promise<{
      tenantId: string; walletId: string;
      ledgerAtomic: string; canonicalChainAtomic: string; reorgedCreditAtomic: string;
      reorgedDebitAtomic: string; inFlightWithdrawalAtomic: string; consistent: boolean;
    }>;
    listOpenLedgerDiscrepancies?(limit: number): Promise<Array<Record<string, unknown>>>;
  };
  /**
   * The scheduled fleet sweep is the production consumer of reconciliation; the HTTP endpoint
   * above is an operator diagnostic. The diagnostic requires this dedicated bearer credential
   * and simply does not exist without one — an unauthenticated per-tenant financial readout on
   * a listening port is not a diagnostic, it is a leak.
   */
  diagnosticsBearerToken?: string;
  reconciliationSweep?: TenantFinancialSweepWorker;
  reconciliationSweepPollMs?: number;
  reconciliationAlerts?: {
    openLedgerDiscrepancyCount(): Promise<number>;
  };
  reorgHalts?: {
    /**
     * The rail rides along on the checkpoint so the halt is recorded against the chain that
     * actually diverged; absent, as in a single-rail sandbox, it is Base.
     */
    recordBaseReorgHalt(input: {
      chainKey?: FundingChainKey; blockNumber: number; blockHash: string;
    }): Promise<{ recorded: boolean; reorgedEvents: number }>;
    /** An unresolved halt on any funded rail: crediting is stopped somewhere and must page. */
    unresolvedBaseReorgHalt(): Promise<{
      chainKey?: FundingChainKey; checkpointBlockNumber: number; checkpointBlockHash: string; detectedAt: string;
    } | undefined>;
  };
  repositoryReady: () => Promise<boolean>;
  chainReady: () => Promise<boolean>;
}) {
  if (!Number.isSafeInteger(options.scanPollMs) || options.scanPollMs < 1_000 || options.scanPollMs > 3_600_000) {
    throw new Error('Financial worker scan interval is invalid');
  }
  if (options.diagnosticsBearerToken !== undefined && options.diagnosticsBearerToken.length < 32) {
    throw new Error('Financial diagnostics credential must be at least 32 bytes');
  }
  if (options.reconciliationSweep && (
    !Number.isSafeInteger(options.reconciliationSweepPollMs) ||
    options.reconciliationSweepPollMs! < 60_000 || options.reconciliationSweepPollMs! > 86_400_000)) {
    throw new Error('Financial reconciliation sweep interval is invalid');
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
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
  registerRawJsonBodyParser(app);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });
  // The metricsBearerToken shape: hash both sides to constant length, compare in constant time.
  const expectedDiagnosticsToken = options.diagnosticsBearerToken
    ? createHash('sha256').update(options.diagnosticsBearerToken).digest()
    : undefined;
  const diagnosticsAuthorized = (authorization: unknown): boolean => {
    if (!expectedDiagnosticsToken || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      return false;
    }
    const received = createHash('sha256').update(authorization.slice('Bearer '.length)).digest();
    return timingSafeEqual(expectedDiagnosticsToken, received);
  };

  // Independent reconciliation for operators. Read-only and deliberately comparative: it reports
  // what each source says and whether they agree, so a drift between the ledger and the chain
  // surfaces as data rather than as a wrong balance somewhere. The scheduled sweep is the
  // production consumer; this diagnostic exists only behind the dedicated operator credential.
  app.get('/v1/reconciliation/ledger', async (request, reply) => {
    if (!options.reconciliation || !expectedDiagnosticsToken) {
      return reply.code(503).send({ type: 'reconciliation-unavailable', title: 'Ledger reconciliation diagnostics are not configured', status: 503 });
    }
    if (!diagnosticsAuthorized(request.headers.authorization)) {
      return reply.code(401).send({ type: 'unauthorized', title: 'Diagnostics authentication required', status: 401 });
    }
    const query = request.query as { tenantId?: unknown; walletId?: unknown };
    const tenantId = typeof query.tenantId === 'string' ? query.tenantId : '';
    const walletId = typeof query.walletId === 'string' ? query.walletId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tenantId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(walletId)) {
      return reply.code(400).send({ type: 'invalid-reconciliation-target', title: 'Tenant and wallet identifiers are required', status: 400 });
    }
    return options.reconciliation.reconcileWalletLedger(tenantId, walletId);
  });

  app.get('/v1/reconciliation/discrepancies', async (request, reply) => {
    if (!options.reconciliation?.listOpenLedgerDiscrepancies || !expectedDiagnosticsToken) {
      return reply.code(503).send({ type: 'reconciliation-unavailable', title: 'Ledger reconciliation diagnostics are not configured', status: 503 });
    }
    if (!diagnosticsAuthorized(request.headers.authorization)) {
      return reply.code(401).send({ type: 'unauthorized', title: 'Diagnostics authentication required', status: 401 });
    }
    return { discrepancies: await options.reconciliation.listOpenLedgerDiscrepancies(100) };
  });

  // The synchronous in-process latch. Detection sets it before any persistence attempt, so a
  // failing or in-flight halt record can never leave readiness green while crediting continues.
  // It is deliberately one-way: only a process restart clears it, which is already the runbook's
  // final step after the durable record is resolved (docs/runbooks/BASE_REORG.md).
  let latchedReorg: { chainKey?: FundingChainKey; blockNumber: number; blockHash: string; latchedAt: string } | undefined;
  // A reorg is not the only way crediting dies. An RPC or database outage throws every scan, the
  // cursor never advances, and no deposit is credited -- but only the reorg latch closed
  // readiness, so monitoring saw a green worker crediting nothing. Cleared by the next completed
  // scan, so a transient blip self-heals on the following poll.
  let failedScanAt: string | undefined;
  // The same argument for the ledger sweep. `openLedgerDiscrepancyCount` is a SELECT over the table
  // the sweep WRITES, so it happily returns 0 for a sweep that has been failing every pass -- and
  // docs/runbooks/LEDGER_DISCREPANCY.md tells the operator to alert on a non-zero count, so a dead
  // fleet-wide money-integrity check published "books verified clean". Cleared by the next completed
  // sweep, so a transient blip self-heals. A sweep that resolved having verified nothing counts as
  // a failure here for the same reason -- see sweepUnverifiedReason: per-wallet errors are isolated
  // inside the sweep, unresolvable wallets are skipped without raising, and the on-chain comparison
  // can sit out a whole pass, so a revoked GRANT, a statement timeout, a broken tenant resolution
  // or a dead indexer completes every pass while verifying nothing -- exactly the dead check this
  // gate exists to catch. The earliest failure time is kept (how long unverified) with the latest
  // reason (why it is unverified right now); readiness publishes both.
  let failedSweep: { at: string; reason: string } | undefined;
  // No sweep has completed yet in this process, so its count is not yet evidence of anything.
  let sweptOnce = options.reconciliationSweep === undefined;

  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    // A reorg halt outranks every other readiness signal: crediting is deliberately stopped, and
    // monitoring must page an operator rather than an owner discovering a frozen balance.
    if (latchedReorg) {
      return reply.code(503).send({
        status: 'reorg_halted',
        reorg: {
          ...(latchedReorg.chainKey ? { chainKey: latchedReorg.chainKey } : {}),
          checkpointBlockNumber: latchedReorg.blockNumber,
          checkpointBlockHash: latchedReorg.blockHash,
          detectedAt: latchedReorg.latchedAt,
          actionRequired: reorgActionRequired(latchedReorg.chainKey),
        },
      });
    }
    if (options.reorgHalts) {
      let halt;
      try {
        halt = await options.reorgHalts.unresolvedBaseReorgHalt();
      } catch {
        // Unknown halt state is halt state. Converting a failed read into "no halt" left a real
        // durable halt invisible whenever the halts table was unreadable while SELECT 1 and the
        // RPC head call still succeeded.
        return reply.code(503).send({
          status: 'reorg_status_unavailable',
          actionRequired: 'the durable reorg halt record could not be read; treat as halted and follow docs/runbooks/BASE_REORG.md',
        });
      }
      if (halt) {
        return reply.code(503).send({
          status: 'reorg_halted',
          reorg: {
            ...(halt.chainKey ? { chainKey: halt.chainKey } : {}),
            checkpointBlockNumber: halt.checkpointBlockNumber,
            checkpointBlockHash: halt.checkpointBlockHash,
            detectedAt: halt.detectedAt,
            actionRequired: reorgActionRequired(halt.chainKey),
          },
        });
      }
    }
    if (failedScanAt) {
      return reply.code(503).send({
        status: 'indexer_failing',
        indexer: {
          failedAt: failedScanAt,
          actionRequired: 'a funding indexer has not completed a scan since this failure; deposits are not being credited',
        },
      });
    }
    const [repository, chain] = await Promise.all([
      limitedReadiness(options.repositoryReady),
      limitedReadiness(options.chainReady),
    ]);
    if (!repository || !chain) return reply.code(503).send({ status: 'not-ready' });
    if (!options.reconciliationAlerts) return { status: 'ready' };
    // Open discrepancies alert through the readiness body without failing readiness: the worker
    // still serves webhooks and indexing, but monitoring sees a value to page on. An unreadable
    // count reports 'unavailable' — never zero, which would claim the books were checked clean.
    // A count whose writer is failing, or has never run, is worth exactly as little, so it reports
    // 'unavailable' too rather than a zero the runbook would read as a verified ledger.
    const openDiscrepancies = failedSweep !== undefined || !sweptOnce
      ? 'unavailable' as const
      : await options.reconciliationAlerts.openLedgerDiscrepancyCount()
        .then((count): number | 'unavailable' => count)
        .catch((): 'unavailable' => 'unavailable');
    return {
      status: 'ready',
      reconciliation: {
        openDiscrepancies,
        ...(failedSweep ? { sweepFailedAt: failedSweep.at, sweepUnverified: failedSweep.reason } : {}),
      },
    };
  });
  app.post('/v1/webhooks/stripe', async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || !signature) {
      return reply.code(400).send({ type: 'invalid-stripe-signature', title: 'Stripe signature is required', status: 400 });
    }
    try {
      return await options.processor.process(rawBodyOf(request), signature);
    } catch (error) {
      if (error instanceof TenantStripeWebhookVerificationError) {
        return reply.code(400).send({
          type: 'invalid-stripe-signature', title: 'Stripe signature verification failed', status: 400,
        });
      }
      if (error instanceof TenantStripeEventError) {
        return reply.code(400).send({ type: 'invalid-stripe-event', title: 'Stripe event is invalid', status: 400 });
      }
      return reply.code(503).send({
        type: 'stripe-processing-unavailable', title: 'Stripe event processing is temporarily unavailable', status: 503,
      });
    }
  });
  options.indexer.start(options.scanPollMs, (error) => {
    // A reorg halts crediting until an operator reconciles the window, which is a different
    // response from a database or RPC blip. Emitting the same anonymous line for all three left
    // the only signal for a financial incident indistinguishable from a transient failure.
    const reorg = error instanceof TenantBaseReorgDetectedError;
    // Latch FIRST, synchronously, before the announcement and before any persistence: from this
    // statement on, /health/ready reports the halt no matter what the database does — and even
    // when durable halt wiring is absent entirely (the sandbox worker still must not keep
    // crediting through a detected reorg).
    if (reorg && !latchedReorg) {
      latchedReorg = { ...error.checkpoint, latchedAt: new Date().toISOString() };
    }
    failedScanAt ??= new Date().toISOString();
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      event: reorg ? 'financial.indexer-reorg-halted' : 'financial.indexer-failed',
      ...(reorg ? { actionRequired: 'reconcile the scan window before indexing resumes' } : {}),
    })}\n`);
    // The stderr line above is an announcement; this is the record. The repository call is
    // idempotent per divergence, so the poll loop re-detecting the same halt cannot multiply it,
    // and it also fail-closes the ledger by marking the divergent window's events reorged. A
    // failed record leaves the latch holding readiness closed, and the poll loop re-detects the
    // same divergence every interval, so the record attempt retries until it lands.
    if (reorg && options.reorgHalts) {
      void options.reorgHalts.recordBaseReorgHalt(error.checkpoint).catch((cause: unknown) => {
        process.stderr.write(`${JSON.stringify({
          level: 'error',
          event: 'financial.indexer-reorg-record-failed',
          ...safeErrorProjection(cause),
        })}\n`);
      });
    }
  }, () => { failedScanAt = undefined; });
  app.addHook('onClose', async () => { await options.indexer.stop(); });
  if (options.reconciliationSweep) {
    options.reconciliationSweep.start(options.reconciliationSweepPollMs!, (error) => {
      failedSweep = { at: failedSweep?.at ?? new Date().toISOString(), reason: 'sweep_failed' };
      process.stderr.write(`${JSON.stringify({
        level: 'error',
        event: 'financial.reconciliation-sweep-failed',
        ...safeErrorProjection(error),
      })}\n`);
    }, (summary) => {
      const unverified = sweepUnverifiedReason(summary);
      if (unverified !== undefined) {
        failedSweep = { at: failedSweep?.at ?? new Date().toISOString(), reason: unverified };
        process.stderr.write(`${JSON.stringify({
          level: 'error',
          event: 'financial.reconciliation-sweep-unverified',
          reason: unverified,
          walletsChecked: summary.walletsChecked,
          walletErrors: summary.walletErrors,
          walletsUnresolved: summary.walletsUnresolved,
          onchainComparison: summary.onchainComparison,
          actionRequired: 'the ledger sweep did not verify the whole fleet this pass; its discrepancy count is not evidence',
        })}\n`);
        return;
      }
      failedSweep = undefined;
      sweptOnce = true;
    });
    app.addHook('onClose', async () => { await options.reconciliationSweep?.stop(); });
  }
  return app;
}
