/**
 * The narrow public port of the MeowWa application store.
 *
 * The full store lives in the private MeowWa application. It carries a great deal this repository
 * has no business knowing about -- the pet-signal interpretation records, the agent conversation
 * output, the pet memory graph, recorded evidence and live listening sessions -- and none of that
 * is reachable from, or needed by, the wallet and chain modules published here.
 *
 * So this file is not a copy of that store with fields removed. It is a reference implementation
 * of the *contract* the chain code depends on, written from the call sites in
 * `wallet-execution/` and `wallet-control/`: an owner, their pets, one wallet and one spending
 * mandate per pet, the payment requests and receipts those produce, the autonomy mandate the
 * wallet suspends, the support cases and notifications a halted indexer raises, and the append-only
 * audit log every one of those writes to. Nothing else.
 *
 * Two consequences worth stating plainly:
 *
 *  - `AppStore` here is a *structural* type. The private application's store satisfies it, so the
 *    same routes, reconcilers and indexers run against either. Adding a field to this interface is
 *    therefore a real compatibility decision, not a local one.
 *  - Interpretation is an opaque input on this side of the boundary. A `PaymentRequest` carries an
 *    `interpretationId` and a mandate carries a `minimumInterpretationScore` threshold, because
 *    money movement is gated on them -- but how any such score comes to exist is not modelled,
 *    described or derivable here.
 *
 * `createStore()` returns the seeded single-owner sandbox fixture the chain test suites are
 * written against (owner_1, Mochi the cat, Pepper the dog). It is a fixture, not a migration: a
 * real deployment hydrates its own state.
 *
 * Fields present that the chain modules do not read directly, and why:
 *  - `policy.version` -- stamped into every audit event by `appendAudit`.
 *  - `paymentAttempts` -- read by `petHasUnresolvedWalletActivity`, which gates signer recovery.
 *  - `budgets` -- read by `releaseBudget` when revoking a signer cancels pending spending.
 *  - `sequence` / `idDiscriminator` -- the id allocator behind `nextId`.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_CONTRACT,
  BudgetLedger,
  POC_CATALOG,
  UNLIMITED_TRANSACTIONS,
  type AuditEvent,
  type AutonomyMandate,
  type CategoryCode,
  type MandateState,
  type NeedCode,
  type PaymentRequest,
  type SignedMandateProof,
  type Species,
} from '@meowwa/chain-domain';

/**
 * The pet identity the wallet modules need: who owns it, which wallet and agent are bound to it,
 * a display name for owner-facing notifications, its species (mandate scope narrows by it), and
 * whether the owner has put it aside.
 *
 * Archiving is deliberately reversible and deliberately not deletion: the wallet, its balance,
 * every receipt and the durable binding row all survive, and the owner keeps withdrawal and
 * export. What stops is new spending, which is enforced by suspending the agent and mandate
 * rather than by hiding the pet -- a hidden pet is still spendable through a stale tab.
 *
 * The private application's `Pet` carries profile and memory state besides; none of it reaches a
 * chain decision, so none of it is modelled here.
 */
export interface Pet {
  petId: string;
  ownerId: string;
  walletId: string;
  agentId: string;
  name: string;
  species: Species;
  /** When the owner put this pet aside, or null/absent while it is live. */
  archivedAt?: string | null;
}

/**
 * Whether a money figure is worth anything.
 *
 * Two kinds of money coexist in this product and both are denominated in "USDC": valueless test
 * USDC on Base Sepolia (84532) and real USDC on Base mainnet (8453). Until this field existed the
 * only thing separating them on the wire was a display string -- a receipt said `network: 'Base
 * Sepolia'` and a production funding wallet said `network: 'Base'` -- so telling a valueless debit
 * from a real one meant string-matching a chain's marketing name, and the same `walletId` was
 * published twice with two balances that shared the bare symbol "USDC".
 *
 * `funds` is the one key every USDC record the dashboard publishes carries, so a client groups and
 * labels by it and can never sum across it. It is deliberately not the chain id: a chain id still
 * needs a lookup table to answer "is this real", and the answer is what callers need.
 */
export type FundsKind = 'test' | 'real';

export interface Receipt {
  receiptId: string; requestId: string; petId: string; productId?: string; merchantName: string; productName: string;
  amountMinor: number; currency: 'USDC'; funds: FundsKind; network: 'Base Sepolia'; transactionHash: string;
  status: 'completed' | 'refunded' | 'disputed';
  reconciliationStatus: 'reconciled' | 'merchant_pending' | 'reorg_review' | 'authorization_review';
  createdAt: string;
  orderId?: string; refundId?: string; refundStatus?: 'pending' | 'confirmed';
  /**
   * Set when the owner explicitly closed the support case for a receipt that can no longer
   * progress on its own. The debit itself stands; this records that the owner accepted the
   * outcome, which is what releases the wallet-recovery and emergency-clear guards.
   */
  disputeResolvedAt?: string;
  refundTransactionHash?: `0x${string}`;
  refundBlockHash?: `0x${string}`;
  refundBlockNumber?: number;
  refundLogIndex?: number;
}

export interface PetWalletReceiveTransfer {
  transferId: string;
  petId: string;
  walletId: string;
  chainId: 84532;
  contractAddress: string;
  transactionHash: `0x${string}`;
  blockHash: `0x${string}`;
  blockNumber: number;
  logIndex: number;
  confirmedAtBlock: number;
  from: string;
  to: string;
  amountAtomic: string;
  amountMinor: number;
  confirmedAt: string;
  accounting?: 'contribution' | 'refund';
}

export interface Wallet {
  walletId: string; petId: string; balanceMinor: number; address: string; paused: boolean; signerRevoked: boolean;
  pauseReason?: 'owner' | 'signer_revoked' | 'closure';
  /** Sandbox POC wallet metadata. Production funding projections may override the chain. */
  chainId?: 84532;
  receiveToken?: string;
  receiveEnabled?: boolean;
  receiveTransfers?: PetWalletReceiveTransfer[];
  holdings?: Array<{
    chainId: 84532;
    contractAddress: string;
    symbol: string;
    decimals: number;
    balanceAtomic: string;
    spendable: boolean;
    verification: 'CANONICAL_USDC' | 'VIEW_ONLY' | 'UNKNOWN';
  }>;
}

export interface PetAgentIdentity {
  agentId: string; petId: string; ownerId: string; species: Species; status: 'ACTIVE' | 'SUSPENDED';
}

/**
 * One pet's signed spending mandate: what may be bought, from whom, on which chain, up to what
 * limit, and how much of that allowance is already spent or reserved.
 *
 * `allowedNeeds` scopes the mandate to needs the owner approved spending for. The mandate consumes
 * a need code as an opaque label -- it authorizes money against one, it does not decide one.
 */
export interface PetMandate {
  mandateId: string; ownerId: string; petId: string; agentId: string;
  status: MandateState; validFrom: string; validUntil: string; signatureVerified: boolean; nonceValid: boolean;
  allowedNeeds: NeedCode[]; allowedCategories: CategoryCode[];
  allowedMerchantIds: string[]; allowedProductIds: string[]; token: 'USDC'; chainId: 84532;
  recipients: string[]; contracts: string[]; perTransactionLimitMinor: number; periodLimitMinor: number;
  spentMinor: number; reservedMinor: number; maxTransactions: number; transactionCount: number;
  authorization: {
    kind: 'simulated_owner_approval'; approvedBy: string; approvedAt: string; displayedText: string;
    proof?: SignedMandateProof;
  };
}

export interface SupportCase {
  caseId: string;
  requestId?: string;
  status: string;
  summary: string;
  kind?: 'refund_reconciliation' | 'receive_reorg_review';
  /**
   * Explicit provenance stamped at creation: 'owner' for cases the owner opened, 'system' for
   * reconciliation cases the platform pushes. Absent only on cases persisted before this field
   * existed.
   */
  origin?: 'owner' | 'system';
}

export interface Notification {
  notificationId: string;
  type: string;
  message: string;
  read: boolean;
}

/**
 * The outcome of one submitted payment, keyed by request id. `pending` and `unknown` are the two
 * states that mean money may still be in flight, which is what blocks signer recovery.
 */
export type PaymentAttempt =
  | { status: 'confirmed'; transactionHash: string; intentHash: string }
  | { status: 'pending'; submissionId: string; intentHash: string }
  | { status: 'failed'; reason: string; intentHash: string }
  | { status: 'unknown'; reason: string; intentHash: string; submissionId?: string };

/**
 * What the wallet and chain modules require of an application store. The private application's
 * store satisfies this structurally; the in-memory implementation below is the reference one.
 */
export interface AppStore {
  owner: { ownerId: string; name: string; passkeyEnabled: boolean; status: 'ACTIVE' | 'CLOSURE_SCHEDULED'; closureScheduledAt?: string };
  pets: Pet[];
  /** Keyed by petId: one pet, one wallet. */
  wallets: Map<string, Wallet>;
  /** Keyed by petId. */
  agents: Map<string, PetAgentIdentity>;
  /** Keyed by petId. */
  autonomy: Map<string, AutonomyMandate>;
  /** Keyed by petId. */
  mandates: Map<string, PetMandate>;
  /** Keyed by requestId. */
  requests: Map<string, PaymentRequest>;
  /** Keyed by receiptId. */
  receipts: Map<string, Receipt>;
  /** Keyed by requestId. */
  paymentAttempts: Map<string, PaymentAttempt>;
  /** Keyed by petId. Period-allowance reservations held against in-flight requests. */
  budgets: Map<string, BudgetLedger>;
  supportCases: SupportCase[];
  notifications: Notification[];
  /** Dedupe keys already announced, so a repeated condition raises one notification. */
  notificationKeys: Set<string>;
  audit: AuditEvent[];
  /** Only the version stamp is needed here; the owner's full spending policy stays private. */
  policy: { version: string };
  /**
   * Which replica generated the ids in this store. Deliberately not part of any snapshot: it
   * identifies the process, not the state. `sequence` is allocated from the loaded snapshot, so two
   * replicas otherwise reach `nextId` with the same counter and both mint `event_101` for different
   * events -- an identity collision no retry can resolve. Absent for a single-process store, whose
   * ids stay `prefix_n`.
   */
  idDiscriminator?: string;
  sequence: number;
}

/**
 * The seeded owner's approved products. The mandate and the policy are checked independently, so
 * naming the list once keeps a product from being allowed by one gate and refused by the other.
 * Everything here is a `merchant_approved_1` product; adding a product to the catalog does not add
 * it here, because approving a purchase is the owner's act, not a consequence of stocking a shelf.
 */
const SEEDED_ALLOWED_PRODUCT_IDS = [
  'product_usual_food_1', 'product_treat_1', 'product_toy_feather_1', 'product_litter_clumping_1',
  'product_dog_food_adult_1', 'product_dog_food_puppy_1', 'product_dog_treat_dental_1',
  'product_dog_treat_training_1', 'product_dog_chew_durable_1', 'product_dog_puzzle_feeder_1',
  'product_dog_fetch_ball_1', 'product_dog_rope_tug_1', 'product_dog_snuffle_mat_1',
];

/**
 * The owner policy may approve products for the whole household, but a signed mandate authorizes
 * spending for one animal. Handing every pet the full list makes the cat's mandate authorize puppy
 * formula. The mandate is a second, independent gate; it narrows on its own rather than leaning on
 * the request route repeating the species check.
 */
function mandateScopeForSpecies(species: Species, allowedProductIds: readonly string[]) {
  const products = POC_CATALOG.filter((product) =>
    allowedProductIds.includes(product.productId) &&
    (product.species as readonly Species[]).includes(species));
  return {
    allowedProductIds: products.map((product) => product.productId),
    allowedCategories: [...new Set(products.map((product) => product.category))] as CategoryCode[],
  };
}

export function createStore(): AppStore {
  const mochiWallet: Wallet = {
    walletId: 'wallet_mochi', petId: 'pet_mochi', balanceMinor: 4200,
    address: '0x3333333333333333333333333333333333333333', paused: false, signerRevoked: false,
    chainId: BASE_SEPOLIA_CHAIN_ID, receiveToken: newReceiveToken(), receiveEnabled: true, receiveTransfers: [],
    holdings: [{ chainId: BASE_SEPOLIA_CHAIN_ID, contractAddress: BASE_SEPOLIA_USDC_CONTRACT, symbol: 'USDC', decimals: 6, balanceAtomic: '42000000', spendable: true, verification: 'CANONICAL_USDC' }],
  };
  const pepperWallet: Wallet = {
    walletId: 'wallet_pepper', petId: 'pet_pepper', balanceMinor: 4200,
    address: '0x4444444444444444444444444444444444444444', paused: false, signerRevoked: false,
    chainId: BASE_SEPOLIA_CHAIN_ID, receiveToken: newReceiveToken(), receiveEnabled: true, receiveTransfers: [],
    holdings: [{ chainId: BASE_SEPOLIA_CHAIN_ID, contractAddress: BASE_SEPOLIA_USDC_CONTRACT, symbol: 'USDC', decimals: 6, balanceAtomic: '42000000', spendable: true, verification: 'CANONICAL_USDC' }],
  };
  const mandateFor = (petId: string, agentId: string, mandateId: string, species: Species): PetMandate => {
    const scope = mandateScopeForSpecies(species, SEEDED_ALLOWED_PRODUCT_IDS);
    return {
      mandateId, ownerId: 'owner_1', petId, agentId,
      status: 'ACTIVE', validFrom: '2026-07-10T00:00:00.000Z', validUntil: '2027-07-10T00:00:00.000Z',
      signatureVerified: true, nonceValid: true,
      // The two needs this seeded catalog can actually settle with a purchase. The list is an
      // owner-scoped allowlist of labels, not a classifier: a need it does not name is simply
      // unauthorized to spend against, whatever produced that label and however.
      allowedNeeds: ['hunger', 'play_or_enrichment'],
      allowedCategories: scope.allowedCategories,
      allowedMerchantIds: ['merchant_approved_1'],
      allowedProductIds: scope.allowedProductIds,
      token: 'USDC', chainId: BASE_SEPOLIA_CHAIN_ID, recipients: ['0x1111111111111111111111111111111111111111'],
      contracts: [BASE_SEPOLIA_USDC_CONTRACT], perTransactionLimitMinor: 2000,
      periodLimitMinor: 5000, spentMinor: 0, reservedMinor: 0, maxTransactions: UNLIMITED_TRANSACTIONS, transactionCount: 0,
      authorization: {
        kind: 'simulated_owner_approval', approvedBy: 'owner_1', approvedAt: '2026-07-10T00:00:00.000Z',
        displayedText: 'Owner approved up to 50.00 test USDC for recurring pet essentials; every alpha request still requires approval.',
      },
    };
  };
  const mochiAgent: PetAgentIdentity = { agentId: 'agent_mochi', petId: 'pet_mochi', ownerId: 'owner_1', species: 'cat', status: 'ACTIVE' };
  const pepperAgent: PetAgentIdentity = { agentId: 'agent_pepper', petId: 'pet_pepper', ownerId: 'owner_1', species: 'dog', status: 'ACTIVE' };
  const defaultAutonomy = (petId: string, agentId: string, autonomyId: string): AutonomyMandate => ({
    autonomyId, ownerId: 'owner_1', petId, agentId, mode: 'OWNER_APPROVAL',
    allowedNeedCode: 'hunger', allowedMerchantId: 'merchant_approved_1', allowedProductId: 'product_usual_food_1',
    approvedAmountMinor: 1299, perTransactionLimitMinor: 1299, dailyLimitMinor: 1299,
    periodLimitMinor: 3897, periodDays: 30, cooldownMinutes: 1440, maxTransactionsPerPeriod: 3,
    // Owner-set floors the autonomy gate compares an incoming signal against. Thresholds only:
    // what produces a signal quality or an interpretation score is not this repository's concern.
    minimumSignalQuality: 0.5, minimumInterpretationScore: 0.5,
    validFrom: '2026-07-10T00:00:00.000Z', validUntil: '2027-07-10T00:00:00.000Z', policyVersion: 'v1',
    authorization: {
      kind: 'simulated_owner_approval', approvedBy: 'owner_1', approvedAt: '2026-07-10T00:00:00.000Z',
      displayedText: 'Every test-USDC request requires explicit owner approval.',
    },
  });
  const mochiMandate = mandateFor('pet_mochi', mochiAgent.agentId, 'mandate_alpha', 'cat');
  const pepperMandate = mandateFor('pet_pepper', pepperAgent.agentId, 'mandate_pepper', 'dog');
  const mochiAutonomy = defaultAutonomy('pet_mochi', mochiAgent.agentId, 'autonomy_mochi');
  const pepperAutonomy = defaultAutonomy('pet_pepper', pepperAgent.agentId, 'autonomy_pepper');
  return {
    owner: { ownerId: 'owner_1', name: 'Alex', passkeyEnabled: true, status: 'ACTIVE' },
    pets: [
      { petId: 'pet_mochi', ownerId: 'owner_1', walletId: 'wallet_mochi', agentId: mochiAgent.agentId, name: 'Mochi', species: 'cat' },
      { petId: 'pet_pepper', ownerId: 'owner_1', walletId: 'wallet_pepper', agentId: pepperAgent.agentId, name: 'Pepper', species: 'dog' },
    ],
    wallets: new Map([[mochiWallet.petId, mochiWallet], [pepperWallet.petId, pepperWallet]]),
    agents: new Map([[mochiAgent.petId, mochiAgent], [pepperAgent.petId, pepperAgent]]),
    autonomy: new Map([[mochiAutonomy.petId, mochiAutonomy], [pepperAutonomy.petId, pepperAutonomy]]),
    mandates: new Map([[mochiMandate.petId, mochiMandate], [pepperMandate.petId, pepperMandate]]),
    requests: new Map(),
    receipts: new Map(),
    paymentAttempts: new Map(),
    budgets: new Map([['pet_mochi', new BudgetLedger()], ['pet_pepper', new BudgetLedger()]]),
    supportCases: [],
    notifications: [],
    notificationKeys: new Set(),
    audit: [],
    policy: { version: 'v1' },
    sequence: 100,
  };
}

export function nextId(store: AppStore, prefix: string): string {
  store.sequence += 1;
  // The discriminator sits before the counter so the trailing number stays the ordinal: the macOS
  // shell orders remembered notification ids by it.
  return store.idDiscriminator
    ? `${prefix}_${store.idDiscriminator}_${store.sequence}`
    : `${prefix}_${store.sequence}`;
}

/**
 * Wallet accounting is in whole cents; USDC is six decimals. One cent is therefore 10,000 atomic
 * units, and this is the only place that conversion is written down.
 */
export function pocUsdcAtomicBalance(balanceMinor: number): string {
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0) {
    throw new RangeError('Pet wallet balance must be a non-negative safe integer');
  }
  return (BigInt(balanceMinor) * 10_000n).toString();
}

/**
 * The bearer credential for the unauthenticated receive page. It is random because it is the only
 * thing standing in front of that page.
 *
 * It used to be an unkeyed SHA-256 of (ownerId, petId) -- two identifiers the dashboard hands every
 * household member, including the view-only, caregiver and support roles that same projection
 * deliberately denies all wallet data. Any of them could derive the link offline for any pet in the
 * household, in or out of their granted scope, and the derived URL then resolved with no credential
 * at all, exposing the pet's on-chain address and with it the balance and transaction history the
 * page claims to hide. Revocation did not help either: the same two inputs re-derived it forever.
 */
export function newReceiveToken(): string {
  return `receive_${randomBytes(16).toString('hex')}`;
}

/**
 * Replaces a token still holding one of the two derived values, so links published before that
 * change stop resolving instead of staying guessable forever. It mints nothing on its own: the
 * projections that call it are reads, and a wallet with no link must not acquire one by being
 * looked at.
 */
export function retireDerivedReceiveToken(wallet: Wallet, ownerSubject: string): void {
  const derived = [`meowwa:receive:v1:${wallet.petId}`, `meowwa:receive:v2:${ownerSubject}\0${wallet.petId}`]
    .some((material) => wallet.receiveToken === `receive_${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}`);
  if (derived) wallet.receiveToken = newReceiveToken();
}

/**
 * Restates the wallet's cent balance as its canonical USDC holding. Callers credit or debit
 * `balanceMinor` and then call this, so the published atomic figure can never drift from the
 * ledger it is derived from.
 */
export function syncPocUsdcHolding(wallet: Wallet): void {
  const balanceAtomic = pocUsdcAtomicBalance(wallet.balanceMinor);
  const holding = wallet.holdings?.find((item) => item.symbol === 'USDC' && item.spendable);
  if (holding) holding.balanceAtomic = balanceAtomic;
  else wallet.holdings = [{
    chainId: BASE_SEPOLIA_CHAIN_ID, contractAddress: BASE_SEPOLIA_USDC_CONTRACT, symbol: 'USDC', decimals: 6,
    balanceAtomic, spendable: true, verification: 'CANONICAL_USDC',
  }, ...(wallet.holdings ?? [])];
}

export function mandateForPet(store: AppStore, petId: string): PetMandate | undefined {
  return store.mandates.get(petId);
}

export function budgetForPet(store: AppStore, petId: string): BudgetLedger | undefined {
  return store.budgets.get(petId);
}

export function petHasUnresolvedFinancialState(store: AppStore, petId: string): boolean {
  return [...store.receipts.values()].some((receipt) => {
    const paymentRequest = store.requests.get(receipt.requestId);
    return paymentRequest?.petId === petId && receipt.disputeResolvedAt === undefined &&
      (receipt.reconciliationStatus !== 'reconciled' || receipt.status === 'disputed');
  }) || [...store.paymentAttempts.entries()].some(([requestId, attempt]) =>
    store.requests.get(requestId)?.petId === petId && (attempt.status === 'pending' || attempt.status === 'unknown'));
}

/**
 * The guard on restoring agent access to a wallet. It keeps its own name and its own in-flight
 * check rather than delegating outright, so narrowing the financial-state predicate for some other
 * caller can never quietly widen what recovery will step over.
 */
export function petHasUnresolvedWalletActivity(store: AppStore, petId: string): boolean {
  return petHasUnresolvedFinancialState(store, petId) || [...store.paymentAttempts.entries()].some(([requestId, attempt]) =>
    store.requests.get(requestId)?.petId === petId && (attempt.status === 'pending' || attempt.status === 'unknown'));
}

/**
 * Releases the period allowance a request was holding and mirrors the remainder onto the mandate.
 * Called when pending spending is cancelled -- a revoked signer, an expired quote, an owner
 * rejection -- so an abandoned request cannot exhaust the allowance permanently.
 */
export function releaseBudget(store: AppStore, petId: string, requestId: string): number {
  const mandate = mandateForPet(store, petId);
  const budget = budgetForPet(store, petId);
  if (!mandate || !budget) return 0;
  const before = budget.reservedMinor;
  const reservedMinor = budget.release(requestId);
  mandate.reservedMinor = reservedMinor;
  if (reservedMinor < before) {
    appendAudit(store, {
      eventType: 'BUDGET_RELEASED', aggregateId: requestId, actorType: 'system', actorId: 'financial_harness',
      summary: 'Period allowance reservation released',
      metadata: { petId, releasedMinor: before - reservedMinor, reservedMinor },
    });
  }
  return reservedMinor;
}

/**
 * A notification id, scoped to the owner it belongs to.
 *
 * Every other id class here is deliberately store-local. Notifications are the one class handed to
 * a client that keys a permanent, per-device set on them: the macOS shell remembers every delivered
 * id in UserDefaults forever, never clears it between owners, and reuses it as the notification
 * request identifier. So the second owner to sign into a Mac had every banner whose ordinal the
 * first owner had already used dropped in silence -- APPROVAL_REQUESTED included, which is the
 * control surface for spending money. The owner subject is hashed rather than embedded: it is a
 * provider DID, it would not survive the shell's identifier grammar, and it must not end up on disk
 * in the client's defaults. The counter stays last so the id still ends in its ordinal, which is
 * what the shell prunes its remembered set by.
 */
export function nextNotificationId(store: AppStore): string {
  const owner = store.owner.ownerId;
  return nextId(store, owner ? `notification_${createHash('sha256').update(owner).digest('hex').slice(0, 8)}` : 'notification');
}

export function appendNotification(store: AppStore, input: { type: string; message: string; dedupeKey: string }): Notification | undefined {
  if (store.notificationKeys.has(input.dedupeKey)) {
    return store.notifications.find((item) => item.type === input.type);
  }
  store.notificationKeys.add(input.dedupeKey);
  const notification: Notification = { notificationId: nextNotificationId(store), type: input.type, message: input.message, read: false };
  store.notifications.push(notification);
  return notification;
}

/**
 * Drops a pet out of autonomous spending and back to owner approval. Only a live
 * `LIMITED_AUTONOMY` mandate is suspended: a mandate already suspended or revoked must not have its
 * audit trail rewritten, and an owner-approval mandate has nothing to take away.
 */
export function suspendAutonomy(store: AppStore, petId: string, reason: string): AutonomyMandate | undefined {
  const autonomy = store.autonomy.get(petId);
  if (!autonomy || autonomy.mode !== 'LIMITED_AUTONOMY') return autonomy;
  autonomy.mode = 'SUSPENDED';
  appendAudit(store, {
    eventType: 'AUTONOMY_SUSPENDED', aggregateId: autonomy.autonomyId, actorType: 'system', actorId: 'autonomy_harness',
    summary: `Pet-agent autonomy suspended: ${reason}`, metadata: { petId, reason },
  });
  appendNotification(store, {
    type: 'AUTONOMY_SUSPENDED', message: `Pet-agent autonomy was suspended for owner review: ${reason}.`,
    dedupeKey: `autonomy-suspended:${autonomy.autonomyId}:${reason}`,
  });
  return autonomy;
}

/**
 * The append-only record. Every state change a wallet, mandate or chain reconciliation makes goes
 * through here, stamped with the policy version in force when it happened.
 */
export function appendAudit(store: AppStore, input: {
  eventType: string; aggregateId: string; actorType: AuditEvent['actorType']; actorId: string; summary: string;
  metadata?: Record<string, string | number | boolean | null>;
}): AuditEvent {
  const event: AuditEvent = {
    eventId: nextId(store, 'event'), eventType: input.eventType, aggregateId: input.aggregateId,
    actorType: input.actorType, actorId: input.actorId, occurredAt: new Date().toISOString(),
    versions: { policy: store.policy.version, taxonomy: 'v1', schema: 'v1' }, summary: input.summary,
    metadata: input.metadata ?? {},
  };
  store.audit.push(event);
  return event;
}

/** Looks up a pet's wallet. The rails treat the pet id as the wallet's key. */
export function walletForPet(store: AppStore, petId: string): Wallet | undefined {
  return store.wallets.get(petId);
}

/**
 * Validates a client-supplied `Idempotency-Key`. `undefined` means the header was absent, which is
 * allowed; `null` means it was present and unusable, which is a 400. The bounds are what a replay
 * guard needs -- long enough to be unique, short enough not to be a payload.
 */
export function parseIdempotencyKey(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 200 || raw.trim() !== raw) return null;
  return raw;
}
