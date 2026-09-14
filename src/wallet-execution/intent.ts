import { createHash } from 'node:crypto';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_CONTRACT, EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { PaymentIntent } from '../adapters/wallet.js';
import { ERC20_TRANSFER_ABI } from '../wallet-control/policy.js';

const addressPattern = EVM_ADDRESS_PATTERN;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDC_ATOMIC_PER_MINOR = 10_000;

export interface SandboxTransferIntent {
  requestId: string;
  ownerId: string;
  petId: string;
  smartWalletAddress: string | null;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  caip2: `eip155:${typeof BASE_SEPOLIA_CHAIN_ID}`;
  usdcContract: string;
  recipient: string;
  amountAtomic: string;
  valueAtomic: '0';
  calldata: Hex;
  referenceId: string;
  intentHash: string;
}

export function minorToUsdcAtomic(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('USDC minor amount must be a safe integer');
  if (amountMinor <= 0) throw new Error('USDC minor amount must be positive');
  if (amountMinor > Math.floor(Number.MAX_SAFE_INTEGER / USDC_ATOMIC_PER_MINOR)) {
    throw new Error('USDC atomic amount must remain a safe integer');
  }
  return String(amountMinor * USDC_ATOMIC_PER_MINOR);
}

function referenceForIntent(intentHash: string, namespace = ''): string {
  const identity = namespace === ''
    ? `meowwa:base-sepolia:${intentHash}`
    : `meowwa:base-sepolia:tenant:v1\0${namespace}\0${intentHash}`;
  const digest = createHash('sha256').update(identity).digest('hex');
  return `mw_${digest.slice(0, 61)}`;
}

export function buildSandboxTransferIntent(
  payment: PaymentIntent,
  now: Date = new Date(),
  referenceNamespace = '',
): SandboxTransferIntent {
  if (!payment.approvedBy) throw new Error('Explicit owner approval is required');
  if (payment.ownerConfirmationStatus !== 'confirmed' || payment.requestedApprovalMode !== 'EVERY_REQUEST') {
    throw new Error('Sandbox execution requires explicit per-request owner approval');
  }
  if (payment.chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error('Only Base Sepolia is allowed');
  if (payment.currency !== 'USDC') throw new Error('Only test USDC is allowed');
  if (payment.contract.toLowerCase() !== BASE_SEPOLIA_USDC_CONTRACT.toLowerCase()) {
    throw new Error('Only canonical Base Sepolia test USDC is allowed');
  }
  if (!addressPattern.test(payment.recipient) || payment.recipient.toLowerCase() === ZERO_ADDRESS) throw new Error('Invalid recipient address');
  const quoteExpiry = Date.parse(payment.quoteExpiresAt);
  if (!Number.isFinite(quoteExpiry) || quoteExpiry <= now.getTime()) throw new Error('Quote has expired');

  const amountAtomic = minorToUsdcAtomic(payment.amountMinor);
  const recipient = payment.recipient.toLowerCase() as Address;
  return {
    requestId: payment.requestId,
    ownerId: payment.ownerId,
    petId: payment.petId,
    smartWalletAddress: null,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    caip2: `eip155:${BASE_SEPOLIA_CHAIN_ID}`,
    usdcContract: BASE_SEPOLIA_USDC_CONTRACT.toLowerCase(),
    recipient,
    amountAtomic,
    valueAtomic: '0',
    calldata: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [recipient, BigInt(amountAtomic)],
    }),
    referenceId: referenceForIntent(payment.intentHash, referenceNamespace),
    intentHash: payment.intentHash,
  };
}
