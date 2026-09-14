/**
 * The public chain domain: the vocabulary, schemas and pure rules the wallet, mandate and
 * settlement code share.
 *
 * Everything here is chain-side. A pet signal reaches this package only as something already
 * decided elsewhere — a confirmed flag, a recorded identifier, a number compared against an
 * owner's threshold — and no module in it produces, defines or explains one.
 */

// Chain identity: networks, addresses, transaction ids, USDC amounts and receive URIs.
export * from './chain.js';

// Shared code vocabularies: species, needs, categories, actors, states and reason codes.
export * from './codes.js';

// Minor-unit money and the quote/product arithmetic the approval gate depends on.
export * from './money.js';

// Wallet holdings, snapshots and receive profiles for the proof-of-concept chain.
export * from './wallet.js';

// Mandate, payment request and audit event schemas.
export * from './schemas.js';

// Mandate and request lifecycle transitions.
export * from './state-machines.js';

// The spending policy engine and the in-memory budget ledger.
export * from './policy.js';

// The autonomy mandate and its evaluation.
export * from './autonomy.js';

// The controlled catalog every purchasable identity is keyed by.
export * from './seed.js';
