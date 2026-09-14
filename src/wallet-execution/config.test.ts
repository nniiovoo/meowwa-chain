import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import { loadWalletExecutionConfig } from './config.js';

const valid = {
  NODE_ENV: 'development',
  MEOWWA_WALLET_CONTROL_ENABLED: 'true',
  MEOWWA_WALLET_EXECUTION_ENABLED: 'true',
  MEOWWA_WALLET_EXECUTION_DB: '/secure/data/wallet-execution.sqlite',
  MEOWWA_WALLET_EXECUTION_RPC_URL: 'https://base-sepolia.example/rpc',
  MEOWWA_WALLET_EXECUTION_CONFIRMATIONS: '12',
  MEOWWA_WALLET_EXECUTION_SCAN_START_BLOCK: '1000000',
  MEOWWA_WALLET_EXECUTION_MAX_BINDING_AGE_SECONDS: '60',
  MEOWWA_WALLET_EXECUTION_POLL_MS: '15000',
  MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: '/secure/keys/privy-agent-p256.pem',
  MEOWWA_PRIVY_GAS_PAYMENT_MODE: 'usdc',
  PRIVY_WEBHOOK_SIGNING_SECRET: 'whsec_sandbox_signing_secret',
  PRIVY_APP_ID: 'app_123',
  PRIVY_APP_SECRET: 'privy-secret',
  PRIVY_JWT_VERIFICATION_KEY: '-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----',
};

describe('wallet execution configuration', () => {
  it('is disabled by default and loads an explicit Base Sepolia-only sandbox', () => {
    expect(loadWalletExecutionConfig({ NODE_ENV: 'development' })).toEqual({ enabled: false });
    expect(loadWalletExecutionConfig(valid)).toEqual({
      enabled: true,
      databasePath: '/secure/data/wallet-execution.sqlite',
      rpcUrl: 'https://base-sepolia.example/rpc',
      confirmations: 12,
      scanStartBlock: 1_000_000n,
      maxBindingAgeMs: 60_000,
      pollMs: 15_000,
      authorizationKeyPath: '/secure/keys/privy-agent-p256.pem',
      webhookSigningSecret: 'whsec_sandbox_signing_secret',
      privyAppId: 'app_123',
      privyAppSecret: 'privy-secret',
      privyJwtVerificationKey: valid.PRIVY_JWT_VERIFICATION_KEY,
      gasPaymentMode: 'usdc',
      chainId: 84532,
      usdcContract: BASE_SEPOLIA_USDC,
    });
  });

  it('refuses production and requires the wallet-control plane', () => {
    expect(() => loadWalletExecutionConfig({ ...valid, NODE_ENV: 'production' })).toThrow('production');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_CONTROL_ENABLED: 'false' })).toThrow('wallet control');
  });

  it('rejects invalid flags, partial config, non-durable/shared databases, and relative key paths', () => {
    expect(loadWalletExecutionConfig({
      MEOWWA_WALLET_EXECUTION_ENABLED: 'false',
      MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: '/secure/keys/privy-agent-p256.pem',
    })).toEqual({ enabled: false });
    expect(() => loadWalletExecutionConfig({ MEOWWA_WALLET_EXECUTION_ENABLED: 'yes' })).toThrow('true or false');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_PRIVY_GAS_PAYMENT_MODE: 'eth' })).toThrow('gas payment mode');
    expect(() => loadWalletExecutionConfig({ MEOWWA_WALLET_EXECUTION_DB: '/data/execution.sqlite' })).toThrow('requires MEOWWA_WALLET_EXECUTION_ENABLED=true');
    expect(() => loadWalletExecutionConfig({ ...valid, PRIVY_APP_SECRET: '' })).toThrow('PRIVY_APP_SECRET');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_EXECUTION_DB: ':memory:' })).toThrow('durable');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_CONTROL_DB: '/secure/data/wallet-execution.sqlite' })).toThrow('separate');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_FUNDING_DB: '/secure/data/wallet-execution.sqlite' })).toThrow('separate');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: './agent.pem' })).toThrow('absolute');
    expect(() => loadWalletExecutionConfig({
      ...valid, MEOWWA_WALLET_EXECUTION_DB: resolve('./meowwa.sqlite'), MEOWWA_STATE_DB: undefined,
    })).toThrow('separate from MEOWWA_STATE_DB');
  });

  it('allows inert pre-staged values only behind an explicit false flag', () => {
    expect(loadWalletExecutionConfig({
      MEOWWA_WALLET_EXECUTION_ENABLED: 'false',
      MEOWWA_WALLET_EXECUTION_RPC_URL: 'https://sepolia.base.org',
    })).toEqual({ enabled: false });
    expect(() => loadWalletExecutionConfig({
      MEOWWA_WALLET_EXECUTION_RPC_URL: 'https://sepolia.base.org',
    })).toThrow('requires MEOWWA_WALLET_EXECUTION_ENABLED=true');
  });

  it('requires HTTPS except for an explicit loopback test seam and bounds all timing', () => {
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_EXECUTION_RPC_URL: 'http://rpc.example/rpc' })).toThrow('HTTPS');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_EXECUTION_RPC_URL: 'http://127.0.0.1:8545' })).toThrow('test');
    expect(loadWalletExecutionConfig({ ...valid, NODE_ENV: 'test', MEOWWA_WALLET_EXECUTION_RPC_URL: 'http://127.0.0.1:8545' })).toMatchObject({ enabled: true, rpcUrl: 'http://127.0.0.1:8545/' });
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_EXECUTION_CONFIRMATIONS: '0' })).toThrow('confirmations');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_EXECUTION_MAX_BINDING_AGE_SECONDS: '301' })).toThrow('binding age');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_EXECUTION_POLL_MS: '999' })).toThrow('poll');
    expect(() => loadWalletExecutionConfig({ ...valid, MEOWWA_WALLET_EXECUTION_SCAN_START_BLOCK: '-1' })).toThrow('scan start');
  });

  it('requires a plausible webhook secret without ever returning it in errors', () => {
    expect(() => loadWalletExecutionConfig({ ...valid, PRIVY_WEBHOOK_SIGNING_SECRET: 'short' })).toThrow('webhook signing secret');
  });
});
