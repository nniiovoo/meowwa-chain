import type { ChainDescriptor, EvmChainDescriptor, SolanaChainDescriptor } from '@meowwa/chain-domain';
import { confirmedHead } from '../chain/usdc-transfer-reader.js';
import { isFundingChainKey, type FundingChainKey } from '../funding/types.js';
import type { TenantLedgerReconciliation } from './financial-repository.js';

/**
 * The scheduled fleet reconciliation sweep, one instance per funding rail.
 *
 * Reconciliation used to exist only as an on-demand endpoint: nothing walked the fleet, nothing
 * remembered a mismatch, and nothing compared against a source outside this database. The sweep
 * runs two independent checks per wallet on every pass:
 *
 * 1. Internal identity — ledger === canonical chain net + reorged credits − reorged debits.
 *    Every sum is computed separately from the tables the application writes, so a divergence
 *    between what was recorded and what should have been recorded surfaces as data.
 * 2. On-chain comparison — the wallet's actual USDC balance on its chain against the indexed
 *    canonical net, both bounded to the same height. This is the only check whose truth source
 *    is outside the database entirely. Bounding both sides to one height is what makes the
 *    comparison exact instead of turning ordinary indexer lag into false discrepancies. How the
 *    height is chosen depends on what the chain can answer:
 *    - An EVM chain answers a balance at any past block, so the height is the highest block BOTH
 *      sides cover: at or below the confirmed head, and at or below the last block the indexer
 *      has finished.
 *    - Solana answers only the finalized state, stamped with the slot it is the state of, and the
 *      cursor can never be ahead of finalized. So a balance read this pass is kept as a sample and
 *      compared on a LATER pass, once the cursor has finished its slot. The comparison is exactly
 *      as exact — finalized state never changes, and the indexed net at that slot is complete once
 *      the cursor is past it — it just lands one interval later. A pass that could only sample
 *      reports `skipped_indexer_lag`, because it verified nothing yet.
 *
 * A mismatch is recorded durably (deduplicated per open wallet+kind by the repository) and
 * announced on stderr; readiness carries the open count so monitoring can alert. The sweep
 * never mutates financial state — observing and appending are its only powers.
 *
 * Every wallet the sweep fails to verify is counted, whichever way it failed: thrown into
 * `walletErrors`, dropped by an unresolvable tenant/binding into `walletsUnresolved`, and a
 * whole-pass skip of the external comparison into `onchainComparison`. The readiness gate reads
 * all three, because a skip is not a pass and a count from a pass that checked nothing is not
 * evidence that the books are clean.
 */

export interface LedgerSweepRepository {
  listActiveWalletAddressesPage(chainKey: FundingChainKey, afterAddress: string | null, limit: number): Promise<string[]>;
  resolveWalletTenant(chainKey: FundingChainKey, walletAddress: string): Promise<string | undefined>;
  getWalletForWorker(tenantId: string, chainKey: FundingChainKey, walletAddress: string): Promise<{ walletId: string } | undefined>;
  reconcileWalletLedger(tenantId: string, walletId: string, chainKey: FundingChainKey): Promise<TenantLedgerReconciliation>;
  canonicalChainNetAtBlock(tenantId: string, walletId: string, blockNumber: number, chainKey: FundingChainKey): Promise<string>;
  getChainScanCursor(input: { chainKey: FundingChainKey; contractAddress: string; scanStartBlock: number }): Promise<{ nextBlock: number }>;
  recordLedgerDiscrepancy(input: {
    tenantId: string; walletId: string; chainKey: FundingChainKey; kind: 'internal_mismatch' | 'onchain_mismatch';
    ledgerAtomic: string; canonicalChainAtomic: string; reorgedCreditAtomic: string;
    reorgedDebitAtomic: string; inFlightWithdrawalAtomic: string;
    chainBalanceAtomic?: string; comparisonBlockNumber?: number;
  }): Promise<{ recorded: boolean }>;
  /** The open halt on THIS rail; a halt on another chain says nothing about this one's coverage. */
  unresolvedChainHalt(chainKey: FundingChainKey): Promise<unknown | undefined>;
}

/**
 * How far behind the head the comparison height may sit and still be evidence about the books
 * as they stand NOW, per family. On an EVM chain it is one indexer scan batch (the indexer scans
 * at most 1999 blocks per pass): a healthy indexer trails the head only by its poll interval — a
 * handful of Base blocks at ~2s each — so it is always well inside this, while a stalled or
 * restarting cursor falls outside it and the pass stops counting as a verification until it
 * catches back up. Solana produces a slot every ~400ms, so the same wall-clock allowance is three
 * times as many slots; a Solana comparison is normally one sweep interval old (a sample taken last
 * pass), which at the default five minutes is ~750 slots.
 */
const MAX_COMPARISON_LAG: Record<ChainDescriptor['family'], number> = { evm: 2_000, solana: 6_000 };

/** An EVM chain can pin a balance to a past block, so the sweep asks for exactly its comparison height. */
export interface EvmLedgerSweepReader {
  latestBlockNumber(): Promise<bigint>;
  balanceAtomicAt(address: string, blockNumber: bigint): Promise<bigint>;
}

/** Solana answers only finalized state; the slot it is the state of comes back with the balance. */
export interface SolanaLedgerSweepReader {
  /** The latest finalized slot. */
  latestBlockNumber(): Promise<bigint>;
  balanceAtomicFinalized(owner: string): Promise<{ amountAtomic: bigint; slot: number }>;
}

export type LedgerSweepChainReader = EvmLedgerSweepReader | SolanaLedgerSweepReader;

export interface LedgerSweepSummary {
  chainKey: FundingChainKey;
  walletsChecked: number;
  walletErrors: number;
  /** Listed as active, but no tenant/binding resolved: never checked, and never an error. */
  walletsUnresolved: number;
  internalMismatches: number;
  onchainMismatches: number;
  discrepanciesRecorded: number;
  /**
   * `ran_stale` means the comparison was exact but about a height far behind the head: real, and
   * still worth recording, but not evidence about the books as they stand now.
   */
  onchainComparison: 'ran' | 'ran_stale' | 'skipped_indexer_lag' | 'skipped_no_confirmed_head' | 'skipped_reorg_halt';
  /**
   * The height the comparison was bounded to: the one block of an EVM pass, or on Solana the
   * lowest slot any wallet was compared at this pass (every compared wallet is verified through
   * at least this slot).
   */
  comparisonBlockNumber?: number;
}

type FundingEvmChain = EvmChainDescriptor & { key: FundingChainKey };
type FundingSolanaChain = SolanaChainDescriptor & { key: FundingChainKey };

type Rail =
  | { family: 'evm'; chain: FundingEvmChain; reader: EvmLedgerSweepReader }
  | { family: 'solana'; chain: FundingSolanaChain; reader: SolanaLedgerSweepReader };

interface SolanaBalanceSample { amountAtomic: bigint; slot: number }

/** Verdict order for a Solana pass: one wallet that could not be compared outranks one compared stale. */
const COMPARISON_RANK: Record<LedgerSweepSummary['onchainComparison'], number> = {
  ran: 0, ran_stale: 1, skipped_indexer_lag: 2, skipped_no_confirmed_head: 3, skipped_reorg_halt: 3,
};

function worse(
  current: LedgerSweepSummary['onchainComparison'],
  next: LedgerSweepSummary['onchainComparison'],
): LedgerSweepSummary['onchainComparison'] {
  return COMPARISON_RANK[next] > COMPARISON_RANK[current] ? next : current;
}

export class TenantLedgerReconciliationSweep {
  readonly #repository: LedgerSweepRepository;
  readonly #rail: Rail;
  readonly #confirmations: number;
  readonly #scanStartBlock: number;
  readonly #pageSize: number;
  /**
   * Solana only: the finalized balance each wallet was last read at, waiting for the cursor to
   * finish that slot. Kept in memory on purpose — a sample is a fact about the chain that can be
   * re-read for free, not financial state worth persisting; losing it on restart costs one pass.
   */
  #samples = new Map<string, SolanaBalanceSample>();

  constructor(options: {
    repository: LedgerSweepRepository;
    /** The funding rail this sweep walks; its key names the cursor, the wallet set and the discrepancy rows. */
    chain: ChainDescriptor;
    reader: LedgerSweepChainReader;
    /** Confirmation depth below the head on an EVM chain; Solana reads finalized state and ignores it. */
    confirmations: number;
    scanStartBlock: number;
    pageSize?: number;
  }) {
    if (!Number.isSafeInteger(options.confirmations) || options.confirmations < 1 ||
      !Number.isSafeInteger(options.scanStartBlock) || options.scanStartBlock < 0 ||
      !isFundingChainKey(options.chain.key)) {
      throw new Error('Ledger reconciliation sweep configuration is invalid');
    }
    const pageSize = options.pageSize ?? 500;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
      throw new Error('Ledger reconciliation sweep page size is invalid');
    }
    this.#rail = railOf(options.chain, options.reader);
    this.#repository = options.repository;
    this.#confirmations = options.confirmations;
    this.#scanStartBlock = options.scanStartBlock;
    this.#pageSize = pageSize;
  }

  get chain(): ChainDescriptor { return this.#rail.chain; }

  async sweepOnce(): Promise<LedgerSweepSummary> {
    const rail = this.#rail;
    const chainKey = rail.chain.key;
    const latest = await rail.reader.latestBlockNumber();
    // An EVM head is the latest block minus the confirmation depth. Solana's reader answers at
    // finalized commitment, below which nothing can change, so the finalized slot IS the head.
    const head = rail.family === 'evm' ? confirmedHead(latest, this.#confirmations) : latest;
    const cursor = await this.#repository.getChainScanCursor({
      chainKey, contractAddress: rail.chain.usdc.asset, scanStartBlock: this.#scanStartBlock,
    });
    // During a reorg halt the flip has invalidated indexed coverage below the cursor, so the
    // cursor gate's "indexed through the comparison height" claim is false: comparing would
    // durably record discrepancy rows that are artifacts of the halt machinery. The internal
    // identity keeps running — the netted terms hold through a correctly handled reorg. A
    // failing halt read is treated as halted: unknown halt state is halt state here too. The
    // gate is scoped to this rail: a halt flips only its own chain's events, so a Base halt says
    // nothing about Solana coverage and must not pause the Solana comparison (or vice versa).
    let reorgHalted: boolean;
    try {
      reorgHalted = await this.#repository.unresolvedChainHalt(chainKey) !== undefined;
    } catch {
      reorgHalted = true;
    }
    const confirmed = head !== undefined && head <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(head) : undefined;
    const indexedThrough = cursor.nextBlock - 1;
    // The comparison height is the highest block both sides cover. Demanding the cursor be PAST
    // the confirmed head made ordinary lag skip the check: the indexer only advances to the
    // confirmed head as of its own last scan, and a chain mints a block every couple of seconds,
    // so on a perfectly healthy fleet the cursor is behind `head` on essentially every pass and
    // the only out-of-database check never ran at all. Comparing at the indexed height is exactly
    // as exact — both sums are bounded to the same block — and it actually happens. On Solana the
    // height is per sample (see the class comment); the pass-level gate below only asks whether
    // any comparison is possible at all.
    const comparisonBlock = confirmed === undefined ? undefined : Math.min(confirmed, indexedThrough);
    const comparisonRuns = !reorgHalted && confirmed !== undefined &&
      comparisonBlock !== undefined && comparisonBlock >= this.#scanStartBlock;
    const onchainComparison: LedgerSweepSummary['onchainComparison'] = reorgHalted
      ? 'skipped_reorg_halt'
      : comparisonBlock === undefined
        ? 'skipped_no_confirmed_head'
        : !comparisonRuns
          ? 'skipped_indexer_lag'
          : rail.family === 'evm' && confirmed - comparisonBlock > MAX_COMPARISON_LAG.evm
            ? 'ran_stale'
            : 'ran';

    const summary: LedgerSweepSummary = {
      chainKey,
      walletsChecked: 0, walletErrors: 0, walletsUnresolved: 0,
      internalMismatches: 0, onchainMismatches: 0, discrepanciesRecorded: 0,
      onchainComparison,
      ...(rail.family === 'evm' && comparisonRuns && comparisonBlock !== undefined
        ? { comparisonBlockNumber: comparisonBlock }
        : {}),
    };
    // Solana pass state: the samples the next pass will compare, and the lowest slot compared now.
    const nextSamples = new Map<string, SolanaBalanceSample>();
    let comparedThrough: number | undefined;

    let afterAddress: string | null = null;
    for (;;) {
      const page = await this.#repository.listActiveWalletAddressesPage(chainKey, afterAddress, this.#pageSize);
      if (page.length === 0) break;
      for (const address of page) {
        // One wallet's transient failure (an RPC blip, a serialization conflict) must not
        // abort the fleet: an unisolated loop restarted from the first address every pass and
        // systematically starved the tail of the address order.
        try {
          const tenantId = await this.#repository.resolveWalletTenant(chainKey, address);
          const wallet = tenantId ? await this.#repository.getWalletForWorker(tenantId, chainKey, address) : undefined;
          if (!tenantId || !wallet) {
            // Listed as active but unresolvable. Returning undefined rather than raising made this
            // the quietest way for the check to die: a broken resolution skipped 999 of 1000
            // wallets without producing one error, and the pass still reported itself verified.
            summary.walletsUnresolved += 1;
            continue;
          }
          summary.walletsChecked += 1;

          const internal = await this.#repository.reconcileWalletLedger(tenantId, wallet.walletId, chainKey);
          if (!internal.consistent) {
            summary.internalMismatches += 1;
            const { recorded } = await this.#repository.recordLedgerDiscrepancy({
              tenantId, walletId: wallet.walletId, chainKey, kind: 'internal_mismatch',
              ledgerAtomic: internal.ledgerAtomic,
              canonicalChainAtomic: internal.canonicalChainAtomic,
              reorgedCreditAtomic: internal.reorgedCreditAtomic,
              reorgedDebitAtomic: internal.reorgedDebitAtomic,
              inFlightWithdrawalAtomic: internal.inFlightWithdrawalAtomic,
            });
            if (recorded) summary.discrepanciesRecorded += 1;
            this.#announce('internal_mismatch');
          }

          if (!comparisonRuns || comparisonBlock === undefined) continue;
          const subject = { tenantId, walletId: wallet.walletId };
          if (rail.family === 'evm') {
            const [indexedNet, onchainBalance] = await Promise.all([
              this.#repository.canonicalChainNetAtBlock(tenantId, wallet.walletId, comparisonBlock, chainKey),
              rail.reader.balanceAtomicAt(address, BigInt(comparisonBlock)),
            ]);
            await this.#compare(summary, subject, internal, indexedNet, onchainBalance, comparisonBlock);
            continue;
          }
          // Solana: compare last pass's sample once the cursor has finished its slot, keep it
          // while the cursor is still behind it, and take the sample the next pass will compare.
          const pending = this.#samples.get(address);
          if (pending !== undefined && pending.slot >= this.#scanStartBlock && pending.slot <= indexedThrough) {
            const indexedNet = await this.#repository.canonicalChainNetAtBlock(tenantId, wallet.walletId, pending.slot, chainKey);
            await this.#compare(summary, subject, internal, indexedNet, pending.amountAtomic, pending.slot);
            comparedThrough = comparedThrough === undefined ? pending.slot : Math.min(comparedThrough, pending.slot);
            if (confirmed - pending.slot > MAX_COMPARISON_LAG.solana) summary.onchainComparison = worse(summary.onchainComparison, 'ran_stale');
            nextSamples.set(address, await rail.reader.balanceAtomicFinalized(address));
          } else if (pending !== undefined && pending.slot > indexedThrough) {
            // The indexer has not finished this slot yet: holding the sample, rather than taking
            // a fresh (and even later) one, is what lets a cursor that is behind catch up to it.
            nextSamples.set(address, pending);
            summary.onchainComparison = worse(summary.onchainComparison, 'skipped_indexer_lag');
          } else {
            // No sample yet: the first pass, a wallet new to the fleet, or a sample from below the
            // scan start that the cursor will never cover. Nothing was verified for it this pass.
            nextSamples.set(address, await rail.reader.balanceAtomicFinalized(address));
            summary.onchainComparison = worse(summary.onchainComparison, 'skipped_indexer_lag');
          }
        } catch {
          summary.walletErrors += 1;
        }
      }
      const lastAddress = page[page.length - 1];
      if (lastAddress === undefined || page.length < this.#pageSize) break;
      afterAddress = lastAddress;
    }
    if (rail.family === 'solana') {
      // Wallets that left the fleet drop out with their samples; a pass that could not compare
      // (halt, nothing indexed) starts over, because its samples' coverage claim is void anyway.
      this.#samples = comparisonRuns ? nextSamples : new Map();
      if (comparedThrough !== undefined) summary.comparisonBlockNumber = comparedThrough;
    }
    // "Verified clean" and "could not verify" must be distinguishable to monitoring, so every
    // way this pass failed to verify a wallet — thrown, dropped, or skipped — travels with the
    // summary to whoever publishes the health signal.
    return summary;
  }

  async #compare(
    summary: LedgerSweepSummary,
    subject: { tenantId: string; walletId: string },
    internal: TenantLedgerReconciliation,
    indexedNet: string,
    onchainBalance: bigint,
    comparisonBlock: number,
  ): Promise<void> {
    if (BigInt(indexedNet) === onchainBalance) return;
    summary.onchainMismatches += 1;
    const { recorded } = await this.#repository.recordLedgerDiscrepancy({
      tenantId: subject.tenantId, walletId: subject.walletId, chainKey: this.#rail.chain.key, kind: 'onchain_mismatch',
      ledgerAtomic: internal.ledgerAtomic,
      canonicalChainAtomic: indexedNet,
      reorgedCreditAtomic: internal.reorgedCreditAtomic,
      reorgedDebitAtomic: internal.reorgedDebitAtomic,
      inFlightWithdrawalAtomic: internal.inFlightWithdrawalAtomic,
      chainBalanceAtomic: onchainBalance.toString(),
      comparisonBlockNumber: comparisonBlock,
    });
    if (recorded) summary.discrepanciesRecorded += 1;
    this.#announce('onchain_mismatch');
  }

  #announce(kind: string): void {
    // Redacted by design, like every worker event: the durable record carries the details.
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      event: 'financial.ledger-discrepancy',
      chain: this.#rail.chain.key,
      kind,
      actionRequired: 'follow docs/runbooks/LEDGER_DISCREPANCY.md',
    })}\n`);
  }
}

/** A reader of the wrong family would fail every wallet on every pass; refuse it at wiring time instead. */
function railOf(chain: ChainDescriptor, reader: LedgerSweepChainReader): Rail {
  if (typeof reader.latestBlockNumber !== 'function') throw new Error('Ledger reconciliation sweep configuration is invalid');
  if (chain.family === 'evm') {
    if (!('balanceAtomicAt' in reader) || typeof reader.balanceAtomicAt !== 'function') {
      throw new Error('Ledger reconciliation sweep configuration is invalid');
    }
    return { family: 'evm', chain: chain as FundingEvmChain, reader };
  }
  if (!('balanceAtomicFinalized' in reader) || typeof reader.balanceAtomicFinalized !== 'function') {
    throw new Error('Ledger reconciliation sweep configuration is invalid');
  }
  return { family: 'solana', chain: chain as FundingSolanaChain, reader };
}

/** Interval driver, mirroring the indexer's interval worker: single-flight, bounded interval,
 * immediate first run, errors funneled to the caller's onError. */
export class TenantLedgerReconciliationWorker {
  readonly #sweep: TenantLedgerReconciliationSweep;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active: Promise<unknown> | undefined;

  constructor(sweep: TenantLedgerReconciliationSweep) {
    this.#sweep = sweep;
  }

  async runOnce(): Promise<LedgerSweepSummary | undefined> {
    if (this.#active) return undefined;
    const operation = this.#sweep.sweepOnce();
    this.#active = operation;
    try { return await operation; } finally { this.#active = undefined; }
  }

  start(
    pollMs: number,
    onError: (error: unknown) => void = () => undefined,
    onSweep: (summary: LedgerSweepSummary) => void = () => undefined,
  ): void {
    if (!Number.isSafeInteger(pollMs) || pollMs < 60_000 || pollMs > 86_400_000) {
      throw new Error('Ledger reconciliation poll interval is invalid');
    }
    if (this.#timer) return;
    // Same shape as the indexer's onScan, except that a sweep resolving is NOT by itself evidence
    // that the discrepancy table's writer is alive: per-wallet failures are isolated above and only
    // counted. The summary goes to the caller so the health signal can tell a pass that verified
    // wallets from one that verified none, and refuse to publish a clean count for the latter.
    const run = () => { void this.runOnce().then((summary) => { if (summary !== undefined) onSweep(summary); }, onError); };
    run();
    this.#timer = setInterval(run, pollMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    try { await this.#active; } catch { /* A scheduled invocation is reported through the start callback. */ }
  }
}
