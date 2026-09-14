import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createPrivyClient,
  MAX_OWNER_MESSAGE_CHARACTERS,
  PrivyOwnerVerifier,
  type PrivyUserRecord,
} from './privy.js';
import { MAX_STEP_UP_MESSAGE_CHARACTERS } from '../modules/sandbox-auth.js';

const user = (linkedAccounts: Array<Record<string, unknown>> = []): PrivyUserRecord => ({
  id: 'did:privy:owner_123', linked_accounts: linkedAccounts,
});

describe('Privy client construction', () => {
  it('bounds every Privy call inside the API connection deadline', () => {
    // Unbounded, the SDK defaults to 60 s per attempt with 2 retries -- ~181 s for one logical call.
    // The client socket is severed at 10 s and Fastify never cancels the handler, so a Privy
    // brownout left handlers issuing wallet writes for minutes after the owner was told it failed.
    const { privyApiClient } = createPrivyClient({
      appId: 'app_123', appSecret: 'secret', jwtVerificationKey: 'public-key',
    }) as unknown as { privyApiClient: { timeout: number; maxRetries: number } };
    // Worst case for one logical call must stay inside the 10 s connection deadline.
    expect(privyApiClient.timeout * (privyApiClient.maxRetries + 1)).toBeLessThan(10_000);
  });

  it('uses the app-scoped remote JWKS when no legacy key override is configured', () => {
    expect(() => createPrivyClient({ appId: 'app_123', appSecret: 'secret' })).not.toThrow();
  });
});

describe('Privy owner verification', () => {
  it('verifies access tokens with the configured app and verification key', async () => {
    const verify = vi.fn(async () => ({ user_id: 'did:privy:owner_123', app_id: 'app_123' }));
    const verifier = new PrivyOwnerVerifier({ appId: 'app_123', verificationKey: 'public-key', verifyAccessToken: verify });
    await expect(verifier.verify('privy-access-token')).resolves.toEqual({ privyUserId: 'did:privy:owner_123' });
    expect(verify).toHaveBeenCalledWith({ access_token: 'privy-access-token', app_id: 'app_123', verification_key: 'public-key' });
  });

  it('fails closed if Privy returns a token for another app or no user', async () => {
    const wrongApp = new PrivyOwnerVerifier({ appId: 'app_123', verificationKey: 'public-key', verifyAccessToken: async () => ({ user_id: 'did:privy:owner_123', app_id: 'app_other' }) });
    await expect(wrongApp.verify('token')).rejects.toThrow('Privy access token app does not match');
    const missingUser = new PrivyOwnerVerifier({ appId: 'app_123', verificationKey: 'public-key', verifyAccessToken: async () => ({ user_id: '', app_id: 'app_123' }) });
    await expect(missingUser.verify('token')).rejects.toThrow('Privy access token has no user');
  });

  it('accepts a remote JWKS verifier without a static verification key', async () => {
    const verify = vi.fn(async () => ({ user_id: 'did:privy:owner_123', app_id: 'app_123' }));
    const verifier = new PrivyOwnerVerifier({ appId: 'app_123', accessTokenVerifier: verify });
    await expect(verifier.verify('privy-access-token')).resolves.toEqual({ privyUserId: 'did:privy:owner_123' });
    expect(verify).toHaveBeenCalledWith('privy-access-token');
  });

  it('verifies an EIP-191 step-up signature against a wallet linked to the Privy owner', async () => {
    const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
    const message = 'MeowWa owner step-up v1\nAction: emergency-clear\nResource: owner_1';
    const signature = await account.signMessage({ message });
    const verifier = new PrivyOwnerVerifier({
      appId: 'app_123', verificationKey: 'public-key',
      verifyAccessToken: async () => ({ user_id: 'did:privy:owner_123', app_id: 'app_123' }),
      userApi: { getUser: async () => user([{ type: 'wallet', chain_type: 'ethereum', address: account.address }]) },
    });
    await expect(verifier.verifyMessage('privy-access-token', message, signature)).resolves.toBe(true);
    await expect(verifier.verifyMessage('privy-access-token', message, `${signature.slice(0, -2)}00`)).resolves.toBe(false);
  });

  it('proves owner identity with the linked EVM key only: a Solana pet wallet is a rail, not the owner', async () => {
    const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
    const message = 'MeowWa owner step-up v1\nAction: emergency-clear\nResource: owner_1';
    const signature = await account.signMessage({ message });
    const solanaOnly = new PrivyOwnerVerifier({
      appId: 'app_123', verificationKey: 'public-key',
      verifyAccessToken: async () => ({ user_id: 'did:privy:owner_123', app_id: 'app_123' }),
      userApi: { getUser: async () => user([{ type: 'wallet', chain_type: 'solana', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }]) },
    });
    await expect(solanaOnly.verifyMessage('privy-access-token', message, signature)).resolves.toBe(false);
    const both = new PrivyOwnerVerifier({
      appId: 'app_123', verificationKey: 'public-key',
      verifyAccessToken: async () => ({ user_id: 'did:privy:owner_123', app_id: 'app_123' }),
      userApi: { getUser: async () => user([
        { type: 'wallet', chain_type: 'solana', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { type: 'wallet', chain_type: 'ethereum', address: account.address },
      ]) },
    });
    await expect(both.verifyMessage('privy-access-token', message, signature)).resolves.toBe(true);
    // A base58 value is never a step-up signature here.
    await expect(both.verifyMessage('privy-access-token', message, '5'.repeat(88))).resolves.toBe(false);
  });

  // This ceiling and the confirmation envelope were two independent numbers -- 512 here against a
  // message schema sized for 1024 -- and nothing exercised them together, because every route test
  // stubs `verifyMessage` to `async () => true`. The owner's own signature over their own policy
  // change was then refused for being too long, which fails closed and locks the money safety
  // controls out. The envelope is derived from its formatter now; this is the guard that keeps it
  // under what the verifier will look at.
  it('accepts an owner confirmation at the largest size the step-up envelope can mint', async () => {
    expect(MAX_STEP_UP_MESSAGE_CHARACTERS).toBeLessThanOrEqual(MAX_OWNER_MESSAGE_CHARACTERS);
    const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
    const verifier = new PrivyOwnerVerifier({
      appId: 'app_123', verificationKey: 'public-key',
      verifyAccessToken: async () => ({ user_id: 'did:privy:owner_123', app_id: 'app_123' }),
      userApi: { getUser: async () => user([{ type: 'wallet', chain_type: 'ethereum', address: account.address }]) },
    });

    const largest = 'm'.repeat(MAX_STEP_UP_MESSAGE_CHARACTERS);
    await expect(verifier.verifyMessage('privy-access-token', largest, await account.signMessage({ message: largest })))
      .resolves.toBe(true);
    // Still bounded: the ceiling exists to cap work on untrusted input.
    const oversized = 'm'.repeat(MAX_OWNER_MESSAGE_CHARACTERS + 1);
    await expect(verifier.verifyMessage('privy-access-token', oversized, await account.signMessage({ message: oversized })))
      .resolves.toBe(false);
  });
});
