import { z } from 'zod';
import { ATOMIC_AMOUNT_PATTERN, CHAINS, EVM_ADDRESS_PATTERN, buildUsdcReceiveUri, sameChainAddress } from './chain.js';
import { SPECIES } from './codes.js';

const idSchema = z.string().regex(/^[a-z][a-z0-9_:-]{2,127}$/i);
const evmAddressSchema = z.string().regex(EVM_ADDRESS_PATTERN);
const atomicAmountSchema = z.string().regex(ATOMIC_AMOUNT_PATTERN);

/** The proof-of-concept sandbox runs on one network; its schemas pin that network by literal. */
export const POC_CHAIN = CHAINS.base_sepolia;
export const POC_CHAIN_ID = POC_CHAIN.chainId;
export const POC_USDC_CONTRACT = POC_CHAIN.usdc.asset;

/** EIP-681 request for the pet's canonical POC USDC wallet; see `buildUsdcReceiveUri`. */
export function buildPocUsdcReceiveUri(recipientAddress: string): string {
  return buildUsdcReceiveUri(POC_CHAIN, recipientAddress);
}

export function isSpendablePocAsset(
  contractAddress: string,
  canonicalUsdcContract: string = POC_USDC_CONTRACT,
): boolean {
  return sameChainAddress(POC_CHAIN, contractAddress, canonicalUsdcContract);
}

export const walletAssetHoldingSchema = z.object({
  chainId: z.literal(POC_CHAIN_ID),
  contractAddress: evmAddressSchema,
  symbol: z.string().trim().min(1).max(20),
  decimals: z.number().int().min(0).max(255),
  balanceAtomic: atomicAmountSchema,
  spendable: z.boolean(),
  verification: z.enum(['CANONICAL_USDC', 'VIEW_ONLY', 'UNKNOWN']),
}).strict().superRefine((holding, context) => {
  if (!holding.spendable) return;
  if (!isSpendablePocAsset(holding.contractAddress) || holding.verification !== 'CANONICAL_USDC' ||
    holding.symbol !== 'USDC' || holding.decimals !== 6) {
    context.addIssue({
      code: 'custom',
      message: 'Only canonical Base Sepolia test USDC can be spendable',
    });
  }
});

export const petWalletSnapshotSchema = z.object({
  walletId: idSchema,
  petId: idSchema,
  chainId: z.literal(POC_CHAIN_ID),
  address: evmAddressSchema,
  status: z.enum(['provisioning', 'active', 'paused', 'recovery_pending', 'revoked', 'failed']),
  spendableUsdcAtomic: atomicAmountSchema,
  holdings: z.array(walletAssetHoldingSchema).max(100),
  lastSyncedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((snapshot, context) => {
  const canonicalHoldings = snapshot.holdings.filter((holding) => holding.spendable);
  if ((snapshot.spendableUsdcAtomic !== '0' && canonicalHoldings.length !== 1) || canonicalHoldings.length > 1 ||
    (canonicalHoldings[0] !== undefined && canonicalHoldings[0].balanceAtomic !== snapshot.spendableUsdcAtomic)) {
    context.addIssue({
      code: 'custom',
      message: 'Spendable USDC balance must match the canonical holding',
    });
  }
});

export const receiveProfileSchema = z.object({
  petId: idSchema,
  petName: z.string().trim().min(1).max(80),
  species: z.enum(SPECIES),
  chainId: z.literal(POC_CHAIN_ID),
  address: evmAddressSchema,
  acceptedAsset: z.object({
    symbol: z.literal('USDC'),
    contractAddress: z.literal(POC_USDC_CONTRACT),
  }).strict(),
  receiveUri: z.string().trim().min(1).max(500),
  sharingEnabled: z.boolean(),
}).strict().superRefine((profile, context) => {
  if (evmAddressSchema.safeParse(profile.address).success && profile.receiveUri !== buildPocUsdcReceiveUri(profile.address)) {
    context.addIssue({
      code: 'custom',
      path: ['receiveUri'],
      message: 'Receive URI must exactly match the profile wallet',
    });
  }
});

export type WalletAssetHolding = z.infer<typeof walletAssetHoldingSchema>;
export type PetWalletSnapshot = z.infer<typeof petWalletSnapshotSchema>;
export type ReceiveProfile = z.infer<typeof receiveProfileSchema>;
