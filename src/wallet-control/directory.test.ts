import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentSignerPolicy, policyDigest } from './policy.js';
import { VerifiedPetWalletDirectory } from './directory.js';
import { WalletControlRepository } from './repository.js';

const directories: string[] = [];

function createVerifiedBinding(path: string, petId: string, address: `0x${string}`): void {
  const policy = buildAgentSignerPolicy({
    ownerPrivyUserId: 'did:privy:owner_123',
    petId,
    allowedRecipients: ['0x1111111111111111111111111111111111111111'],
    perTransactionLimitAtomic: '1000000',
    validUntil: '2027-07-15T12:00:00.000Z',
  });
  const repository = new WalletControlRepository(path, {
    now: () => new Date('2026-07-14T12:00:00.000Z'),
  });
  const requested = repository.beginProvisioning({
    bindingId: `binding_${petId}`,
    ownerId: 'owner_1',
    petId,
    appWalletId: `wallet_${petId}`,
    privyUserId: 'did:privy:owner_123',
    agentSignerId: 'quorum_agent_123',
    expectedPolicyDigest: policyDigest(policy),
    expectedPolicyJson: JSON.stringify(policy),
  });
  const prepared = repository.setPolicy(requested.bindingId, requested.version, `policy_${petId}`);
  repository.activate(prepared.bindingId, prepared.version, {
    privyEmbeddedWalletId: `embedded_${petId}`,
    smartWalletAddress: address,
    verifiedAt: '2026-07-14T12:01:00.000Z',
  });
  repository.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('verified pet wallet directory', () => {
  it('projects only a provider-verified owner and pet address from the durable control ledger', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meowwa-wallet-directory-'));
    directories.push(directory);
    const path = join(directory, 'wallet-control.sqlite');
    createVerifiedBinding(path, 'pet_mochi', '0x1234567890abcdef1234567890abcdef12345678');

    const wallets = new VerifiedPetWalletDirectory(path);
    expect(wallets.getVerifiedAddress('owner_1', 'pet_mochi')).toEqual({
      ownerId: 'owner_1',
      petId: 'pet_mochi',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      chainId: 84532,
      verifiedAt: '2026-07-14T12:01:00.000Z',
    });
    expect(wallets.getVerifiedAddress('owner_1', 'pet_pepper')).toBeUndefined();
    expect(wallets.getVerifiedAddress('owner_2', 'pet_mochi')).toBeUndefined();
    wallets.close();
  });
});
