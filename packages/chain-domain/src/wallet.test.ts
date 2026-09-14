import { describe, expect, it } from 'vitest';
import {
  BASE_SEPOLIA_USDC_CONTRACT,
  POC_CHAIN_ID,
  petWalletSnapshotSchema,
  receiveProfileSchema,
  walletAssetHoldingSchema,
  isSpendablePocAsset,
  buildPocUsdcReceiveUri,
} from './index.js';

const walletAddress = '0x1111111111111111111111111111111111111111';

describe('POC pet-wallet contracts', () => {
  it('uses Base Sepolia as the single POC receive and spend network', () => {
    expect(POC_CHAIN_ID).toBe(84532);
  });

  it('recognizes only the canonical Base Sepolia test-USDC contract as spendable', () => {
    expect(isSpendablePocAsset(BASE_SEPOLIA_USDC_CONTRACT, BASE_SEPOLIA_USDC_CONTRACT)).toBe(true);
    expect(isSpendablePocAsset(BASE_SEPOLIA_USDC_CONTRACT.toLowerCase(), BASE_SEPOLIA_USDC_CONTRACT)).toBe(true);
    expect(isSpendablePocAsset('0x2222222222222222222222222222222222222222', BASE_SEPOLIA_USDC_CONTRACT)).toBe(false);
    expect(isSpendablePocAsset('not-an-address', BASE_SEPOLIA_USDC_CONTRACT)).toBe(false);
  });

  it('keeps unknown holdings visible but non-spendable', () => {
    expect(walletAssetHoldingSchema.parse({
      chainId: POC_CHAIN_ID,
      contractAddress: '0x2222222222222222222222222222222222222222',
      symbol: 'GIFT',
      decimals: 18,
      balanceAtomic: '9000000000000000000',
      spendable: false,
      verification: 'UNKNOWN',
    })).toMatchObject({ spendable: false, verification: 'UNKNOWN' });
  });

  it('rejects a holding that claims a noncanonical token is spendable', () => {
    expect(() => walletAssetHoldingSchema.parse({
      chainId: POC_CHAIN_ID,
      contractAddress: '0x2222222222222222222222222222222222222222',
      symbol: 'USDC',
      decimals: 6,
      balanceAtomic: '5000000',
      spendable: true,
      verification: 'CANONICAL_USDC',
    })).toThrow();
  });

  it('parses one JSON-safe wallet snapshot with a separately visible spendable balance', () => {
    const snapshot = petWalletSnapshotSchema.parse({
      walletId: 'wallet_mochi',
      petId: 'pet_mochi',
      chainId: POC_CHAIN_ID,
      address: walletAddress,
      status: 'active',
      spendableUsdcAtomic: '5000000',
      holdings: [{
        chainId: POC_CHAIN_ID,
        contractAddress: BASE_SEPOLIA_USDC_CONTRACT,
        symbol: 'USDC',
        decimals: 6,
        balanceAtomic: '5000000',
        spendable: true,
        verification: 'CANONICAL_USDC',
      }],
      lastSyncedAt: '2026-07-16T20:00:00.000Z',
    });

    expect(snapshot.spendableUsdcAtomic).toBe('5000000');
    expect(JSON.stringify(snapshot)).toContain('5000000');
  });

  it('rejects a nonzero spendable balance without one matching canonical holding', () => {
    expect(() => petWalletSnapshotSchema.parse({
      walletId: 'wallet_mochi',
      petId: 'pet_mochi',
      chainId: POC_CHAIN_ID,
      address: walletAddress,
      status: 'active',
      spendableUsdcAtomic: '5000000',
      holdings: [],
      lastSyncedAt: '2026-07-16T20:00:00.000Z',
    })).toThrow(/canonical holding/i);
  });

  it('defines a privacy-safe Base Sepolia public receive profile', () => {
    const receiveUri = buildPocUsdcReceiveUri(walletAddress);
    const profile = receiveProfileSchema.parse({
      petId: 'pet_mochi',
      petName: 'Mochi',
      species: 'cat',
      chainId: POC_CHAIN_ID,
      address: walletAddress,
      acceptedAsset: {
        symbol: 'USDC',
        contractAddress: BASE_SEPOLIA_USDC_CONTRACT,
      },
      receiveUri,
      sharingEnabled: true,
    });

    expect(profile).not.toHaveProperty('ownerId');
    expect(profile).not.toHaveProperty('ownerEmail');
    expect(profile.chainId).toBe(84532);
  });

  it('builds a standards-shaped ERC-20 receive URI with the USDC contract as target', () => {
    expect(buildPocUsdcReceiveUri(walletAddress)).toBe(
      `ethereum:${BASE_SEPOLIA_USDC_CONTRACT}@84532/transfer?address=${walletAddress}`,
    );
    expect(() => buildPocUsdcReceiveUri('not-an-address')).toThrow(/recipient address/i);
  });

  it('rejects a receive URI that does not name the profile wallet', () => {
    expect(() => receiveProfileSchema.parse({
      petId: 'pet_mochi',
      petName: 'Mochi',
      species: 'cat',
      chainId: POC_CHAIN_ID,
      address: walletAddress,
      acceptedAsset: {
        symbol: 'USDC',
        contractAddress: BASE_SEPOLIA_USDC_CONTRACT,
      },
      receiveUri: buildPocUsdcReceiveUri('0x2222222222222222222222222222222222222222'),
      sharingEnabled: true,
    })).toThrow(/receive URI/i);
  });
});
