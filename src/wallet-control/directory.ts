import { DatabaseSync } from 'node:sqlite';
import { BASE_SEPOLIA_CHAIN_ID, policyDigest, type PrivyAgentSignerPolicy } from './policy.js';
import { EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';

type VerifiedWalletRow = {
  owner_id: string;
  pet_id: string;
  smart_wallet_address: string;
  environment: string;
  chain_id: number;
  smart_wallet_type: string;
  owner_type: string;
  expected_policy_digest: string;
  expected_policy_json: string;
  status: string;
  signer_status: string;
  last_verified_at: string;
};

export type VerifiedPetWalletAddress = {
  ownerId: string;
  petId: string;
  address: `0x${string}`;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  verifiedAt: string;
};

export interface PetWalletAddressDirectory {
  getVerifiedAddress(ownerId: string, petId: string): VerifiedPetWalletAddress | undefined;
  close?(): void;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validAddress(value: string): value is `0x${string}` {
  return EVM_ADDRESS_PATTERN.test(value) && !/^0x0{40}$/i.test(value);
}

/**
 * Read-only view of provider-verified sandbox wallet bindings.
 *
 * This intentionally does not initialize Privy controls or permit provisioning.
 * It only projects an address after the wallet-control ledger records a verified,
 * owner-controlled binding.
 */
export class VerifiedPetWalletDirectory implements PetWalletAddressDirectory {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (!path.trim() || path === ':memory:') throw new Error('Verified wallet directory must use an existing durable database');
    this.#database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    this.#database.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
  }

  close(): void {
    this.#database.close();
  }

  getVerifiedAddress(ownerId: string, petId: string): VerifiedPetWalletAddress | undefined {
    if (!ownerId.trim() || !petId.trim()) return undefined;
    const row = this.#database.prepare(`
      SELECT owner_id, pet_id, smart_wallet_address, environment, chain_id,
        smart_wallet_type, owner_type, expected_policy_digest, expected_policy_json,
        status, signer_status, last_verified_at
      FROM wallet_control_bindings
      WHERE owner_id = ? AND pet_id = ?
        AND status IN ('active', 'recovered')
        AND signer_status = 'attached'
        AND smart_wallet_address IS NOT NULL
        AND last_verified_at IS NOT NULL
    `).get(ownerId, petId) as VerifiedWalletRow | undefined;
    if (!row) return undefined;

    let policy: PrivyAgentSignerPolicy;
    try {
      policy = JSON.parse(row.expected_policy_json) as PrivyAgentSignerPolicy;
    } catch {
      throw new Error('Verified wallet directory contains an invalid policy');
    }
    if (row.environment !== 'sandbox' || row.chain_id !== BASE_SEPOLIA_CHAIN_ID ||
      !['embedded_hd', 'safe'].includes(row.smart_wallet_type) || row.owner_type !== 'privy_user' ||
      !validAddress(row.smart_wallet_address) || !validTimestamp(row.last_verified_at) ||
      policyDigest(policy) !== row.expected_policy_digest) {
      throw new Error('Verified wallet directory contains an unsafe binding');
    }
    const duplicate = this.#database.prepare(`
      SELECT pet_id
      FROM wallet_control_bindings
      WHERE owner_id = ? AND pet_id <> ? AND lower(smart_wallet_address) = lower(?)
      LIMIT 1
    `).get(ownerId, petId, row.smart_wallet_address) as { pet_id: string } | undefined;
    if (duplicate) throw new Error('Verified wallet address is assigned to more than one pet');

    return {
      ownerId: row.owner_id,
      petId: row.pet_id,
      address: row.smart_wallet_address.toLowerCase() as `0x${string}`,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifiedAt: row.last_verified_at,
    };
  }
}
