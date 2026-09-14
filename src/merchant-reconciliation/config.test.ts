import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMerchantReconciliationConfig } from './config.js';

const enabled = {
  NODE_ENV: 'test',
  MEOWWA_MERCHANT_RECONCILIATION_ENABLED: 'true',
  MEOWWA_MERCHANT_RECONCILIATION_DB: '/tmp/meowwa-merchant.sqlite',
  MEOWWA_MERCHANT_GATEWAY_URL: 'https://merchant-gateway.example/v1/',
  MEOWWA_MERCHANT_GATEWAY_API_KEY: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
  MEOWWA_MERCHANT_WEBHOOK_SECRET: 'mwhsec_abcdefghijklmnopqrstuvwxyz0123456789',
  MEOWWA_MERCHANT_RPC_URL: 'https://base-sepolia.example/rpc',
  MEOWWA_MERCHANT_CONFIRMATIONS: '3',
  MEOWWA_MERCHANT_POLL_MS: '5000',
  MEOWWA_MERCHANT_QUOTE_REFRESH_MS: '60000',
} satisfies NodeJS.ProcessEnv;

describe('merchant reconciliation configuration', () => {
  it('is disabled by default', () => {
    expect(loadMerchantReconciliationConfig({ NODE_ENV: 'test' })).toEqual({ enabled: false });
  });

  it('loads an explicit sandbox configuration', () => {
    expect(loadMerchantReconciliationConfig(enabled)).toMatchObject({
      enabled: true,
      databasePath: '/tmp/meowwa-merchant.sqlite',
      gatewayUrl: 'https://merchant-gateway.example/v1/',
      confirmations: 3,
      pollMs: 5000,
      quoteRefreshMs: 60000,
      chainId: 84532,
    });
  });

  it('refuses production and partial or shared configuration', () => {
    expect(() => loadMerchantReconciliationConfig({ ...enabled, NODE_ENV: 'production' })).toThrow('refused in production');
    expect(() => loadMerchantReconciliationConfig({ NODE_ENV: 'test', MEOWWA_MERCHANT_RECONCILIATION_DB: '/tmp/x.sqlite' })).toThrow('requires');
    expect(() => loadMerchantReconciliationConfig({ ...enabled, MEOWWA_STATE_DB: '/tmp/meowwa-merchant.sqlite' })).toThrow('separate');
    expect(() => loadMerchantReconciliationConfig({
      ...enabled,
      MEOWWA_MERCHANT_RECONCILIATION_DB: resolve('./meowwa.sqlite'),
      MEOWWA_STATE_DB: undefined,
    })).toThrow('separate from MEOWWA_STATE_DB');
    expect(() => loadMerchantReconciliationConfig({
      ...enabled,
      MEOWWA_MERCHANT_RECONCILIATION_DB: resolve('./meowwa.jobs.sqlite'),
      MEOWWA_JOB_DB: undefined,
    })).toThrow('separate from MEOWWA_JOB_DB');
  });

  it('allows inert pre-staged values only behind an explicit false flag', () => {
    expect(loadMerchantReconciliationConfig({
      ...enabled,
      MEOWWA_MERCHANT_RECONCILIATION_ENABLED: 'false',
    })).toEqual({ enabled: false });
    const partial = { ...enabled, MEOWWA_MERCHANT_RECONCILIATION_ENABLED: undefined };
    expect(() => loadMerchantReconciliationConfig(partial)).toThrow('requires MEOWWA_MERCHANT_RECONCILIATION_ENABLED=true');
  });

  it('requires HTTPS remote endpoints and bounded strong credentials', () => {
    expect(() => loadMerchantReconciliationConfig({ ...enabled, MEOWWA_MERCHANT_GATEWAY_URL: 'http://merchant.example/v1' })).toThrow('HTTPS');
    expect(() => loadMerchantReconciliationConfig({ ...enabled, MEOWWA_MERCHANT_RPC_URL: 'http://base.example/rpc' })).toThrow('HTTPS');
    expect(() => loadMerchantReconciliationConfig({ ...enabled, MEOWWA_MERCHANT_WEBHOOK_SECRET: 'short' })).toThrow('webhook secret');
    expect(() => loadMerchantReconciliationConfig({ ...enabled, MEOWWA_MERCHANT_CONFIRMATIONS: '1' })).toThrow('confirmations');
  });
});
