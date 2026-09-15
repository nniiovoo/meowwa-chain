import { BASE_MAINNET_CHAIN_ID, BASE_MAINNET_USDC } from '../funding/config.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_CONTRACT,
  CHAINS,
  isCanonicalUsdcAsset,
} from '@meowwa/chain-domain';
import { isEvmAddress, isFundingChainKey, type FundingChainKey } from '../funding/types.js';
import { isPinnedKubernetesHttpService } from '../kubernetes-service-url.js';
import { parseAtomicLimit, parseDuration, parseRecipients, parseSignerId } from '../wallet-control/config.js';

interface Environment {
  [key: string]: string | undefined;
}

export type TenantFundingApiConfig = { enabled: false } | {
  enabled: true;
  stripeSecretKey: string;
  stripeLivemode: boolean;
  /**
   * The production rails this deployment funds, from MEOWWA_FUNDING_CHAINS. The routes read each
   * rail's chain id and USDC asset from the registry entry this loader verified, so a withdrawal
   * can only ever name a chain and token the indexer also watches.
   */
  fundingChains: readonly FundingChainKey[];
  walletProvisionerUrl: string;
  walletProvisionerToken: string;
  requestTimeoutMs: number;
};

export type TenantWalletProvisioningApiConfig = { enabled: false } | {
  enabled: true;
  walletProvisionerUrl: string;
  walletProvisionerToken: string;
  requestTimeoutMs: number;
};

export type TenantWalletExecutionApiConfig = { enabled: false } | {
  enabled: true;
  walletServiceUrl: string;
  walletServiceToken: string;
  settlementAuthSecret: string;
  requestTimeoutMs: number;
};

export type TenantMerchantApiConfig = { enabled: false } | {
  enabled: true;
  merchantServiceUrl: string;
  merchantServiceToken: string;
  settlementAuthSecret: string;
  requestTimeoutMs: number;
};

export interface TenantWalletProvisionerRuntimeConfig {
  privyAppId: string;
  privyAppSecret: string;
  privyJwtVerificationKey: string;
  agentSignerId: string;
  allowedRecipients: string[];
  perTransactionLimitAtomic: string;
  maxDurationSeconds: number;
  productionFunding: boolean;
  execution: { enabled: false } | {
    enabled: true;
    authorizationKeyPath: string;
    baseSepoliaRpcUrl: string;
    webhookSigningSecret: string;
    gasPaymentMode: 'usdc';
    confirmations: number;
    pollMs: number;
    internalApiUrl: string;
    settlementAuthSecret: string;
    requestTimeoutMs: number;
  };
  internalAuthToken: string;
  host: string;
  port: number;
}

/**
 * One funding rail the worker indexes and sweeps. Every rail carries its own RPC, canonical USDC
 * asset, cursor start and scan budget, because the cost of a scan is not the same on both: an EVM
 * window is one log query, a Solana window is one block read per slot.
 */
export interface TenantFinancialWorkerRailConfig {
  chainKey: FundingChainKey;
  rpcUrl: string;
  /** ERC-20 contract on an EVM rail, SPL mint on Solana; verified canonical for the rail. */
  usdcAsset: string;
  scanStartBlock: number;
  /**
   * Confirmation depth below the head. Fixed at 1 on Solana: the reader answers at finalized
   * commitment, below which nothing can change, so waiting further slots buys no finality.
   */
  confirmations: number;
  maxScanBlocks: number;
}

export interface TenantFinancialWorkerRuntimeConfig {
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripeLivemode: boolean;
  /** At least one; Base unless MEOWWA_FUNDING_CHAINS says otherwise. */
  rails: readonly TenantFinancialWorkerRailConfig[];
  scanPollMs: number;
  reconcilePollMs: number;
  diagnosticsToken: string | undefined;
  host: string;
  port: number;
}

export interface TenantMerchantWorkerRuntimeConfig {
  gatewayUrl: string;
  gatewayApiKey: string;
  gatewayTimeoutMs: number;
  webhookSecret: string;
  baseSepoliaRpcUrl: string;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  usdcContract: typeof BASE_SEPOLIA_USDC_CONTRACT;
  confirmations: number;
  reconciliationPollMs: number;
  quoteRefreshMs: number;
  internalApiUrl: string;
  internalServiceToken: string;
  settlementAuthSecret: string;
  settlementTimeoutMs: number;
  host: string;
  port: number;
}

function booleanFlag(value: string | undefined, label: string): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${label} must be true or false`);
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (!value || value.trim() !== value) throw new Error(`${key} is required`);
  return value;
}

function releaseEnvironment(environment: Environment): 'development' | 'test' | 'staging' | 'production' {
  const value = required(environment, 'MEOWWA_RELEASE_ENVIRONMENT');
  if (value !== 'development' && value !== 'test' && value !== 'staging' && value !== 'production') {
    throw new Error('MEOWWA_RELEASE_ENVIRONMENT must be development, test, staging, or production');
  }
  if (value === 'production' && environment.NODE_ENV !== 'production') {
    throw new Error('MEOWWA_RELEASE_ENVIRONMENT is inconsistent with NODE_ENV');
  }
  if ((value === 'development' || value === 'test') && environment.NODE_ENV === 'production') {
    throw new Error('MEOWWA_RELEASE_ENVIRONMENT is inconsistent with NODE_ENV');
  }
  return value;
}

function strongSecret(value: string | undefined, label: string): string {
  if (!value || value.trim() !== value) {
    throw new Error(`${label} must be canonical base64 encoding of exactly 32 random bytes`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new Error(`${label} must be canonical base64 encoding of exactly 32 random bytes`);
  }
  return value;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  // A blank value takes the fallback, exactly like an absent one. `Number('')` and `Number(' ')`
  // are 0, which every other call site rejects on its own minimum -- but BASE_SCAN_START_BLOCK's
  // minimum is 0, so a blank ConfigMap key or an unfilled `.env` line used to seed the Base indexer
  // cursor at mainnet genesis, and `ON CONFLICT DO NOTHING` then ignores the corrected value.
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} is invalid`);
  return parsed;
}

function serviceOrigin(
  value: string | undefined,
  production: boolean,
  internalHttpPort: number,
  key = 'MEOWWA_WALLET_PROVISIONER_URL',
): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error(`${key} must be a valid origin`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${key} must be an origin without a path or credentials`);
  }
  if (production && url.protocol !== 'https:' && !isPinnedKubernetesHttpService(url, {
    port: internalHttpPort,
    pathname: '/',
  })) {
    throw new Error(`${key} must use HTTPS or its exact Kubernetes service port in production`);
  }
  if (!production && url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`Development ${key} HTTP is limited to loopback`);
  }
  return url.origin;
}

function internalApiOrigin(value: string | undefined, production: boolean): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error('MEOWWA_INTERNAL_API_URL must be a valid origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MEOWWA_INTERNAL_API_URL must be an origin without a path or credentials');
  }
  if (production && url.protocol !== 'https:' && !isPinnedKubernetesHttpService(url, { port: 4000, pathname: '/' })) {
    throw new Error('MEOWWA_INTERNAL_API_URL must use HTTPS or the exact Kubernetes API service port in production');
  }
  if (!production && url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Development internal API HTTP is limited to loopback');
  }
  return url.origin;
}

function baseSepoliaRpcUrl(environment: Environment): string {
  let url: URL;
  try { url = new URL(required(environment, 'MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL')); } catch {
    throw new Error('MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL must be a valid HTTPS URL');
  }
  if (url.username || url.password) throw new Error('MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL cannot contain URL credentials');
  if (url.protocol !== 'https:' && !(environment.NODE_ENV !== 'production' && url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL must use HTTPS');
  }
  if (environment.NODE_ENV === 'production' && url.hostname.toLowerCase() === 'sepolia.base.org') {
    throw new Error('MEOWWA_TENANT_WALLET_EXECUTION_RPC_URL must use a dedicated production provider');
  }
  return url.toString();
}

function stripeKey(environment: Environment): { value: string; livemode: boolean } {
  const value = required(environment, 'STRIPE_SECRET_KEY');
  const livemode = value.startsWith('sk_live_');
  if (!livemode && !value.startsWith('sk_test_')) throw new Error('STRIPE_SECRET_KEY is invalid');
  // NODE_ENV describes the compiled Node runtime, so hosted staging also sets it to production.
  // Payment mode must follow the release environment instead: staging may use only Stripe's
  // sandbox, while a production release may use only live credentials. If older deployments omit
  // the explicit release label, fail toward the NODE_ENV-derived production boundary.
  const environmentName = environment.MEOWWA_RELEASE_ENVIRONMENT
    ? releaseEnvironment(environment)
    : environment.NODE_ENV === 'production' ? 'production' : 'development';
  if (environmentName === 'production' && !livemode) {
    throw new Error('STRIPE_SECRET_KEY must be a live key in production');
  }
  if (environmentName !== 'production' && livemode) {
    throw new Error('STRIPE_SECRET_KEY must be a test key outside production');
  }
  return { value, livemode };
}

function baseRpcUrl(environment: Environment): string {
  let url: URL;
  try { url = new URL(required(environment, 'BASE_RPC_URL')); } catch { throw new Error('BASE_RPC_URL must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:') throw new Error('BASE_RPC_URL must use HTTPS');
  if (url.hostname.toLowerCase() === 'mainnet.base.org') {
    throw new Error('BASE_RPC_URL must use a dedicated production provider');
  }
  return url.toString();
}

function merchantGatewayUrl(environment: Environment): string {
  let url: URL;
  try { url = new URL(required(environment, 'MEOWWA_MERCHANT_GATEWAY_URL')); }
  catch { throw new Error('MEOWWA_MERCHANT_GATEWAY_URL must be a valid HTTPS URL'); }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const developmentLoopback = environment.NODE_ENV !== 'production' && url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const productionKubernetesService = environment.NODE_ENV === 'production' &&
    isPinnedKubernetesHttpService(url, { port: 4010, pathname: '/v1/' });
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !developmentLoopback && !productionKubernetesService)) {
    throw new Error('MEOWWA_MERCHANT_GATEWAY_URL must be a credential-free HTTPS URL');
  }
  return url.toString();
}

function merchantBaseSepoliaRpcUrl(environment: Environment): string {
  let url: URL;
  try { url = new URL(required(environment, 'MEOWWA_MERCHANT_RPC_URL')); }
  catch { throw new Error('MEOWWA_MERCHANT_RPC_URL must be a valid HTTPS URL'); }
  if (url.username || url.password || url.protocol !== 'https:') throw new Error('MEOWWA_MERCHANT_RPC_URL must use credential-free HTTPS');
  if (environment.NODE_ENV === 'production' && url.hostname.toLowerCase() === 'sepolia.base.org') {
    throw new Error('MEOWWA_MERCHANT_RPC_URL must use a dedicated production provider');
  }
  return url.toString();
}

export function loadTenantFundingApiConfig(environment: Environment = process.env): TenantFundingApiConfig {
  if (!booleanFlag(environment.MEOWWA_TENANT_FUNDING_API_ENABLED, 'MEOWWA_TENANT_FUNDING_API_ENABLED')) {
    return { enabled: false };
  }
  const stripe = stripeKey(environment);
  return {
    enabled: true,
    stripeSecretKey: stripe.value,
    stripeLivemode: stripe.livemode,
    fundingChains: loadFundingChains(environment),
    walletProvisionerUrl: serviceOrigin(environment.MEOWWA_WALLET_PROVISIONER_URL, environment.NODE_ENV === 'production', 4002),
    walletProvisionerToken: strongSecret(environment.MEOWWA_WALLET_PROVISIONER_TOKEN, 'MEOWWA_WALLET_PROVISIONER_TOKEN'),
    requestTimeoutMs: integer(
      environment.MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS, 5_000, 500, 30_000,
      'MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS',
    ),
  };
}

/**
 * Connects the owner-facing API to the isolated wallet provisioner for the narrow local evidence
 * exercise. It deliberately does not initialize Stripe, deposits, withdrawals, or the financial
 * worker. buildApp separately rejects the exercise outside development and keeps the global pause
 * authoritative.
 */
export function loadTenantWalletProvisioningApiConfig(
  environment: Environment = process.env,
): TenantWalletProvisioningApiConfig {
  if (!booleanFlag(
    environment.MEOWWA_DEVELOPMENT_WALLET_PROVISIONING_EXERCISE,
    'MEOWWA_DEVELOPMENT_WALLET_PROVISIONING_EXERCISE',
  )) return { enabled: false };
  if (releaseEnvironment(environment) !== 'development') {
    throw new Error('MEOWWA_DEVELOPMENT_WALLET_PROVISIONING_EXERCISE is available only in development');
  }
  return {
    enabled: true,
    walletProvisionerUrl: serviceOrigin(
      environment.MEOWWA_WALLET_PROVISIONER_URL ?? 'http://127.0.0.1:4002',
      false,
      4002,
    ),
    walletProvisionerToken: strongSecret(environment.MEOWWA_WALLET_PROVISIONER_TOKEN, 'MEOWWA_WALLET_PROVISIONER_TOKEN'),
    requestTimeoutMs: integer(
      environment.MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS, 5_000, 500, 30_000,
      'MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS',
    ),
  };
}

export function loadTenantWalletExecutionApiConfig(
  environment: Environment = process.env,
): TenantWalletExecutionApiConfig {
  if (!booleanFlag(environment.MEOWWA_TENANT_WALLET_EXECUTION_ENABLED, 'MEOWWA_TENANT_WALLET_EXECUTION_ENABLED')) {
    return { enabled: false };
  }
  const walletServiceToken = strongSecret(environment.MEOWWA_WALLET_PROVISIONER_TOKEN, 'MEOWWA_WALLET_PROVISIONER_TOKEN');
  const settlementAuthSecret = strongSecret(environment.MEOWWA_WALLET_SETTLEMENT_TOKEN, 'MEOWWA_WALLET_SETTLEMENT_TOKEN');
  if (walletServiceToken === settlementAuthSecret) throw new Error('Wallet provisioner and settlement tokens must be distinct');
  return {
    enabled: true,
    walletServiceUrl: serviceOrigin(environment.MEOWWA_WALLET_PROVISIONER_URL, environment.NODE_ENV === 'production', 4002),
    walletServiceToken,
    settlementAuthSecret,
    requestTimeoutMs: integer(
      environment.MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS, 5_000, 500, 30_000,
      'MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS',
    ),
  };
}

export function loadTenantMerchantApiConfig(environment: Environment = process.env): TenantMerchantApiConfig {
  if (!booleanFlag(environment.MEOWWA_TENANT_MERCHANT_ENABLED, 'MEOWWA_TENANT_MERCHANT_ENABLED')) {
    return { enabled: false };
  }
  const merchantServiceToken = strongSecret(environment.MEOWWA_MERCHANT_SERVICE_TOKEN, 'MEOWWA_MERCHANT_SERVICE_TOKEN');
  const settlementAuthSecret = strongSecret(environment.MEOWWA_MERCHANT_SETTLEMENT_TOKEN, 'MEOWWA_MERCHANT_SETTLEMENT_TOKEN');
  if (merchantServiceToken === settlementAuthSecret ||
    merchantServiceToken === environment.MEOWWA_WALLET_PROVISIONER_TOKEN ||
    merchantServiceToken === environment.MEOWWA_WALLET_SETTLEMENT_TOKEN ||
    settlementAuthSecret === environment.MEOWWA_WALLET_PROVISIONER_TOKEN ||
    settlementAuthSecret === environment.MEOWWA_WALLET_SETTLEMENT_TOKEN) {
    throw new Error('Merchant service and settlement tokens must be distinct from every wallet credential');
  }
  return {
    enabled: true,
    merchantServiceUrl: serviceOrigin(
      environment.MEOWWA_MERCHANT_SERVICE_URL,
      environment.NODE_ENV === 'production',
      4004,
      'MEOWWA_MERCHANT_SERVICE_URL',
    ),
    merchantServiceToken,
    settlementAuthSecret,
    requestTimeoutMs: integer(environment.MEOWWA_MERCHANT_SERVICE_TIMEOUT_MS, 5_000, 500, 30_000, 'MEOWWA_MERCHANT_SERVICE_TIMEOUT_MS'),
  };
}

export function loadTenantWalletProvisionerRuntimeConfig(
  environment: Environment = process.env,
): TenantWalletProvisionerRuntimeConfig {
  const environmentName = releaseEnvironment(environment);
  const executionEnabled = booleanFlag(
    environment.MEOWWA_TENANT_WALLET_EXECUTION_ENABLED,
    'MEOWWA_TENANT_WALLET_EXECUTION_ENABLED',
  );
  const internalAuthToken = strongSecret(environment.MEOWWA_WALLET_PROVISIONER_TOKEN, 'MEOWWA_WALLET_PROVISIONER_TOKEN');
  const settlementAuthSecret = executionEnabled
    ? strongSecret(environment.MEOWWA_WALLET_SETTLEMENT_TOKEN, 'MEOWWA_WALLET_SETTLEMENT_TOKEN')
    : undefined;
  if (settlementAuthSecret === internalAuthToken) throw new Error('Wallet provisioner and settlement tokens must be distinct');
  return {
    privyAppId: required(environment, 'PRIVY_APP_ID'),
    privyAppSecret: required(environment, 'PRIVY_APP_SECRET'),
    privyJwtVerificationKey: required(environment, 'PRIVY_JWT_VERIFICATION_KEY'),
    agentSignerId: parseSignerId(required(environment, 'MEOWWA_PRIVY_AGENT_SIGNER_ID')),
    allowedRecipients: parseRecipients(required(environment, 'MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS')),
    perTransactionLimitAtomic: parseAtomicLimit(required(environment, 'MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC')),
    maxDurationSeconds: parseDuration(required(environment, 'MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS')),
    productionFunding: environmentName === 'production',
    execution: executionEnabled ? {
      enabled: true,
      authorizationKeyPath: required(environment, 'MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE'),
      baseSepoliaRpcUrl: baseSepoliaRpcUrl(environment),
      webhookSigningSecret: (() => {
        const value = required(environment, 'PRIVY_WEBHOOK_SIGNING_SECRET');
        if (!/^whsec_[A-Za-z0-9_+/=-]{10,}$/.test(value)) throw new Error('PRIVY_WEBHOOK_SIGNING_SECRET is invalid');
        return value;
      })(),
      gasPaymentMode: (() => {
        const value = required(environment, 'MEOWWA_PRIVY_GAS_PAYMENT_MODE');
        if (value !== 'usdc') throw new Error('MEOWWA_PRIVY_GAS_PAYMENT_MODE must be usdc');
        return 'usdc' as const;
      })(),
      confirmations: integer(environment.MEOWWA_TENANT_WALLET_EXECUTION_CONFIRMATIONS, 12, 2, 100,
        'MEOWWA_TENANT_WALLET_EXECUTION_CONFIRMATIONS'),
      pollMs: integer(environment.MEOWWA_TENANT_WALLET_EXECUTION_POLL_MS, 15_000, 1_000, 3_600_000,
        'MEOWWA_TENANT_WALLET_EXECUTION_POLL_MS'),
      internalApiUrl: internalApiOrigin(environment.MEOWWA_INTERNAL_API_URL, environment.NODE_ENV === 'production'),
      settlementAuthSecret: settlementAuthSecret!,
      requestTimeoutMs: integer(environment.MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS, 5_000, 500, 30_000,
        'MEOWWA_WALLET_PROVISIONER_TIMEOUT_MS'),
    } : { enabled: false },
    internalAuthToken,
    host: environment.MEOWWA_WALLET_PROVISIONER_HOST ?? (environment.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: integer(environment.MEOWWA_WALLET_PROVISIONER_PORT, 4_002, 1, 65_535, 'MEOWWA_WALLET_PROVISIONER_PORT'),
  };
}

/**
 * The production rails this deployment funds, validated once.
 *
 * Both the indexer and the withdrawal route read this. They must agree: a withdrawal that names a
 * chain or token the indexer does not watch moves money the ledger never records, which is exactly
 * what happened when the route carried its own Sepolia constants. Each rail's canonical
 * asset is pinned against the registry here, so neither side can be pointed at a look-alike token.
 *
 * Absent, the list is Base alone: every deployment that predates the second rail keeps funding
 * exactly the chain it funded before, and Solana stays inert until it is named.
 */
function loadFundingChains(environment: Environment = process.env): readonly FundingChainKey[] {
  const raw = environment.MEOWWA_FUNDING_CHAINS?.trim();
  const requested = raw === undefined || raw === '' ? ['base'] : raw.split(',').map((entry) => entry.trim());
  if (requested.some((entry) => entry === '')) throw new Error('MEOWWA_FUNDING_CHAINS must not contain empty entries');
  const chains: FundingChainKey[] = [];
  for (const entry of requested) {
    if (!isFundingChainKey(entry)) {
      throw new Error('MEOWWA_FUNDING_CHAINS must list only production funding rails (base, solana)');
    }
    if (chains.includes(entry)) throw new Error('MEOWWA_FUNDING_CHAINS must not repeat a rail');
    chains.push(entry);
  }
  if (chains.length === 0) throw new Error('MEOWWA_FUNDING_CHAINS must name at least one rail');
  for (const chainKey of chains) fundingAssetPin(environment, chainKey);
  return chains;
}

/**
 * The rail's canonical USDC, as this deployment states it, checked against the registry. The
 * environment still has to declare it: a silent registry default would let a mistyped ConfigMap
 * index a different token than the one an operator believes is configured.
 */
function fundingAssetPin(environment: Environment, chainKey: FundingChainKey): string {
  if (chainKey === 'base') {
    if (required(environment, 'BASE_CHAIN_ID') !== String(BASE_MAINNET_CHAIN_ID)) throw new Error('BASE_CHAIN_ID must be 8453');
    const contract = required(environment, 'BASE_USDC_CONTRACT');
    if (!isEvmAddress(contract) || contract.toLowerCase() !== BASE_MAINNET_USDC.toLowerCase()) {
      throw new Error('BASE_USDC_CONTRACT must be canonical Base USDC');
    }
    return BASE_MAINNET_USDC;
  }
  const mint = required(environment, 'SOLANA_USDC_MINT');
  // Base58 is case-significant, so this is an exact comparison: a case-folded mint is a different
  // account, not the same one written differently.
  if (!isCanonicalUsdcAsset(CHAINS.solana, mint)) throw new Error('SOLANA_USDC_MINT must be canonical Solana USDC');
  return CHAINS.solana.usdc.asset;
}

function solanaRpcUrl(environment: Environment): string {
  // `required` throws outside the try on purpose: folding it in would report an absent key as a
  // malformed URL and send an operator looking for a typo in a value that is not there.
  const value = required(environment, 'SOLANA_RPC_URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('SOLANA_RPC_URL must be a valid HTTPS URL'); }
  if (url.username || url.password) throw new Error('SOLANA_RPC_URL cannot contain credentials');
  if (url.protocol !== 'https:') throw new Error('SOLANA_RPC_URL must use HTTPS');
  // The public endpoint is rate limited to the point of being unusable for an indexer, and it is
  // shared with the whole world: the same reasoning that keeps mainnet.base.org out of BASE_RPC_URL.
  if (url.hostname.toLowerCase() === 'api.mainnet-beta.solana.com') {
    throw new Error('SOLANA_RPC_URL must use a dedicated production provider');
  }
  return url.toString();
}

/** Every rail the worker indexes and sweeps, with the per-rail budget each one's RPC can afford. */
function loadFinancialWorkerRails(
  environment: Environment,
  chains: readonly FundingChainKey[],
): readonly TenantFinancialWorkerRailConfig[] {
  return chains.map((chainKey): TenantFinancialWorkerRailConfig => {
    if (chainKey === 'base') {
      const confirmations = Number(environment.BASE_CONFIRMATIONS ?? '12');
      if (!Number.isSafeInteger(confirmations) || confirmations < 12 || confirmations > 10_000) {
        throw new Error('BASE_CONFIRMATIONS must be an integer of at least 12');
      }
      const maxScanBlocks = integer(
        environment.MEOWWA_FINANCIAL_MAX_SCAN_BLOCKS, 1_999, 1, 1_999, 'MEOWWA_FINANCIAL_MAX_SCAN_BLOCKS',
      );
      if (maxScanBlocks !== 1_999) throw new Error('MEOWWA_FINANCIAL_MAX_SCAN_BLOCKS must remain 1999 for reviewed indexing');
      return {
        chainKey,
        rpcUrl: baseRpcUrl(environment),
        usdcAsset: fundingAssetPin(environment, chainKey),
        scanStartBlock: integer(environment.BASE_SCAN_START_BLOCK, -1, 0, Number.MAX_SAFE_INTEGER, 'BASE_SCAN_START_BLOCK'),
        confirmations,
        maxScanBlocks,
      };
    }
    return {
      chainKey,
      rpcUrl: solanaRpcUrl(environment),
      usdcAsset: fundingAssetPin(environment, chainKey),
      scanStartBlock: integer(
        environment.SOLANA_SCAN_START_SLOT, -1, 0, Number.MAX_SAFE_INTEGER, 'SOLANA_SCAN_START_SLOT',
      ),
      // Finalized commitment is the finality: a finalized slot cannot be rolled back, so there is
      // no depth to wait out. The indexer still requires a positive depth, and 1 is the floor.
      confirmations: 1,
      // A Solana window costs one full block read per produced slot, against one log query for a
      // whole EVM window, so the default budget is far smaller than Base's 1,999.
      maxScanBlocks: integer(
        environment.MEOWWA_FINANCIAL_SOLANA_MAX_SCAN_SLOTS, 100, 1, 1_999, 'MEOWWA_FINANCIAL_SOLANA_MAX_SCAN_SLOTS',
      ),
    };
  });
}

export function loadTenantFinancialWorkerRuntimeConfig(
  environment: Environment = process.env,
): TenantFinancialWorkerRuntimeConfig {
  const stripe = stripeKey(environment);
  const webhookSecret = required(environment, 'STRIPE_ONRAMP_WEBHOOK_SECRET');
  if (!webhookSecret.startsWith('whsec_')) throw new Error('STRIPE_ONRAMP_WEBHOOK_SECRET is invalid');
  return {
    stripeSecretKey: stripe.value,
    stripeWebhookSecret: webhookSecret,
    stripeLivemode: stripe.livemode,
    rails: loadFinancialWorkerRails(environment, loadFundingChains(environment)),
    scanPollMs: integer(environment.MEOWWA_FINANCIAL_SCAN_MS, 15_000, 1_000, 3_600_000, 'MEOWWA_FINANCIAL_SCAN_MS'),
    reconcilePollMs: integer(environment.MEOWWA_FINANCIAL_RECONCILE_MS, 300_000, 60_000, 86_400_000, 'MEOWWA_FINANCIAL_RECONCILE_MS'),
    diagnosticsToken: diagnosticsToken(environment),
    host: environment.MEOWWA_FINANCIAL_WORKER_HOST ?? (environment.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: integer(environment.MEOWWA_FINANCIAL_WORKER_PORT, 4_003, 1, 65_535, 'MEOWWA_FINANCIAL_WORKER_PORT'),
  };
}

/**
 * Optional because the diagnostic endpoints fail closed without it: no credential means the
 * routes answer 503, never "open". When set it must be strong — a short token on a financial
 * readout is worse than none, because it looks protected.
 */
function diagnosticsToken(environment: Environment): string | undefined {
  const value = environment.MEOWWA_FINANCIAL_DIAGNOSTICS_TOKEN;
  if (value === undefined || value === '') return undefined;
  if (value.length < 32 || value.trim() !== value) {
    throw new Error('MEOWWA_FINANCIAL_DIAGNOSTICS_TOKEN must be at least 32 bytes with no surrounding whitespace');
  }
  return value;
}

export function loadTenantMerchantWorkerRuntimeConfig(
  environment: Environment = process.env,
): TenantMerchantWorkerRuntimeConfig {
  if (!booleanFlag(environment.MEOWWA_TENANT_MERCHANT_ENABLED, 'MEOWWA_TENANT_MERCHANT_ENABLED')) {
    throw new Error('Tenant merchant worker requires MEOWWA_TENANT_MERCHANT_ENABLED=true');
  }
  const gatewayApiKey = required(environment, 'MEOWWA_MERCHANT_GATEWAY_API_KEY');
  if (!/^merchant_[A-Za-z0-9_-]{32,}$/.test(gatewayApiKey)) throw new Error('MEOWWA_MERCHANT_GATEWAY_API_KEY is invalid');
  const webhookSecret = required(environment, 'MEOWWA_MERCHANT_WEBHOOK_SECRET');
  if (!/^mwhsec_[A-Za-z0-9_+/=-]{32,}$/.test(webhookSecret)) throw new Error('MEOWWA_MERCHANT_WEBHOOK_SECRET is invalid');
  const internalServiceToken = strongSecret(environment.MEOWWA_MERCHANT_SERVICE_TOKEN, 'MEOWWA_MERCHANT_SERVICE_TOKEN');
  const settlementAuthSecret = strongSecret(environment.MEOWWA_MERCHANT_SETTLEMENT_TOKEN, 'MEOWWA_MERCHANT_SETTLEMENT_TOKEN');
  const forbidden = [environment.MEOWWA_WALLET_PROVISIONER_TOKEN, environment.MEOWWA_WALLET_SETTLEMENT_TOKEN].filter(Boolean);
  if (internalServiceToken === settlementAuthSecret || forbidden.includes(internalServiceToken) || forbidden.includes(settlementAuthSecret)) {
    throw new Error('Merchant service and settlement tokens must be distinct from every wallet credential');
  }
  return {
    gatewayUrl: merchantGatewayUrl(environment),
    gatewayApiKey,
    gatewayTimeoutMs: integer(environment.MEOWWA_MERCHANT_GATEWAY_TIMEOUT_MS, 15_000, 1_000, 60_000, 'MEOWWA_MERCHANT_GATEWAY_TIMEOUT_MS'),
    webhookSecret,
    baseSepoliaRpcUrl: merchantBaseSepoliaRpcUrl(environment),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    usdcContract: BASE_SEPOLIA_USDC_CONTRACT,
    confirmations: integer(environment.MEOWWA_MERCHANT_CONFIRMATIONS, 12, 2, 100, 'MEOWWA_MERCHANT_CONFIRMATIONS'),
    reconciliationPollMs: integer(environment.MEOWWA_MERCHANT_POLL_MS, 15_000, 1_000, 3_600_000, 'MEOWWA_MERCHANT_POLL_MS'),
    quoteRefreshMs: integer(environment.MEOWWA_MERCHANT_QUOTE_REFRESH_MS, 60_000, 30_000, 3_600_000, 'MEOWWA_MERCHANT_QUOTE_REFRESH_MS'),
    internalApiUrl: internalApiOrigin(environment.MEOWWA_INTERNAL_API_URL, environment.NODE_ENV === 'production'),
    internalServiceToken,
    settlementAuthSecret,
    settlementTimeoutMs: integer(environment.MEOWWA_MERCHANT_SERVICE_TIMEOUT_MS, 5_000, 500, 30_000, 'MEOWWA_MERCHANT_SERVICE_TIMEOUT_MS'),
    host: environment.MEOWWA_MERCHANT_WORKER_HOST ?? (environment.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: integer(environment.MEOWWA_MERCHANT_WORKER_PORT, 4_004, 1, 65_535, 'MEOWWA_MERCHANT_WORKER_PORT'),
  };
}
