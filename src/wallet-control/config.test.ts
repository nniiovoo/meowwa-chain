import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC } from './policy.js';
import { loadWalletControlConfig } from './config.js';

const valid = {
  NODE_ENV: 'development',
  MEOWWA_WALLET_CONTROL_ENABLED: 'true',
  MEOWWA_WALLET_CONTROL_DB: './data/wallet-control.sqlite',
  MEOWWA_PRIVY_OWNER_ID: 'did:privy:owner_123',
  PRIVY_APP_ID: 'app_123',
  PRIVY_APP_SECRET: 'privy-secret',
  PRIVY_JWT_VERIFICATION_KEY: '-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----',
  MEOWWA_PRIVY_AGENT_SIGNER_ID: 'quorum_agent_123',
  MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: '0x2222222222222222222222222222222222222222,0x1111111111111111111111111111111111111111',
  MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '25000000',
  MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '86400',
};

describe('wallet control configuration', () => {
  it('is disabled by default and loads an explicit Base Sepolia-only sandbox', () => {
    expect(loadWalletControlConfig({ NODE_ENV: 'development' })).toEqual({ enabled: false });
    expect(loadWalletControlConfig(valid)).toEqual({
      enabled: true,
      databasePath: './data/wallet-control.sqlite',
      privyOwnerId: 'did:privy:owner_123',
      privyAppId: 'app_123',
      privyAppSecret: 'privy-secret',
      privyJwtVerificationKey: valid.PRIVY_JWT_VERIFICATION_KEY,
      agentSignerId: 'quorum_agent_123',
      allowedRecipients: [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
      ],
      perTransactionLimitAtomic: '25000000',
      maxDurationSeconds: 86400,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      usdcContract: BASE_SEPOLIA_USDC,
    });
  });

  it('refuses sandbox control-plane activation in production', () => {
    expect(() => loadWalletControlConfig({ ...valid, NODE_ENV: 'production' })).toThrow('cannot be enabled in production');
  });

  it('rejects invalid flags, partial configuration, and an in-memory or shared funding database', () => {
    expect(loadWalletControlConfig({
      MEOWWA_WALLET_CONTROL_ENABLED: 'false',
      MEOWWA_PRIVY_AGENT_SIGNER_ID: 'quorum_agent_123',
    })).toEqual({ enabled: false });
    expect(() => loadWalletControlConfig({ MEOWWA_WALLET_CONTROL_ENABLED: 'yes' })).toThrow('must be true or false');
    expect(() => loadWalletControlConfig({ MEOWWA_WALLET_CONTROL_DB: './control.sqlite' })).toThrow('requires MEOWWA_WALLET_CONTROL_ENABLED=true');
    expect(() => loadWalletControlConfig({ ...valid, PRIVY_APP_SECRET: '' })).toThrow('PRIVY_APP_SECRET');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_WALLET_CONTROL_DB: ':memory:' })).toThrow('must be durable');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_FUNDING_DB: './data/wallet-control.sqlite' })).toThrow('separate from MEOWWA_FUNDING_DB');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_STATE_DB: './data/wallet-control.sqlite' })).toThrow('separate from MEOWWA_STATE_DB');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_JOB_DB: './data/wallet-control.sqlite' })).toThrow('separate from MEOWWA_JOB_DB');
    expect(() => loadWalletControlConfig({
      ...valid, MEOWWA_WALLET_CONTROL_DB: resolve('./meowwa.sqlite'), MEOWWA_STATE_DB: undefined,
    })).toThrow('separate from MEOWWA_STATE_DB');
  });

  it('accepts only a key-quorum ID, never raw authorization key material', () => {
    for (const agentSignerId of [
      // secret-scan: allow-test-fixture — proves that raw private keys are rejected.
      '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
      `0x${'a'.repeat(64)}`,
      'a'.repeat(64),
      '{"private_key":"secret"}',
    ]) {
      expect(() => loadWalletControlConfig({ ...valid, MEOWWA_PRIVY_AGENT_SIGNER_ID: agentSignerId })).toThrow('key quorum ID');
    }
  });

  it('validates and bounds recipients, atomic limits, and authorization duration', () => {
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: '' })).toThrow('ALLOWED_RECIPIENTS');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: 'not-an-address' })).toThrow('recipient');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '0' })).toThrow('positive integer');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '1000000001' })).toThrow('safety ceiling');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '300' })).toThrow('between 3600 and 2592000');
    expect(() => loadWalletControlConfig({ ...valid, MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '2592001' })).toThrow('between 3600 and 2592000');
  });
});
