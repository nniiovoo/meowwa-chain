# meowwa-chain

This repository is the owner-controlled agentic wallet core behind MeowWa. MeowWa is an AI
pet-care agent: it reads a pet's signals, proposes a concrete purchase, and spends USDC on the
owner's behalf under a deterministic, owner-approved policy that the agent itself cannot change.

Published here is the money-movement and safety-gate half of that system — multi-chain
descriptors, Privy-backed wallet provisioning and control policy, USDC transfer and balance
readers, funding rails on Base and Solana, per-rail indexing and ledger reconciliation, merchant
reconciliation, onramp funding, immutable purchase intents, and the deterministic policy gate that
decides whether a proposed payment may proceed at all.

## What is not here

Pet-signal interpretation is not in this repository. It runs as a separate closed service behind a
documented gateway. This code consumes its result as an opaque input on a purchase request — a
boolean confirmation and a numeric score compared against a threshold — and nothing here
produces, defines, or explains how that result is computed.

The split is deliberate. Interpretation is the part of MeowWa that is not commodity; the wallet
and the safety gate are the part that is worth reading, auditing and arguing with in public.
Keeping them apart also enforces the property the rest of the design rests on: the component that
forms an opinion about an animal and the component that can move money are separate processes
with a narrow contract between them. A model may propose a payment. It can never authorize one.

## Architecture

### Chain descriptors

One descriptor per supported network — Base and Base Sepolia, Solana and Solana devnet — carrying
the CAIP-2 identifier, the chain name and wallet type the signing provider expects, the address
shape, and the canonical USDC asset: the ERC-20 contract on an EVM chain, the SPL mint on Solana.
Every rail resolves a descriptor instead of restating a chain id or token address for itself, and
address and transaction-id validation is keyed on the descriptor's family, so a Solana address is
never checked against an EVM pattern. Adding a network is adding a descriptor.

The registry also splits the two roles a network plays: `base` and `solana` are production funding
rails, `base_sepolia` and `solana_devnet` are the control-plane networks a pet wallet is
provisioned and attested on. Each funding rail maps to exactly one control chain and back.

### Funding rails

A deployment names the production rails it funds (`MEOWWA_FUNDING_CHAINS`); absent that, only Base
is reachable. Rail-scoped request bodies carry an optional `chain`, and a request naming a rail the
deployment did not enable is refused with `chain-not-enabled` rather than served on another one.
The chain id and token a withdrawal names come from the registry entry for an enabled rail, so a
withdrawal cannot name a chain the indexer does not watch.

Fiat funding uses the Stripe Crypto Onramp, whose `destination_network` is the rail's own name. The
destination is locked server-side to the pet's verified wallet address and client-supplied
destinations are rejected. Only production rails have an onramp network, so a test-network funding
attempt fails rather than silently resolving. A ledger credit is committed from a finalized
on-chain transfer, never from a browser redirect or an unverified callback; signed provider events,
provider event ids and chain log identities are all durable and idempotent.

Idempotency keys and step-up intent hashes were extended rather than reissued: a Base request
hashes the same bytes it did before Solana existed, so credentials and funding keys already in
flight keep verifying, and a Solana request under a reused key conflicts instead of resuming a Base
one.

Withdrawals are owner-signed. The server prepares an intent against a registered destination on one
rail, holds a reservation against the wallet's withdrawable balance, and every withdrawal status
names the code path that releases that reservation. The debit becomes final when the rail's indexer
observes the outflow, not when a client reports it.

### Wallet control

Each pet wallet is an owner-controlled embedded wallet provisioned through Privy. The server does
not hold an unrestricted key and cannot widen its own authority. A separate transfer-policy
evaluator decides whether a proposed agent transfer is inside the configured signer policy: chain,
asset, recipient, amount bounds, and the shape of the call itself. The policy builds for either
family — an EVM action is matched by numeric chain id, a Solana action by CAIP-2 — ERC-20 transfer
calldata is decoded and checked rather than trusted, and the burn sinks of both families are
rejected. Provider policy is treated as a second enforcement layer, not the first one.

### Wallet provisioning

One provisioner per control-plane network, behind a router that selects by the chain the request
names. A pet holds at most one wallet per chain family, and the Solana binding is keyed by the
pet's wallet id with a `_solana` suffix so both families' rows sit in one key space. The
provisioner refuses a chain it was not configured for before any provider call is made, which is
how the Solana rail stays inert until it is switched on.

Provisioning is two-phase because it has to be: attaching the agent signer requires the owner's own
credential, so the server returns what the owner must authorize, then inspects Privy and saves a
binding only when the wallet, its owner, its single agent signer and that signer's one override
policy all match exactly what was asked for. The expected policy is rebuilt on the binding's own
network, since a Solana binding names Solana devnet and base58 recipients. The owner's Privy DID is
encrypted before it reaches the repository, under a key only the provisioner workload holds. An
expired policy is rotated through the same staged, owner-authorized path rather than edited.

### Signer revocation

MeowWa cannot detach its own agent signer — Privy requires the owner's credential to change the
wallet's signers. The owner performs the detachment and this verifies the result against Privy,
recording `revoked` only when no additional signer remains. A signer still attached, or an
unexpected one in its place, is recorded as `drifted` instead, which is the case worth alerting on.
Verification runs in the wallet-provisioner workload because it needs the Privy app secret, which
the API is deliberately never given.

### Purchase intents and one-use credentials

A purchase request is frozen into an immutable intent — owner, pet, mandate, merchant, product,
quantity, amount, quote and expiry, recipient, contract, chain, and a request nonce — hashed into
an intent hash. Sensitive actions are authorized by a short-lived, one-use credential bound to
that exact hash, so a changed amount, merchant or recipient invalidates the credential rather than
silently riding on it. The on-chain reference id is derived from the same hash, which is what lets
a settled transfer be matched back to the request that produced it.

### Policy gate

The gate is ordinary deterministic code with tests, not a model. Given a request and the owner's
mandate it returns approve, require owner approval, or block, from product category, merchant,
amount, budget, frequency, and the current safety state. It denies by default, it runs
server-side, and it is re-run when price, quantity, merchant or product changes.

### Transfer and balance readers

Chain-family readers for canonical USDC: balance reads and transfer-log reads for EVM chains via
viem, and the equivalent reads for Solana. EVM receipt decoding turns a submitted transaction into
the transfer facts the reconciler needs — log identity, amount, sender, recipient. The two families
answer different questions about history: an EVM chain reads a balance at any past block, while
Solana answers only at finalized commitment and stamps the answer with the slot it is the state of.

### Receive indexing

The sandbox receive path runs on Base Sepolia. Incoming transfers are found by scanning canonical
USDC transfer logs over a block range. The cursor stores both the next block to read and a checkpoint of the last block number and block
hash. When the checkpoint hash no longer matches the chain, indexing halts: a single checkpoint
cannot locate where the chain diverged, so there is no safe partial reversal, and rewinding to the
scan start would reverse credits that may already have been spent. The cursor and the ledger are
left untouched, a support case is opened, pet autonomy is suspended while the halt stands, and an
operator reconciles the window explicitly. Credits are idempotent on chain log identity, so
re-reading a range cannot double-credit.

### Fleet indexing

The production rails are indexed per family, one indexer per rail over a shared core. What is the
same on every rail — the durable cursor and checkpoint, the confirmed window, an independent
block-hash re-read before anything settles, tenant resolution, and the idempotent settle and
outflow handshake — lives in that core; what differs lives in the reader and a per-family adapter
that vouches for a transfer and maps it onto the ledger's fields. The ledger's column names are
kept on both: on Solana the transaction hash is the signature, the log index an instruction
ordinal, the block number a slot and the block hash a blockhash. Addresses and hashes are compared
under the rail's own identity rules — lowercase hex on an EVM chain, exact base58 on Solana, where
lowercasing would turn one wallet into another.

The scan window differs because the chains do. Every EVM height has a block, so a window ends on
its last height; Solana skips slots, so the window search widens and then bisects to find the first
block at or after the cursor, and still fetches no more than one range. A changed checkpoint raises
a reorg error that halts that rail's worker one way until the process restarts, and a halt is
recorded and gated on its own chain's key, so one rail's divergence never pauses the other.

### Ledger reconciliation

A scheduled sweep walks the wallet fleet on each funding rail and runs two independent checks per
wallet. The first is an internal identity — the ledger balance against the canonical chain net plus
reorged credits minus reorged debits — with every sum computed separately from the tables the
application writes. The second compares the wallet's actual on-chain USDC balance against the
indexed net, both bounded to the same height; it is the only check whose truth source is outside
the database.

Bounding both sides to one height is what keeps ordinary indexer lag from reading as a
discrepancy, and how that height is chosen is the one place the families diverge. An EVM rail asks
for the balance at the highest block both sides cover. Solana cannot answer about a past slot, so a
finalized balance is kept as a sample and compared on a later pass, once the cursor has finished
that slot — exactly as exact, one interval later.

The sweep only observes and appends: a mismatch is recorded durably, deduplicated per open wallet
and kind, and announced on stderr without details. It also refuses to look clean when it verified
nothing. Wallets that threw, wallets listed active but unresolvable, and a comparison skipped for
indexer lag or an open reorg halt are each counted and travel with the summary, so a pass that
checked nothing cannot be published as a pass.

### Merchant reconciliation

Orders and refunds are placed against a merchant gateway and settled only against confirmed
on-chain evidence. Provider events arrive as signed webhooks verified over the raw request body;
re-delivery is matched to the record it already wrote. A create attempted without a known
provider reference is bounded by a retry cap, because a blind retry against a provider that has
forgotten the reference is how an owner gets charged twice.

## Chain parity

Both families carry the same rails, with one exception. On Base and on Solana there are chain
descriptors and per-family address, signature and block-hash validation; USDC balance and transfer
readers; funding rails including the Stripe onramp destination network; direct-deposit crediting
and fleet indexing, each with its own cursor, checkpoint and reorg halt; ledger reconciliation;
withdrawal destinations and prepared withdrawals; Privy wallet provisioning, one wallet per pet per
family; and the wallet-control transfer policy.

Agent execution — the agent signing and submitting a payment — exists on Base only. The deferral is
written into the code rather than worked around. The execution service stamps
`base_sepolia`, chain id 84532 and `eip155:84532` on every submission; the execution provider takes
an EVM chain descriptor and encodes an ERC-20 transfer; and migration 053 pins the submissions
table with `CHECK (chain_key = 'base_sepolia')` while deliberately leaving its ERC-20 contract,
calldata and hash constraints unchanged. There is no Solana send path anywhere in this repository.

Base is also the default rail. Solana rails are inert unless the funding chain list names them, and
a request for a rail that is not enabled is refused before it reaches a provider.

## Database schema

`schema/053_multi_chain_rails.sql` is the migration that made a second rail representable. Every
financial table had identified its network by the integer EVM chain id, typed addresses as
`char(42)` lowercase hex and hashes as `char(66)`, and keyed primary keys, unique indexes and the
worker's wallet resolvers on that integer — none of which fits a chain with no numeric id,
case-significant base58 addresses and longer signatures. The migration adds a text `chain_key` to
every financial table beside a now-nullable `chain_id`, and moves every key, index, CHECK and
resolver onto it. Address, transaction-id and block-hash checks become IMMUTABLE per-family
functions usable inside CHECK constraints; the EVM patterns are the same expressions the old fixed
CHECKs used, so Base rows stay byte-identical. Bindings become unique per `(tenant_id, pet_id,
chain_key)` — one wallet per pet per family — and per `(chain_key, smart_wallet_address)`. Column
names do not change; on Solana they carry that family's meaning. BEFORE INSERT triggers derive
`chain_key` from `chain_id` so an older image writing during a rolling upgrade still satisfies the
NOT NULL.

It is published as a design artifact, not as runnable schema. Migrations 001 through 052 are not
in this repository, so this file alters tables it does not create and will not run standalone.

## Status and limits

- Every payment path in this repository is a sandbox path. It uses simulated test USDC on test
  networks and moves no real funds.
- This is not audited financial software. It has had no smart-contract review, no
  provider-configuration review, and no penetration test. Do not point it at real money.
- This is a component, not a product. The clients, the rest of the API and the interpretation
  service it normally sits inside are not here, so the repository does not run end to end on its
  own and is not intended to.
- The tenant data layer is not published either. `src/tenancy/postgres-repository.ts` declares only
  the three driver shapes the rails actually use — a result, a client and a pool — so these files
  can be read, typechecked and tested without it. Real `pg` types satisfy them structurally.

## Layout

```
packages/chain-domain/src      Pure domain, no I/O: chain descriptors, USDC amount arithmetic,
                               the policy gate, wallet and autonomy state machines, shared
                               codes and schemas.
src/chain                      Chain readers: EVM and Solana USDC balance readers, USDC transfer
                               readers, EVM receipt decoding.
src/wallet-control             Wallet provisioning and control policy: Privy provider, wallet
                               directory, transfer-policy evaluation, repository, migrations,
                               routes, configuration.
src/wallet-execution           Purchase intents, signing and submission, balance reads, receive
                               and receive-indexer, settlement reconciler, repository,
                               migrations, routes.
src/tenancy                    The multi-tenant financial rails: funding, withdrawal and wallet
                               provisioning routes, the per-family USDC indexers, the ledger
                               reconciliation sweep, Privy wallet provisioning and signer
                               revocation, the Stripe event processor, tenant wallet execution
                               and its reconciler, the financial repository and its narrow
                               Postgres driver port, runtime configuration, tenant identity and
                               invite tokens, at-rest encryption, and the two worker HTTP
                               surfaces with their health and readiness gates.
src/merchant-reconciliation    Merchant gateway client, signed webhooks and webhook events,
                               order and refund reconciler, repository, migrations, routes.
src/controlled-merchant        The merchant endpoint used to close the purchase loop in the
                               sandbox: quotes, orders, refunds, and their chain evidence.
src/funding                    Stripe onramp sessions, Privy destination binding, on-chain
                               funding verification, raw-body signature verification, and the
                               rail vocabulary the financial code shares.
src/observability              Log configuration: allowlisted request, response and error
                               projections, so a provider message, a request body or an auth
                               header never reaches a log line.
src/adapters                   Wallet and merchant adapter boundaries the rest of the API calls.
src/modules                    The two rules the money rails borrow from surfaces that live
                               outside this tree: how a deposit into an archived pet's wallet is
                               reported, and the owner step-up envelope a financial control is
                               confirmed against.
src/store                      The narrow store port the chain code depends on — a reference
                               implementation of the contract, not the private application store —
                               and local database path resolution.
src/*.ts                       Mandate signing, request authentication, bounded HTTP response
                               reading, service URL resolution.
schema                         Migration 053, the multi-chain rails migration, published as a
                               design artifact. See Database schema above.
docs/runbooks                  The two operator runbooks this code names at runtime: what to do
                               when the ledger and the chain disagree, and what to do when a
                               reorg halts the indexer.
```

## Toolchain

Node 24, TypeScript in ESM with NodeNext resolution, vitest for tests, viem for EVM access, zod
for schema validation, Fastify for the route and worker surfaces, and the Stripe and Privy SDKs at
those provider boundaries. The suite is 53 files and 650 tests. Workspace scripts:

```
npm run build       compile to dist/
npm run typecheck   type-check without emitting
npm test            run the vitest suites under src/ and packages/
```

## License

Apache License 2.0 — see [LICENSE](LICENSE). See [NOTICE](NOTICE) for what that grant covers and
what it does not.
