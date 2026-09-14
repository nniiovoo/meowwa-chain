import { describe, expect, it } from 'vitest';
import { loadControlledMerchantConfig } from './config.js';

const enabled = {
  NODE_ENV: 'test',
  MEOWWA_CONTROLLED_MERCHANT_ENABLED: 'true',
  MEOWWA_CONTROLLED_MERCHANT_DB: '/tmp/meowwa-controlled-merchant.sqlite',
  MEOWWA_CONTROLLED_MERCHANT_RPC_URL: 'https://base-sepolia.example/rpc/key',
  MEOWWA_CONTROLLED_MERCHANT_API_KEY: 'merchant_abcdefghijklmnopqrstuvwxyz012345',
  MEOWWA_CONTROLLED_MERCHANT_KEY_FILE: '/run/secrets/merchant-private-key',
  MEOWWA_CONTROLLED_MERCHANT_RECIPIENT: `0x${'4'.repeat(40)}`,
  MEOWWA_CONTROLLED_MERCHANT_PROVIDER_REVISION: 'poc-merchant-2026-07-17',
  MEOWWA_CONTROLLED_MERCHANT_ENVIRONMENT: 'staging',
  MEOWWA_CONTROLLED_MERCHANT_CONFIRMATIONS: '2',
  MEOWWA_CONTROLLED_MERCHANT_HOST: '127.0.0.1',
  MEOWWA_CONTROLLED_MERCHANT_PORT: '4010',
};

describe('controlled merchant configuration', () => {
  it('is disabled by default and rejects partial operational configuration', () => {
    expect(loadControlledMerchantConfig({})).toEqual({ enabled: false });
    expect(() => loadControlledMerchantConfig({ MEOWWA_CONTROLLED_MERCHANT_DB: '/tmp/data.sqlite' })).toThrow('requires');
  });

  it('allows inert pre-staged values only behind an explicit false flag', () => {
    expect(loadControlledMerchantConfig({
      ...enabled,
      MEOWWA_CONTROLLED_MERCHANT_ENABLED: 'false',
    })).toEqual({ enabled: false });
    const partial = { ...enabled, MEOWWA_CONTROLLED_MERCHANT_ENABLED: undefined };
    expect(() => loadControlledMerchantConfig(partial)).toThrow('requires MEOWWA_CONTROLLED_MERCHANT_ENABLED=true');
  });

  it('loads an explicit isolated POC merchant configuration', () => {
    expect(loadControlledMerchantConfig(enabled)).toEqual({
      enabled: true,
      databasePath: '/tmp/meowwa-controlled-merchant.sqlite',
      rpcUrl: 'https://base-sepolia.example/rpc/key',
      apiKey: 'merchant_abcdefghijklmnopqrstuvwxyz012345',
      keyPath: '/run/secrets/merchant-private-key',
      recipient: `0x${'4'.repeat(40)}`,
      providerRevision: 'poc-merchant-2026-07-17',
      confirmations: 2,
      host: '127.0.0.1',
      port: 4010,
    });
  });

  it('refuses production, shared durability, weak keys, and non-HTTPS RPC', () => {
    expect(() => loadControlledMerchantConfig({ ...enabled, MEOWWA_CONTROLLED_MERCHANT_ENVIRONMENT: 'production' })).toThrow('must be staging');
    expect(() => loadControlledMerchantConfig({
      ...enabled,
      MEOWWA_MERCHANT_RECONCILIATION_DB: enabled.MEOWWA_CONTROLLED_MERCHANT_DB,
    })).toThrow('separate');
    expect(() => loadControlledMerchantConfig({ ...enabled, MEOWWA_CONTROLLED_MERCHANT_API_KEY: 'merchant_short' })).toThrow('invalid');
    expect(() => loadControlledMerchantConfig({ ...enabled, NODE_ENV: 'development', MEOWWA_CONTROLLED_MERCHANT_RPC_URL: 'http://localhost:8545' })).toThrow('HTTPS');
  });
});
