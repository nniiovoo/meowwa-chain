import { isSolanaAddress, isSolanaSignature, type SolanaChainDescriptor } from '@meowwa/chain-domain';
import {
  MAX_SCAN_RANGE,
  assertScanRange,
  dedupeTransfers,
  type ChainCheckpoint,
  type CheckpointingUsdcTransferReader,
} from './usdc-transfer-reader.js';

/** The legacy SPL Token program, which every canonical USDC mint lives under. */
export const SOLANA_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * How far below a window's last slot `checkpointAt` will look for a produced block: about 28
 * hours of slots at ~400ms, longer than any mainnet outage so far. Beyond it the RPC is answering
 * nothing and the scan fails visibly instead of walking towards genesis.
 */
export const SOLANA_CHECKPOINT_LOOKBACK_SLOTS = 250_000;

const positiveAtomicPattern = /^[1-9][0-9]*$/;

export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface SolanaParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
}

export interface SolanaBlockTransaction {
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string } | string>;
      instructions: SolanaParsedInstruction[];
    };
  };
  meta: {
    err: unknown;
    preTokenBalances?: SolanaTokenBalance[] | null;
    postTokenBalances?: SolanaTokenBalance[] | null;
    innerInstructions?: Array<{ index: number; instructions: SolanaParsedInstruction[] }> | null;
  } | null;
}

export interface SolanaBlock {
  blockhash: string;
  transactions: SolanaBlockTransaction[];
}

/** One `jsonParsed` token account as getTokenAccountsByOwner returns it; the reader validates every field it uses. */
export interface SolanaParsedTokenAccount {
  pubkey: string;
  account: {
    /** The program that owns the account: the Token program for a canonical USDC token account. */
    owner: string;
    data: {
      program?: string;
      parsed?: { type?: string; info?: Record<string, unknown> } | string;
    } | string[] | string;
  };
}

/** A `finalized` read of every token account an owner holds for one mint, stamped with the slot it was read at. */
export interface SolanaTokenAccountsByOwner {
  context: { slot: number };
  value: SolanaParsedTokenAccount[];
}

/**
 * The subset of Solana JSON-RPC the reader needs, always at `finalized` commitment. Finalized
 * slots cannot be rolled back, which is what lets a slot range stand in for the EVM block range
 * plus confirmation depth: there is no "removed log" on this chain, only blocks that were never
 * finalized and so are never returned.
 */
export interface SolanaRpcClient {
  getGenesisHash(): Promise<string>;
  getSlot(options: { commitment: 'finalized' }): Promise<number>;
  getBlocks(startSlot: number, endSlot: number, options: { commitment: 'finalized' }): Promise<number[]>;
  getBlock(slot: number, options: {
    commitment: 'finalized';
    encoding: 'jsonParsed';
    transactionDetails: 'full';
    maxSupportedTransactionVersion: 0;
    rewards: false;
  }): Promise<SolanaBlock | null>;
  getTokenAccountsByOwner(owner: string, filter: { mint: string }, options: {
    commitment: 'finalized';
    encoding: 'jsonParsed';
  }): Promise<SolanaTokenAccountsByOwner>;
}

export interface SolanaUsdcTransfer {
  chainKey: SolanaChainDescriptor['key'];
  caip2: string;
  /** The transaction signature: Solana's transaction identity. */
  signature: string;
  /** Position within the block, then within the transaction, so the ledger can key on it. */
  transactionIndex: number;
  instructionIndex: number;
  slot: number;
  blockhash: string;
  /** Owner wallets, which is what a pet wallet binding stores; token accounts are kept as evidence. */
  from: string;
  to: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  amountAtomic: string;
}

export interface SolanaUsdcTransferReaderOptions {
  chain: SolanaChainDescriptor;
  /** Defaults to the chain's canonical USDC mint; anything else is refused. */
  usdcMint?: string;
  direction: 'inbound' | 'both';
}

function pubkey(key: { pubkey: string } | string): string {
  return typeof key === 'string' ? key : key.pubkey;
}

function tokenInstruction(instruction: SolanaParsedInstruction): { type: string; info: Record<string, unknown> } | undefined {
  if (instruction.program !== 'spl-token' || instruction.programId !== SOLANA_TOKEN_PROGRAM_ID) return undefined;
  const parsed = instruction.parsed;
  if (!parsed || typeof parsed === 'string' || typeof parsed.type !== 'string' || !parsed.info) return undefined;
  return { type: parsed.type, info: parsed.info };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads canonical SPL USDC transfers for a set of owner wallets on one Solana network.
 *
 * A Solana wallet does not hold USDC itself; an associated token account owned by the wallet
 * does. The reader therefore resolves every token account a transaction touched back to its owner
 * through the transaction's token-balance metadata, and matches transfers on owners. Inner
 * instructions are walked as well, so a transfer made through another program's CPI is credited
 * the same as a direct one. A failed transaction moved nothing and is skipped; a block the RPC
 * says was finalized but cannot serve is an error, never a silent gap.
 */
export class SolanaUsdcTransferReader implements CheckpointingUsdcTransferReader<SolanaUsdcTransfer> {
  readonly #client: SolanaRpcClient;
  readonly #chain: SolanaChainDescriptor;
  readonly #usdcMint: string;
  readonly #direction: 'inbound' | 'both';

  constructor(client: SolanaRpcClient, options: SolanaUsdcTransferReaderOptions) {
    const usdcMint = options.usdcMint ?? options.chain.usdc.asset;
    if (!isSolanaAddress(usdcMint)) throw new Error(`${options.chain.displayName} USDC mint is invalid`);
    if (usdcMint !== options.chain.usdc.asset) throw new Error(`${options.chain.displayName} USDC mint is not canonical`);
    this.#client = client;
    this.#chain = options.chain;
    this.#usdcMint = usdcMint;
    this.#direction = options.direction;
  }

  get chain(): SolanaChainDescriptor { return this.#chain; }

  async latestBlockNumber(): Promise<bigint> {
    await this.#assertChainIdentity();
    const slot = await this.#client.getSlot({ commitment: 'finalized' });
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error(`${this.#chain.displayName} latest slot is invalid`);
    return BigInt(slot);
  }

  async blockHash(blockNumber: bigint): Promise<string> {
    if (blockNumber < 0n || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${this.#chain.displayName} checkpoint slot is invalid`);
    }
    await this.#assertChainIdentity();
    const block = await this.#fetchBlock(Number(blockNumber));
    return block.blockhash;
  }

  /**
   * The last finalized block at or below `toBlock`. Solana skips slots — a leader that misses its
   * turn leaves a slot number with no block — so a scan window's last slot is not guaranteed to
   * hold one, and a checkpoint must name a block that exists. The search walks `getBlocks` back
   * from `toBlock`: a short range first, because a skipped slot is normally alone or one of a
   * handful, then full scan-sized ranges, and gives up after a bounded lookback rather than crawl
   * towards genesis on behalf of an RPC that answers nothing (a cluster outage skips every slot
   * for its duration; the bound covers the longest one on record with room to spare).
   */
  async checkpointAt(toBlock: bigint): Promise<ChainCheckpoint> {
    const label = this.#chain.displayName;
    if (toBlock < 0n || toBlock > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} checkpoint slot is invalid`);
    await this.#assertChainIdentity();
    let end = Number(toBlock);
    let span = 64;
    for (let searched = 0; searched < SOLANA_CHECKPOINT_LOOKBACK_SLOTS && end >= 0;) {
      const start = Math.max(0, end - span + 1);
      const slots = await this.#client.getBlocks(start, end, { commitment: 'finalized' });
      let previous = start - 1;
      for (const slot of slots) {
        if (!Number.isSafeInteger(slot) || slot < start || slot > end || slot <= previous) throw new Error(`${label} RPC returned slots outside the checkpoint range`);
        previous = slot;
      }
      const produced = slots.at(-1);
      if (produced !== undefined) {
        const block = await this.#fetchBlock(produced);
        return { blockNumber: BigInt(produced), blockHash: block.blockhash };
      }
      searched += end - start + 1;
      end = start - 1;
      span = Number(MAX_SCAN_RANGE);
    }
    throw new Error(`${label} produced no finalized block within ${SOLANA_CHECKPOINT_LOOKBACK_SLOTS} slots at or below ${toBlock}`);
  }

  async getUsdcTransfers(input: { fromBlock: bigint; toBlock: bigint; walletAddresses: string[] }): Promise<SolanaUsdcTransfer[]> {
    const label = this.#chain.displayName;
    assertScanRange(label, input.fromBlock, input.toBlock);
    if (input.walletAddresses.length === 0) return [];
    const owners = new Set(input.walletAddresses.map((address) => {
      if (!isSolanaAddress(address)) throw new Error(`${label} scan wallet address is invalid`);
      return address;
    }));
    await this.#assertChainIdentity();
    const fromSlot = Number(input.fromBlock);
    const toSlot = Number(input.toBlock);
    const slots = await this.#client.getBlocks(fromSlot, toSlot, { commitment: 'finalized' });
    let previous = -1;
    const transfers: SolanaUsdcTransfer[] = [];
    for (const slot of slots) {
      if (!Number.isSafeInteger(slot) || slot < fromSlot || slot > toSlot || slot <= previous) throw new Error(`${label} RPC returned slots outside the scan range`);
      previous = slot;
      const block = await this.#fetchBlock(slot);
      block.transactions.forEach((transaction, transactionIndex) => {
        transfers.push(...this.#decodeTransaction(transaction, { slot, blockhash: block.blockhash, transactionIndex }, owners));
      });
    }
    return dedupeTransfers(label, transfers, (transfer) => `${transfer.signature}:${transfer.instructionIndex}`)
      .sort((left, right) => left.slot - right.slot || left.transactionIndex - right.transactionIndex || left.instructionIndex - right.instructionIndex);
  }

  #decodeTransaction(
    transaction: SolanaBlockTransaction,
    position: { slot: number; blockhash: string; transactionIndex: number },
    owners: Set<string>,
  ): SolanaUsdcTransfer[] {
    const label = this.#chain.displayName;
    const meta = transaction.meta;
    if (!meta || meta.err !== null) return [];
    const signature = transaction.transaction.signatures[0];
    if (signature === undefined || !isSolanaSignature(signature)) throw new Error(`${label} transaction signature is invalid`);
    const accountKeys = transaction.transaction.message.accountKeys.map(pubkey);
    const tokenAccounts = new Map<string, { owner: string | undefined; mint: string }>();
    for (const balance of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
      const account = accountKeys[balance.accountIndex];
      if (account === undefined) throw new Error(`${label} token balance names an account outside the transaction`);
      const prior = tokenAccounts.get(account);
      if (prior && prior.mint !== balance.mint) throw new Error(`${label} token account changed mint inside one transaction`);
      tokenAccounts.set(account, { owner: text(balance.owner) ?? prior?.owner, mint: balance.mint });
    }
    const ordered: SolanaParsedInstruction[] = [];
    transaction.transaction.message.instructions.forEach((instruction, index) => {
      ordered.push(instruction);
      for (const inner of meta.innerInstructions ?? []) {
        if (inner.index === index) ordered.push(...inner.instructions);
      }
    });
    const transfers: SolanaUsdcTransfer[] = [];
    ordered.forEach((instruction, instructionIndex) => {
      const parsed = tokenInstruction(instruction);
      if (!parsed || (parsed.type !== 'transfer' && parsed.type !== 'transferChecked')) return;
      const source = text(parsed.info.source);
      const destination = text(parsed.info.destination);
      if (!source || !destination) throw new Error(`${label} token transfer is missing its accounts`);
      const destinationAccount = tokenAccounts.get(destination);
      const sourceAccount = tokenAccounts.get(source);
      const mint = parsed.type === 'transferChecked' ? text(parsed.info.mint) : destinationAccount?.mint ?? sourceAccount?.mint;
      if (mint !== this.#usdcMint) return;
      const amount = parsed.type === 'transferChecked'
        ? text((parsed.info.tokenAmount as { amount?: unknown } | undefined)?.amount)
        : text(parsed.info.amount);
      if (!amount || !positiveAtomicPattern.test(amount)) throw new Error(`${label} USDC transfer amount is invalid`);
      const to = destinationAccount?.owner;
      const from = sourceAccount?.owner;
      const inbound = to !== undefined && owners.has(to);
      const outbound = this.#direction === 'both' && from !== undefined && owners.has(from);
      if (!inbound && !outbound) return;
      if (to === undefined || from === undefined || !isSolanaAddress(to) || !isSolanaAddress(from)) {
        throw new Error(`${label} USDC transfer owner is unresolved`);
      }
      transfers.push({
        chainKey: this.#chain.key,
        caip2: this.#chain.caip2,
        signature,
        transactionIndex: position.transactionIndex,
        instructionIndex,
        slot: position.slot,
        blockhash: position.blockhash,
        from,
        to,
        fromTokenAccount: source,
        toTokenAccount: destination,
        amountAtomic: amount,
      });
    });
    return transfers;
  }

  async #fetchBlock(slot: number): Promise<SolanaBlock> {
    const block = await this.#client.getBlock(slot, {
      commitment: 'finalized', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0, rewards: false,
    });
    if (!block || !isSolanaAddress(block.blockhash)) throw new Error(`${this.#chain.displayName} finalized block ${slot} is unavailable`);
    return block;
  }

  async #assertChainIdentity(): Promise<void> {
    if (await this.#client.getGenesisHash() !== this.#chain.genesisHash) throw new Error(`${this.#chain.displayName} chain identity mismatch`);
  }
}

/**
 * A dependency-free JSON-RPC transport. The readers only ever call a handful of read methods, so
 * the official client would add a supply-chain surface for no behaviour the ledger relies on.
 */
export function createSolanaRpcClient(rpcUrl: string, fetchImpl: typeof fetch = fetch): SolanaRpcClient {
  let nextId = 1;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Solana RPC ${method} failed with HTTP ${response.status}`);
    const payload = await response.json() as { result?: T; error?: { code: number; message: string } };
    if (payload.error) throw new Error(`Solana RPC ${method} failed: ${payload.error.message}`);
    return payload.result as T;
  }
  return {
    getGenesisHash: () => call('getGenesisHash', []),
    getSlot: (options) => call('getSlot', [options]),
    getBlocks: (startSlot, endSlot, options) => call('getBlocks', [startSlot, endSlot, options]),
    getBlock: (slot, options) => call('getBlock', [slot, options]),
    getTokenAccountsByOwner: (owner, filter, options) => call('getTokenAccountsByOwner', [owner, filter, options]),
  };
}

export function createSolanaUsdcTransferReader(rpcUrl: string, options: SolanaUsdcTransferReaderOptions): SolanaUsdcTransferReader {
  return new SolanaUsdcTransferReader(createSolanaRpcClient(rpcUrl), options);
}
