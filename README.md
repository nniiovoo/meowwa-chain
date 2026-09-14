# meowwa-chain

This repository is the owner-controlled agentic wallet core behind MeowWa. MeowWa is an AI
pet-care agent: it reads a pet's signals, proposes a concrete purchase, and spends USDC on the
owner's behalf under a deterministic, owner-approved policy that the agent itself cannot change.

Published here is the money-movement and safety-gate half of that system — multi-chain
descriptors, Privy-backed wallet provisioning and control policy, USDC transfer and balance
readers, receive indexing, merchant reconciliation, onramp funding, immutable purchase intents,
and the deterministic policy gate that decides whether a proposed payment may proceed at all.

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

### Wallet control

Each pet wallet is an owner-controlled embedded wallet provisioned through Privy. The server does
not hold an unrestricted key and cannot widen its own authority. A separate transfer-policy
evaluator decides whether a proposed agent transfer is inside the configured signer policy: chain,
asset, recipient, amount bounds, and the shape of the call itself. ERC-20 transfer calldata is
decoded and checked rather than trusted, and burn sinks on both families are rejected. Provider
policy is treated as a second enforcement layer, not the first one.

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
the transfer facts the reconciler needs — log identity, amount, sender, recipient.

### Receive indexing

Incoming transfers are found by scanning canonical USDC transfer logs over a block range. The
cursor stores both the next block to read and a checkpoint of the last block number and block
hash. When the checkpoint hash no longer matches the chain, the cursor rewinds instead of
advancing, so a reorg causes the affected range to be re-read rather than leaving a credit behind
for a transfer that no longer exists. Credits are idempotent on chain log identity, so re-reading
a range cannot double-credit.

### Merchant reconciliation

Orders and refunds are placed against a merchant gateway and settled only against confirmed
on-chain evidence. Provider events arrive as signed webhooks verified over the raw request body;
re-delivery is matched to the record it already wrote. A create attempted without a known
provider reference is bounded by a retry cap, because a blind retry against a provider that has
forgotten the reference is how an owner gets charged twice.

### Funding

Fiat funding uses the Stripe Crypto Onramp. The destination is locked server-side to the pet's
verified wallet address and client-supplied destinations are rejected. Only production rails have
an onramp network, so a test-network funding attempt fails rather than silently resolving. A
ledger credit is committed from a finalized on-chain transfer, never from a browser redirect or an
unverified callback; signed provider events, provider event ids and chain log identities are all
durable and idempotent.

## Status and limits

- Every payment path in this repository is a sandbox path. It uses simulated test USDC on test
  networks and moves no real funds.
- This is not audited financial software. It has had no smart-contract review, no
  provider-configuration review, and no penetration test. Do not point it at real money.
- This is a component, not a product. The clients, the rest of the API and the interpretation
  service it normally sits inside are not here, so the repository does not run end to end on its
  own and is not intended to.

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
src/merchant-reconciliation    Merchant gateway client, signed webhooks and webhook events,
                               order and refund reconciler, repository, migrations, routes.
src/controlled-merchant        The merchant endpoint used to close the purchase loop in the
                               sandbox: quotes, orders, refunds, and their chain evidence.
src/funding                    Stripe onramp sessions, Privy destination binding, on-chain
                               funding verification, raw-body signature verification.
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
```

## Toolchain

Node 24, TypeScript in ESM with NodeNext resolution, vitest for tests, viem for EVM access, zod
for schema validation. Workspace scripts:

```
npm run build       compile to dist/
npm run typecheck   type-check without emitting
npm test            run the vitest suites under src/ and packages/
```

## License

Apache License 2.0 — see [LICENSE](LICENSE). See [NOTICE](NOTICE) for what that grant covers and
what it does not.
