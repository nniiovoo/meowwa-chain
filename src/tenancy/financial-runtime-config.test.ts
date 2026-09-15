import { describe, expect, it } from 'vitest';
import {
  loadTenantFinancialWorkerRuntimeConfig,
  loadTenantFundingApiConfig,
  loadTenantMerchantApiConfig,
  loadTenantMerchantWorkerRuntimeConfig,
  loadTenantWalletExecutionApiConfig,
  loadTenantWalletProvisioningApiConfig,
  loadTenantWalletProvisionerRuntimeConfig,
} from './financial-runtime-config.js';

/**
 * Covers the loaders that gate each financial workload's startup: which secrets are required, which
 * are refused, whether a live or test Stripe key is allowed for the release environment, and which
 * funding rails a worker will serve. A loader that accepts too much starts a workload pointed at
 * the wrong network or the wrong key; one that accepts too little will not start at all.
 */
const tenantId = '11111111-1111-4111-8111-111111111111';
const provisionerToken = Buffer.alloc(32, 7).toString('base64');
const settlementToken = Buffer.alloc(32, 8).toString('base64');
const merchantToken = Buffer.alloc(32, 9).toString('base64');
const merchantSettlementToken = Buffer.alloc(32, 10).toString('base64');

describe('tenant financial workload configuration', () => {
  it('keeps owner funding routes absent unless explicitly enabled', () => {
    expect(loadTenantFundingApiConfig({ NODE_ENV: 'production' })).toEqual({ enabled: false });
    expect(() => loadTenantFundingApiConfig({ NODE_ENV: 'production', MEOWWA_TENANT_FUNDING_API_ENABLED: 'yes' }))
      .toThrow('true or false');
  });

  it('loads only the provisioner boundary for the local wallet evidence exercise', () => {
    expect(loadTenantWalletProvisioningApiConfig({ NODE_ENV: 'development' })).toEqual({ enabled: false });
    expect(loadTenantWalletProvisioningApiConfig({
      NODE_ENV: 'development',
      MEOWWA_RELEASE_ENVIRONMENT: 'development',
      MEOWWA_DEVELOPMENT_WALLET_PROVISIONING_EXERCISE: 'true',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
    })).toEqual({
      enabled: true,
      walletProvisionerUrl: 'http://127.0.0.1:4002',
      walletProvisionerToken: provisionerToken,
      requestTimeoutMs: 5_000,
    });
  });

  it('rejects the local wallet evidence exercise outside development', () => {
    expect(() => loadTenantWalletProvisioningApiConfig({
      NODE_ENV: 'production',
      MEOWWA_RELEASE_ENVIRONMENT: 'production',
      MEOWWA_DEVELOPMENT_WALLET_PROVISIONING_EXERCISE: 'true',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
    })).toThrow('available only in development');
  });

  it('loads a live production funding API without giving it the Stripe webhook secret', () => {
    expect(loadTenantFundingApiConfig({
      NODE_ENV: 'production',
      MEOWWA_TENANT_FUNDING_API_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_live_example',
      MEOWWA_WALLET_PROVISIONER_URL: 'https://wallet-provisioner.internal.example',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS: '5000',
      BASE_CHAIN_ID: '8453',
      BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    })).toEqual({
      enabled: true,
      stripeSecretKey: 'sk_live_example',
      stripeLivemode: true,
      fundingChains: ['base'],
      walletProvisionerUrl: 'https://wallet-provisioner.internal.example',
      walletProvisionerToken: provisionerToken,
      requestTimeoutMs: 5000,
    });
  });

  it('refuses the funding API when the withdrawal chain configuration is missing or wrong', () => {
    // The withdrawal route derives its chain and token from here, so a funding API that loads
    // without them would hand owners a transfer on a chain nobody validated.
    const base = {
      NODE_ENV: 'production', MEOWWA_TENANT_FUNDING_API_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_live_example',
      MEOWWA_WALLET_PROVISIONER_URL: 'https://provisioner.example',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
    };
    expect(() => loadTenantFundingApiConfig(base)).toThrow('BASE_CHAIN_ID is required');
    expect(() => loadTenantFundingApiConfig({ ...base, BASE_CHAIN_ID: '84532' })).toThrow('must be 8453');
    expect(() => loadTenantFundingApiConfig({
      ...base, BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x1111111111111111111111111111111111111111',
    })).toThrow('canonical Base USDC');
  });

  it('rejects a test Stripe key or plaintext provisioner transport in production', () => {
    const base = {
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', MEOWWA_TENANT_FUNDING_API_ENABLED: 'true',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };
    expect(() => loadTenantFundingApiConfig({
      ...base, STRIPE_SECRET_KEY: 'sk_test_example', MEOWWA_WALLET_PROVISIONER_URL: 'https://provisioner.example',
    })).toThrow('live key');
    expect(() => loadTenantFundingApiConfig({
      ...base, STRIPE_SECRET_KEY: 'sk_live_example', MEOWWA_WALLET_PROVISIONER_URL: 'http://provisioner.example',
    })).toThrow('HTTPS');
  });

  it('requires Stripe test mode in staging and live mode only in production', () => {
    const base = {
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'staging', MEOWWA_TENANT_FUNDING_API_ENABLED: 'true',
      MEOWWA_WALLET_PROVISIONER_URL: 'https://provisioner.example',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };
    expect(loadTenantFundingApiConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_example' })).toMatchObject({
      enabled: true,
      stripeLivemode: false,
    });
    expect(() => loadTenantFundingApiConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_example' }))
      .toThrow('must be a test key outside production');
  });

  it('allows only the wallet provisioner Kubernetes service and port over production HTTP', () => {
    const base = {
      NODE_ENV: 'production', MEOWWA_TENANT_FUNDING_API_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_live_example', MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };
    expect(loadTenantFundingApiConfig({
      ...base,
      MEOWWA_WALLET_PROVISIONER_URL: 'http://wallet-provisioner.example-namespace.svc.cluster.local:4002',
    })).toMatchObject({
      walletProvisionerUrl: 'http://wallet-provisioner.example-namespace.svc.cluster.local:4002',
    });
    for (const url of [
      'http://wallet-provisioner.example-namespace.svc.cluster.local:4003',
      'http://wallet-provisioner.example-namespace.svc.cluster.local.attacker:4002',
      'http://wallet-provisioner.example:4002',
    ]) expect(() => loadTenantFundingApiConfig({ ...base, MEOWWA_WALLET_PROVISIONER_URL: url })).toThrow('HTTPS');
  });

  it('keeps tenant wallet execution absent by default and loads only an authenticated HTTPS service boundary', () => {
    expect(loadTenantWalletExecutionApiConfig({ NODE_ENV: 'production' })).toEqual({ enabled: false });
    expect(loadTenantWalletExecutionApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_WALLET_EXECUTION_ENABLED: 'true',
      MEOWWA_WALLET_PROVISIONER_URL: 'https://wallet-provisioner.internal.example',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken, MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS: '5000',
      MEOWWA_WALLET_SETTLEMENT_TOKEN: settlementToken,
    })).toEqual({
      enabled: true, walletServiceUrl: 'https://wallet-provisioner.internal.example',
      walletServiceToken: provisionerToken, settlementAuthSecret: settlementToken, requestTimeoutMs: 5000,
    });
    expect(() => loadTenantWalletExecutionApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_WALLET_EXECUTION_ENABLED: 'true',
      MEOWWA_WALLET_PROVISIONER_URL: 'http://wallet-provisioner.internal.example',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken, MEOWWA_WALLET_SETTLEMENT_TOKEN: settlementToken,
    })).toThrow('HTTPS');
    expect(() => loadTenantWalletExecutionApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_WALLET_EXECUTION_ENABLED: 'true',
      MEOWWA_WALLET_PROVISIONER_URL: 'https://wallet-provisioner.internal.example',
      MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken, MEOWWA_WALLET_SETTLEMENT_TOKEN: provisionerToken,
    })).toThrow('must be distinct');
  });

  it('loads tenant commerce only across separately authenticated HTTPS service boundaries', () => {
    expect(loadTenantMerchantApiConfig({ NODE_ENV: 'production' })).toEqual({ enabled: false });
    expect(loadTenantMerchantApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_SERVICE_URL: 'https://merchant.internal.example',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
    })).toEqual({
      enabled: true, merchantServiceUrl: 'https://merchant.internal.example',
      merchantServiceToken: merchantToken, settlementAuthSecret: merchantSettlementToken, requestTimeoutMs: 5000,
    });
    expect(() => loadTenantMerchantApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_SERVICE_URL: 'http://merchant.internal.example',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
    })).toThrow('HTTPS');
    expect(() => loadTenantMerchantApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_SERVICE_URL: 'https://merchant.internal.example',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantToken,
    })).toThrow('distinct');
    expect(() => loadTenantMerchantApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_SERVICE_URL: 'https://merchant.internal.example',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: settlementToken,
      MEOWWA_WALLET_SETTLEMENT_TOKEN: settlementToken,
    })).toThrow('every wallet credential');
  });

  it('allows only the merchant worker Kubernetes service and port over production HTTP', () => {
    const base = {
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
    };
    expect(loadTenantMerchantApiConfig({
      ...base,
      MEOWWA_MERCHANT_SERVICE_URL: 'http://merchant-worker.example-namespace.svc.cluster.local:4004',
    })).toMatchObject({ merchantServiceUrl: 'http://merchant-worker.example-namespace.svc.cluster.local:4004' });
    expect(() => loadTenantMerchantApiConfig({
      ...base,
      MEOWWA_MERCHANT_SERVICE_URL: 'http://merchant-worker.example-namespace.svc.cluster.local:4002',
    })).toThrow('HTTPS');
  });

  it('loads a separately authenticated Privy provisioner runtime', () => {
    expect(loadTenantWalletProvisionerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', PRIVY_APP_ID: 'app_id', PRIVY_APP_SECRET: 'privy-secret',
      PRIVY_JWT_VERIFICATION_KEY: 'jwt-key', MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      MEOWWA_PRIVY_AGENT_SIGNER_ID: 'quorum_agent_123',
      MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: '0x1111111111111111111111111111111111111111',
      MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '10000000',
      MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '86400',
      MEOWWA_WALLET_PROVISIONER_HOST: '0.0.0.0', MEOWWA_WALLET_PROVISIONER_PORT: '4002',
    })).toMatchObject({
      privyAppId: 'app_id', privyAppSecret: 'privy-secret', privyJwtVerificationKey: 'jwt-key',
      agentSignerId: 'quorum_agent_123', allowedRecipients: ['0x1111111111111111111111111111111111111111'],
      perTransactionLimitAtomic: '10000000', maxDurationSeconds: 86400, productionFunding: true,
      internalAuthToken: provisionerToken, host: '0.0.0.0', port: 4002,
    });
  });

  it('fails closed when the isolated wallet workload release environment is absent or inconsistent', () => {
    const valid = {
      PRIVY_APP_ID: 'app_id', PRIVY_APP_SECRET: 'privy-secret',
      PRIVY_JWT_VERIFICATION_KEY: 'jwt-key', MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      MEOWWA_PRIVY_AGENT_SIGNER_ID: 'quorum_agent_123',
      MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: '0x1111111111111111111111111111111111111111',
      MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '10000000',
      MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '86400',
    };

    expect(() => loadTenantWalletProvisionerRuntimeConfig({ ...valid, NODE_ENV: 'production' }))
      .toThrow('MEOWWA_RELEASE_ENVIRONMENT');
    expect(() => loadTenantWalletProvisionerRuntimeConfig({
      ...valid, NODE_ENV: 'development', MEOWWA_RELEASE_ENVIRONMENT: 'production',
    })).toThrow('inconsistent');
    expect(() => loadTenantWalletProvisionerRuntimeConfig({
      ...valid, NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'test',
    })).toThrow('inconsistent');
    expect(loadTenantWalletProvisionerRuntimeConfig({
      ...valid, NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'staging',
    }).productionFunding).toBe(false);
    expect(() => loadTenantWalletProvisionerRuntimeConfig({
      ...valid, NODE_ENV: 'development', MEOWWA_RELEASE_ENVIRONMENT: 'preview',
    })).toThrow('must be development, test, staging, or production');
  });

  it('enables tenant execution in the isolated wallet workload only with its P-256 key path', () => {
    const base = {
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', PRIVY_APP_ID: 'app_id', PRIVY_APP_SECRET: 'privy-secret',
      PRIVY_JWT_VERIFICATION_KEY: 'jwt-key', MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      MEOWWA_PRIVY_AGENT_SIGNER_ID: 'quorum_agent_123',
      MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: '0x1111111111111111111111111111111111111111',
      MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '10000000',
      MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '86400',
      MEOWWA_TENANT_WALLET_EXECUTION_ENABLED: 'true',
      MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL: 'https://base-sepolia.example/rpc',
      PRIVY_WEBHOOK_SIGNING_SECRET: 'whsec_privy_example_signing_secret',
      MEOWWA_INTERNAL_API_URL: 'https://api.internal.example',
      MEOWWA_WALLET_SETTLEMENT_TOKEN: settlementToken,
      MEOWWA_PRIVY_GAS_PAYMENT_MODE: 'usdc',
    };
    expect(() => loadTenantWalletProvisionerRuntimeConfig(base)).toThrow('MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE');
    expect(loadTenantWalletProvisionerRuntimeConfig({
      ...base, MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: '/run/secrets/privy-p256.pem',
    }).execution).toEqual({
      enabled: true, authorizationKeyPath: '/run/secrets/privy-p256.pem',
      baseSepoliaRpcUrl: 'https://base-sepolia.example/rpc', webhookSigningSecret: 'whsec_privy_example_signing_secret',
      gasPaymentMode: 'usdc',
      confirmations: 12, pollMs: 15000, internalApiUrl: 'https://api.internal.example',
      settlementAuthSecret: settlementToken, requestTimeoutMs: 5000,
    });
    expect(() => loadTenantWalletProvisionerRuntimeConfig({
      ...base, MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: '/run/secrets/privy-p256.pem',
      MEOWWA_PRIVY_GAS_PAYMENT_MODE: 'eth',
    })).toThrow('must be usdc');
    expect(() => loadTenantWalletProvisionerRuntimeConfig({
      ...base, MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: '/run/secrets/privy-p256.pem',
      MEOWWA_WALLET_SETTLEMENT_TOKEN: provisionerToken,
    })).toThrow('must be distinct');
    expect(() => loadTenantWalletProvisionerRuntimeConfig({
      ...base, MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: '/run/secrets/privy-p256.pem',
      MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL: 'https://sepolia.base.org',
    })).toThrow('dedicated production provider');
  });

  it('allows the provisioner to call only the Kubernetes API service and port over production HTTP', () => {
    const config = loadTenantWalletProvisionerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', PRIVY_APP_ID: 'app_id', PRIVY_APP_SECRET: 'privy-secret',
      PRIVY_JWT_VERIFICATION_KEY: 'jwt-key', MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
      MEOWWA_PRIVY_AGENT_SIGNER_ID: 'quorum_agent_123',
      MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: '0x1111111111111111111111111111111111111111',
      MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '10000000',
      MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '86400',
      MEOWWA_TENANT_WALLET_EXECUTION_ENABLED: 'true',
      MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL: 'https://base-sepolia.example/rpc',
      PRIVY_WEBHOOK_SIGNING_SECRET: 'whsec_privy_example_signing_secret',
      MEOWWA_INTERNAL_API_URL: 'http://api.example-namespace.svc.cluster.local:4000',
      MEOWWA_WALLET_SETTLEMENT_TOKEN: settlementToken,
      MEOWWA_PRIVY_GAS_PAYMENT_MODE: 'usdc',
      MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE: '/run/secrets/privy-p256.pem',
    });
    expect(config.execution).toMatchObject({
      internalApiUrl: 'http://api.example-namespace.svc.cluster.local:4000',
    });
  });

  it('loads a dedicated signed-webhook and Base USDC financial worker runtime', () => {
    expect(loadTenantFinancialWorkerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', STRIPE_SECRET_KEY: 'sk_live_example',
      STRIPE_ONRAMP_WEBHOOK_SECRET: 'whsec_example',
      BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/private-key',
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      BASE_SCAN_START_BLOCK: '123', BASE_CONFIRMATIONS: '12',
      MEOWWA_FINANCIAL_WORKER_HOST: '0.0.0.0', MEOWWA_FINANCIAL_WORKER_PORT: '4003',
      MEOWWA_FINANCIAL_SCAN_MS: '15000', MEOWWA_FINANCIAL_MAX_SCAN_BLOCKS: '1999',
    })).toEqual({
      stripeSecretKey: 'sk_live_example', stripeWebhookSecret: 'whsec_example', stripeLivemode: true,
      rails: [{
        chainKey: 'base', rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/private-key',
        usdcAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', scanStartBlock: 123,
        confirmations: 12, maxScanBlocks: 1999,
      }],
      scanPollMs: 15000,
      reconcilePollMs: 300_000, diagnosticsToken: undefined,
      host: '0.0.0.0', port: 4003,
    });
  });

  it.each(['', ' '])('refuses a blank BASE_SCAN_START_BLOCK (%j) rather than scanning from genesis', (blank) => {
    // `Number('')` is 0, and this is the one integer() call site whose minimum is 0, so a blank
    // ConfigMap key or an unfilled `.env` line used to pass validation and seed the Base indexer
    // cursor at mainnet genesis -- a state only manual SQL can undo, because the cursor row is
    // written ON CONFLICT DO NOTHING and the indexer then refuses every corrected start block.
    const environment = {
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', STRIPE_SECRET_KEY: 'sk_live_example',
      STRIPE_ONRAMP_WEBHOOK_SECRET: 'whsec_example',
      BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/private-key',
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      BASE_CONFIRMATIONS: '12',
    };

    expect(() => loadTenantFinancialWorkerRuntimeConfig({ ...environment, BASE_SCAN_START_BLOCK: blank }))
      .toThrow('BASE_SCAN_START_BLOCK is invalid');
    expect(loadTenantFinancialWorkerRuntimeConfig({ ...environment, BASE_SCAN_START_BLOCK: '40000000' }).rails[0])
      .toMatchObject({ chainKey: 'base', scanStartBlock: 40_000_000 });
  });

  it('loads a staging financial worker only with a Stripe test key', () => {
    const base = {
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'staging',
      STRIPE_ONRAMP_WEBHOOK_SECRET: 'whsec_example',
      BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/private-key',
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      BASE_SCAN_START_BLOCK: '123', BASE_CONFIRMATIONS: '12',
    };
    expect(loadTenantFinancialWorkerRuntimeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_example' }))
      .toMatchObject({ stripeLivemode: false });
    expect(() => loadTenantFinancialWorkerRuntimeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_example' }))
      .toThrow('must be a test key outside production');
  });

  it('loads a dedicated tenant merchant worker without sharing wallet credentials', () => {
    expect(loadTenantMerchantWorkerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_GATEWAY_URL: 'https://merchant-gateway.example/v1/',
      MEOWWA_MERCHANT_GATEWAY_API_KEY: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      MEOWWA_MERCHANT_WEBHOOK_SECRET: 'mwhsec_abcdefghijklmnopqrstuvwxyz0123456789',
      MEOWWA_MERCHANT_RPC_URL: 'https://base-sepolia.example/rpc',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken, MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
      MEOWWA_INTERNAL_API_URL: 'https://api.internal.example',
    })).toMatchObject({
      gatewayUrl: 'https://merchant-gateway.example/v1/', baseSepoliaRpcUrl: 'https://base-sepolia.example/rpc',
      chainId: 84532, confirmations: 12, reconciliationPollMs: 15000, quoteRefreshMs: 60000,
      internalApiUrl: 'https://api.internal.example', internalServiceToken: merchantToken,
      settlementAuthSecret: merchantSettlementToken, host: '0.0.0.0', port: 4004,
    });
    expect(() => loadTenantMerchantWorkerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_GATEWAY_URL: 'https://merchant-gateway.example/v1/',
      MEOWWA_MERCHANT_GATEWAY_API_KEY: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      MEOWWA_MERCHANT_WEBHOOK_SECRET: 'mwhsec_abcdefghijklmnopqrstuvwxyz0123456789',
      MEOWWA_MERCHANT_RPC_URL: 'https://sepolia.base.org',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken, MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
      MEOWWA_INTERNAL_API_URL: 'https://api.internal.example',
    })).toThrow('dedicated production provider');
  });

  it('allows the merchant worker Kubernetes gateway and API endpoints over production HTTP', () => {
    expect(loadTenantMerchantWorkerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_GATEWAY_URL: 'http://controlled-merchant.example-namespace.svc.cluster.local:4010/v1/',
      MEOWWA_MERCHANT_GATEWAY_API_KEY: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      MEOWWA_MERCHANT_WEBHOOK_SECRET: 'mwhsec_abcdefghijklmnopqrstuvwxyz0123456789',
      MEOWWA_MERCHANT_RPC_URL: 'https://base-sepolia.example/rpc',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
      MEOWWA_INTERNAL_API_URL: 'http://api.example-namespace.svc.cluster.local:4000',
    })).toMatchObject({
      gatewayUrl: 'http://controlled-merchant.example-namespace.svc.cluster.local:4010/v1/',
      internalApiUrl: 'http://api.example-namespace.svc.cluster.local:4000',
    });
    expect(() => loadTenantMerchantWorkerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_GATEWAY_URL: 'http://controlled-merchant.example-namespace.svc.cluster.local:4011/v1/',
      MEOWWA_MERCHANT_GATEWAY_API_KEY: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      MEOWWA_MERCHANT_WEBHOOK_SECRET: 'mwhsec_abcdefghijklmnopqrstuvwxyz0123456789',
      MEOWWA_MERCHANT_RPC_URL: 'https://base-sepolia.example/rpc',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
      MEOWWA_INTERNAL_API_URL: 'http://api.example-namespace.svc.cluster.local:4000',
    })).toThrow('HTTPS');
    expect(() => loadTenantMerchantWorkerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_MERCHANT_ENABLED: 'true',
      MEOWWA_MERCHANT_GATEWAY_URL: 'http://controlled-merchant.example-namespace.svc.cluster.local:4010/v2/',
      MEOWWA_MERCHANT_GATEWAY_API_KEY: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      MEOWWA_MERCHANT_WEBHOOK_SECRET: 'mwhsec_abcdefghijklmnopqrstuvwxyz0123456789',
      MEOWWA_MERCHANT_RPC_URL: 'https://base-sepolia.example/rpc',
      MEOWWA_MERCHANT_SERVICE_TOKEN: merchantToken,
      MEOWWA_MERCHANT_SETTLEMENT_TOKEN: merchantSettlementToken,
      MEOWWA_INTERNAL_API_URL: 'http://api.example-namespace.svc.cluster.local:4000',
    })).toThrow('HTTPS');
  });

  it('rejects public Base RPC, wrong USDC, weak confirmations, and unsafe scan ranges', () => {
    const valid = {
      NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_ONRAMP_WEBHOOK_SECRET: 'whsec_example',
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      BASE_SCAN_START_BLOCK: '123', BASE_CONFIRMATIONS: '12',
    };
    expect(() => loadTenantFinancialWorkerRuntimeConfig({ ...valid, BASE_RPC_URL: 'https://mainnet.base.org' })).toThrow('dedicated');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...valid, BASE_RPC_URL: 'https://provider.example', BASE_USDC_CONTRACT: `0x${'1'.repeat(40)}`,
    })).toThrow('canonical Base USDC');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...valid, BASE_RPC_URL: 'https://provider.example', BASE_CONFIRMATIONS: '2',
    })).toThrow('at least 12');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...valid, BASE_RPC_URL: 'https://provider.example', MEOWWA_FINANCIAL_MAX_SCAN_BLOCKS: '2000',
    })).toThrow('invalid');
  });

  it('does not accept a tenant ID as a substitute for any workload secret', () => {
    expect(() => loadTenantFundingApiConfig({
      NODE_ENV: 'production', MEOWWA_TENANT_FUNDING_API_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_example',
      BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      MEOWWA_WALLET_PROVISIONER_URL: 'https://provisioner.example', MEOWWA_WALLET_PROVISIONER_TOKEN: tenantId,
    })).toThrow('canonical base64');
    expect(() => loadTenantWalletProvisionerRuntimeConfig({
      NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', PRIVY_APP_ID: 'app', PRIVY_APP_SECRET: 'secret', PRIVY_JWT_VERIFICATION_KEY: 'key',
      MEOWWA_PRIVY_AGENT_SIGNER_ID: 'quorum_agent_123',
      MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS: '0x1111111111111111111111111111111111111111',
      MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC: '10000000',
      MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS: '86400',
      MEOWWA_WALLET_PROVISIONER_TOKEN: 'short',
    })).toThrow('canonical base64');
  });

  // Two cases here asserted that the committed Kubernetes manifests actually start these
  // workloads. They read deploy/kubernetes, which is operator infrastructure and is not
  // published in this repository, so they were removed rather than stubbed. They still run
  // in the private application repository, where the manifests live.
});

describe('funding rail selection', () => {
  const workerBase = {
    NODE_ENV: 'production', MEOWWA_RELEASE_ENVIRONMENT: 'production', STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_ONRAMP_WEBHOOK_SECRET: 'whsec_example',
    BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/private-key',
    BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    BASE_SCAN_START_BLOCK: '123', BASE_CONFIRMATIONS: '12',
  };
  const solana = {
    SOLANA_RPC_URL: 'https://solana-mainnet.g.alchemy.com/v2/private-key',
    SOLANA_USDC_MINT: 'EPjFWdd5AufqSSqeM4tf7UfF2h3kRFzJMbPfEqTLu3bT',
    SOLANA_SCAN_START_SLOT: '250000000',
  };
  const apiBase = {
    NODE_ENV: 'production', MEOWWA_TENANT_FUNDING_API_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_example',
    MEOWWA_WALLET_PROVISIONER_URL: 'https://wallet-provisioner.internal.example',
    MEOWWA_WALLET_PROVISIONER_TOKEN: provisionerToken,
    BASE_CHAIN_ID: '8453', BASE_USDC_CONTRACT: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  };

  // Every deployment that predates the second rail keeps funding exactly the chain it funded
  // before: an absent list is Base alone, and Solana stays inert until it is named.
  it('funds Base alone unless a second rail is named', () => {
    expect(loadTenantFundingApiConfig(apiBase)).toMatchObject({ fundingChains: ['base'] });
    expect(loadTenantFinancialWorkerRuntimeConfig(workerBase).rails.map((rail) => rail.chainKey)).toEqual(['base']);
    // Solana credentials sitting unused in the environment do not enable the rail on their own.
    expect(loadTenantFinancialWorkerRuntimeConfig({ ...workerBase, ...solana }).rails.map((r) => r.chainKey)).toEqual(['base']);
  });

  it('loads both rails with each one\'s own RPC, asset, cursor and scan budget', () => {
    const config = loadTenantFinancialWorkerRuntimeConfig({
      ...workerBase, ...solana, MEOWWA_FUNDING_CHAINS: 'base,solana',
    });
    expect(config.rails).toEqual([
      {
        chainKey: 'base', rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/private-key',
        usdcAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        scanStartBlock: 123, confirmations: 12, maxScanBlocks: 1999,
      },
      {
        chainKey: 'solana', rpcUrl: 'https://solana-mainnet.g.alchemy.com/v2/private-key',
        usdcAsset: 'EPjFWdd5AufqSSqeM4tf7UfF2h3kRFzJMbPfEqTLu3bT',
        // Finalized commitment is the finality, so there is no depth to wait out; and a Solana
        // window costs one block read per slot, so its default budget is far below Base's 1,999.
        scanStartBlock: 250_000_000, confirmations: 1, maxScanBlocks: 100,
      },
    ]);
    expect(loadTenantFundingApiConfig({ ...apiBase, ...solana, MEOWWA_FUNDING_CHAINS: 'base,solana' }))
      .toMatchObject({ fundingChains: ['base', 'solana'] });
  });

  it('refuses a rail that is not a production funding chain, and a repeated one', () => {
    for (const value of ['base_sepolia', 'solana_devnet', 'ethereum', 'base,solana_devnet']) {
      expect(() => loadTenantFinancialWorkerRuntimeConfig({ ...workerBase, ...solana, MEOWWA_FUNDING_CHAINS: value }))
        .toThrow('production funding rails');
    }
    expect(() => loadTenantFinancialWorkerRuntimeConfig({ ...workerBase, ...solana, MEOWWA_FUNDING_CHAINS: 'base,base' }))
      .toThrow('must not repeat a rail');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({ ...workerBase, ...solana, MEOWWA_FUNDING_CHAINS: 'base,' }))
      .toThrow('must not contain empty entries');
  });

  // The same reasoning as BASE_USDC_CONTRACT: the rail the indexer watches and the token the
  // withdrawal route names come from one verified place, so neither can drift to a look-alike.
  it('refuses a Solana rail without a dedicated RPC and the canonical mint', () => {
    const enabled = { ...workerBase, MEOWWA_FUNDING_CHAINS: 'base,solana' };
    expect(() => loadTenantFinancialWorkerRuntimeConfig(enabled)).toThrow('SOLANA_USDC_MINT is required');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...enabled, ...solana, SOLANA_USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    })).toThrow('canonical Solana USDC');
    // Base58 is case-significant: a case-folded mint is a different account, not the same one.
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...enabled, ...solana, SOLANA_USDC_MINT: 'epjfwdd5aufqssqem4tf7uff2h3krfzjmbpfeqtlu3bt',
    })).toThrow('canonical Solana USDC');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({ ...enabled, ...solana, SOLANA_RPC_URL: '' }))
      .toThrow('SOLANA_RPC_URL is required');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...enabled, ...solana, SOLANA_RPC_URL: 'http://solana.example/rpc',
    })).toThrow('SOLANA_RPC_URL must use HTTPS');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...enabled, ...solana, SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
    })).toThrow('dedicated production provider');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...enabled, ...solana, SOLANA_SCAN_START_SLOT: ' ',
    })).toThrow('SOLANA_SCAN_START_SLOT is invalid');
    expect(() => loadTenantFinancialWorkerRuntimeConfig({
      ...enabled, ...solana, MEOWWA_FINANCIAL_SOLANA_MAX_SCAN_SLOTS: '2000',
    })).toThrow('MEOWWA_FINANCIAL_SOLANA_MAX_SCAN_SLOTS is invalid');
  });
});
