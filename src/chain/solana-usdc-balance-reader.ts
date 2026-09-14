import { ATOMIC_AMOUNT_PATTERN, USDC_DECIMALS, isSolanaAddress, type SolanaChainDescriptor } from '@meowwa/chain-domain';
import {
  SOLANA_TOKEN_PROGRAM_ID,
  createSolanaRpcClient,
  type SolanaParsedTokenAccount,
  type SolanaRpcClient,
} from './solana-usdc-transfer-reader.js';

/** The two RPC reads a balance needs; the transfer reader's full client satisfies it. */
export type SolanaBalanceRpcClient = Pick<SolanaRpcClient, 'getGenesisHash' | 'getTokenAccountsByOwner'>;

export interface SolanaFinalizedUsdcBalance {
  /** The owner's canonical USDC across every token account, in atomic units. */
  amountAtomic: bigint;
  /** The finalized slot the balance is the state of; the ledger sweep compares only at this height. */
  slot: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads a wallet's canonical USDC balance on one Solana network, at `finalized` commitment.
 *
 * Solana has no historical balance read: there is no "balanceOf at slot N", only the state at the
 * commitment level asked for. What the RPC does give back is the slot its answer is the state of,
 * and finalized state never changes afterwards -- so a finalized balance stamped with its slot is
 * exactly as pinned as an EVM balance read at a block number, and that stamp is what lets the
 * reconciliation sweep bound its comparison to one height on this chain too.
 *
 * A Solana wallet does not hold USDC itself; token accounts owned by the wallet do, and an owner
 * can hold more than one for the same mint (the associated account plus any ad-hoc ones). Every
 * account the RPC returns for the owner and the canonical mint is summed, and every account is
 * checked to really be a canonical-mint token account of that owner before its amount counts:
 * a read that cannot be trusted is an error, never a smaller number.
 */
export class SolanaUsdcBalanceReader {
  readonly #client: SolanaBalanceRpcClient;
  readonly #chain: SolanaChainDescriptor;

  constructor(client: SolanaBalanceRpcClient, chain: SolanaChainDescriptor) {
    if (!isSolanaAddress(chain.usdc.asset)) throw new Error(`${chain.displayName} USDC mint is invalid`);
    this.#client = client;
    this.#chain = chain;
  }

  get chain(): SolanaChainDescriptor { return this.#chain; }

  async balanceAtomicFinalized(owner: string): Promise<SolanaFinalizedUsdcBalance> {
    const label = this.#chain.displayName;
    if (!isSolanaAddress(owner)) throw new Error(`Invalid ${label} wallet address`);
    if (await this.#client.getGenesisHash() !== this.#chain.genesisHash) throw new Error(`${label} chain identity mismatch`);
    const response = await this.#client.getTokenAccountsByOwner(
      owner, { mint: this.#chain.usdc.asset }, { commitment: 'finalized', encoding: 'jsonParsed' },
    );
    const slot = response?.context?.slot;
    if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(response.value)) {
      throw new Error(`${label} token account read is invalid`);
    }
    const seen = new Set<string>();
    let amountAtomic = 0n;
    for (const account of response.value) {
      const pubkey = text(account?.pubkey);
      if (pubkey === undefined || !isSolanaAddress(pubkey) || seen.has(pubkey)) throw new Error(`${label} token account read is invalid`);
      seen.add(pubkey);
      amountAtomic += this.#amountOf(account, owner);
    }
    return { amountAtomic, slot };
  }

  #amountOf(account: SolanaParsedTokenAccount, owner: string): bigint {
    const label = this.#chain.displayName;
    const data = account.account?.data;
    // A token account the RPC could not parse comes back base64-encoded instead of parsed; it is
    // still an account holding an unknown amount, so it cannot be skipped and cannot be summed.
    if (typeof data !== 'object' || Array.isArray(data) || data.program !== 'spl-token' ||
      account.account.owner !== SOLANA_TOKEN_PROGRAM_ID) {
      throw new Error(`${label} token account is not a canonical USDC account`);
    }
    const parsed = data.parsed;
    if (!parsed || typeof parsed === 'string' || parsed.type !== 'account' || !parsed.info) {
      throw new Error(`${label} token account is not a canonical USDC account`);
    }
    const info = parsed.info;
    const tokenAmount = info.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
    const amount = text(tokenAmount?.amount);
    // The RPC filtered on mint and owner already; re-checking costs nothing and turns a provider
    // that answered for the wrong mint or the wrong owner into an error instead of a wrong balance.
    if (info.mint !== this.#chain.usdc.asset || info.owner !== owner || tokenAmount?.decimals !== USDC_DECIMALS ||
      amount === undefined || !ATOMIC_AMOUNT_PATTERN.test(amount)) {
      throw new Error(`${label} token account is not a canonical USDC account`);
    }
    return BigInt(amount);
  }
}

export function createSolanaUsdcBalanceReader(rpcUrl: string, chain: SolanaChainDescriptor): SolanaUsdcBalanceReader {
  return new SolanaUsdcBalanceReader(createSolanaRpcClient(rpcUrl), chain);
}
