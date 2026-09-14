import { createHash } from 'node:crypto';
import {
  ATOMIC_AMOUNT_PATTERN,
  CHAINS,
  POSITIVE_ATOMIC_AMOUNT_PATTERN,
  formatUsdcAtomic,
  isChainAddress,
  normalizeChainAddress,
  parseUsdcDecimal,
  sameChainAddress,
  type ChainDescriptor,
} from '@meowwa/chain-domain';
import { ERC20_TRANSFER_ABI } from '../chain/evm.js';
import type { AgentSignerPolicyConfig, AgentTransferAction, AgentTransferDecision } from './types.js';

export const BASE_SEPOLIA_CHAIN_ID = CHAINS.base_sepolia.chainId;
export const BASE_SEPOLIA_USDC = CHAINS.base_sepolia.usdc.asset;
export const PRIVY_BASE_SEPOLIA_CHAIN = CHAINS.base_sepolia.privyChain;
export const PRIVY_USDC_ASSET = 'usdc' as const;

/** The burn sinks of each family: the EVM zero address and Solana's all-zero System Program id. */
const BURN_ADDRESSES = new Set(['0x0000000000000000000000000000000000000000', '1'.repeat(32)]);
const positiveAtomicPattern = POSITIVE_ATOMIC_AMOUNT_PATTERN;
const nonnegativeAtomicPattern = ATOMIC_AMOUNT_PATTERN;
const UINT256_MAX = (2n ** 256n) - 1n;

export { ERC20_TRANSFER_ABI };

interface PrivyPolicyCondition {
  field: string;
  field_source: 'action_request_body' | 'system';
  operator: 'eq' | 'in' | 'lte' | 'lt';
  value: string | string[];
}

export interface PrivyAgentSignerPolicy {
  chain_type: ChainDescriptor['privyChainType'];
  name: string;
  owner: { user_id: string };
  version: '1.0';
  rules: Array<{
    name: string;
    action: 'ALLOW';
    method: 'transfer';
    conditions: PrivyPolicyCondition[];
  }>;
}

/** Positive, uint256-bounded USDC for a provider policy or transfer body; `formatUsdcAtomic` for the rest. */
export function formatUsdcAmountAtomic(value: string): string {
  if (!positiveAtomicPattern.test(value) || BigInt(value) > UINT256_MAX) throw new Error('Invalid USDC amount');
  return formatUsdcAtomic(value);
}

export function parseUsdcAmountAtomic(value: string): string {
  const atomic = BigInt(parseUsdcDecimal(value));
  if (atomic <= 0n || atomic > UINT256_MAX) throw new Error('Invalid USDC amount');
  return atomic.toString();
}

function normalizeConfig(config: AgentSignerPolicyConfig, chain: ChainDescriptor): {
  ownerPrivyUserId: string;
  petId: string;
  allowedRecipients: string[];
  perTransactionLimitAtomic: string;
  validUntil: string;
  validUntilSeconds: number;
} {
  if (!config.ownerPrivyUserId.trim() || config.ownerPrivyUserId.length > 255) throw new Error('Invalid Privy user ID');
  if (!config.petId.trim() || config.petId.length > 255) throw new Error('Invalid pet ID');
  if (config.allowedRecipients.length === 0) throw new Error('At least one recipient is required');
  const allowedRecipients = [...new Set(config.allowedRecipients.map((address) => {
    if (!isChainAddress(chain, address) || BURN_ADDRESSES.has(address.toLowerCase())) throw new Error('Invalid recipient address');
    return normalizeChainAddress(chain, address);
  }))].sort();
  if (!positiveAtomicPattern.test(config.perTransactionLimitAtomic) || BigInt(config.perTransactionLimitAtomic) > UINT256_MAX) {
    throw new Error('Invalid per-transaction limit');
  }
  const validUntilMs = Date.parse(config.validUntil);
  if (!Number.isFinite(validUntilMs)) throw new Error('Invalid policy expiry');
  const validUntilSeconds = Math.floor(validUntilMs / 1000);
  if (!Number.isSafeInteger(validUntilSeconds) || validUntilSeconds <= 0) throw new Error('Invalid policy expiry');
  return {
    ownerPrivyUserId: config.ownerPrivyUserId,
    petId: config.petId,
    allowedRecipients,
    perTransactionLimitAtomic: config.perTransactionLimitAtomic,
    validUntil: new Date(validUntilMs).toISOString(),
    validUntilSeconds,
  };
}

/**
 * The user-owned, default-deny Privy policy that bounds what the agent signer may do with one pet
 * wallet: canonical USDC only, on one named network, to pre-approved recipients, under a
 * per-transaction limit, until an expiry. The rule shape is Privy's chain-agnostic transfer
 * action, so the same policy builds for an EVM or a Solana wallet; only the chain name, the
 * wallet type and the recipient address shape change.
 */
export function buildAgentSignerPolicy(config: AgentSignerPolicyConfig, chain: ChainDescriptor = CHAINS.base_sepolia): PrivyAgentSignerPolicy {
  const normalized = normalizeConfig(config, chain);
  const petFingerprint = createHash('sha256')
    .update(`meowwa:privy-policy-name:v1\0${normalized.petId}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return {
    chain_type: chain.privyChainType,
    name: `MeowWa pet ${petFingerprint} ${chain.displayName} USDC`,
    owner: { user_id: normalized.ownerPrivyUserId },
    version: '1.0',
    rules: [{
      name: `Allow bounded ${chain.displayName} USDC transfer`,
      action: 'ALLOW',
      method: 'transfer',
      conditions: [
        { field: 'source.asset', field_source: 'action_request_body', operator: 'eq', value: PRIVY_USDC_ASSET },
        { field: 'source.chain', field_source: 'action_request_body', operator: 'eq', value: chain.privyChain },
        { field: 'destination.address', field_source: 'action_request_body', operator: 'in', value: normalized.allowedRecipients },
        {
          field: 'source.amount', field_source: 'action_request_body', operator: 'lte',
          value: formatUsdcAmountAtomic(normalized.perTransactionLimitAtomic),
        },
        { field: 'current_unix_timestamp', field_source: 'system', operator: 'lt', value: String(normalized.validUntilSeconds) },
      ],
    }],
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function policyDigest(policy: PrivyAgentSignerPolicy): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(policy))).digest('hex');
}

/** Whether an action names this chain: by numeric chain ID on EVM, by CAIP-2 on Solana. */
function actionOnChain(action: AgentTransferAction, chain: ChainDescriptor): boolean {
  return chain.family === 'evm' ? action.chainId === chain.chainId : action.chainId === undefined && action.caip2 === chain.caip2;
}

export function evaluateAgentTransfer(
  config: AgentSignerPolicyConfig,
  action: AgentTransferAction,
  now: Date = new Date(),
  chain: ChainDescriptor = CHAINS.base_sepolia,
): AgentTransferDecision {
  const normalized = normalizeConfig(config, chain);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return { allowed: false, reason: 'invalid-time' };
  if (nowMs >= Date.parse(normalized.validUntil)) return { allowed: false, reason: 'authorization-expired' };
  if (action.method !== 'transfer') return { allowed: false, reason: 'wrong-method' };
  if (!actionOnChain(action, chain)) return { allowed: false, reason: 'wrong-chain' };
  if (!sameChainAddress(chain, action.to, chain.usdc.asset)) return { allowed: false, reason: 'wrong-token' };
  if (action.valueAtomic !== '0') return { allowed: false, reason: 'native-value' };
  if (action.functionName !== 'transfer') return { allowed: false, reason: 'wrong-function' };
  if (!action.recipient || !isChainAddress(chain, action.recipient) ||
    !normalized.allowedRecipients.includes(normalizeChainAddress(chain, action.recipient))) return { allowed: false, reason: 'wrong-recipient' };
  if (!action.amountAtomic || !nonnegativeAtomicPattern.test(action.amountAtomic) || action.amountAtomic === '0' || BigInt(action.amountAtomic) > UINT256_MAX) return { allowed: false, reason: 'invalid-amount' };
  if (BigInt(action.amountAtomic) > BigInt(normalized.perTransactionLimitAtomic)) return { allowed: false, reason: 'amount-exceeds-limit' };
  return { allowed: true };
}
