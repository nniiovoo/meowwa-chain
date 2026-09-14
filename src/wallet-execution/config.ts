import { isAbsolute } from 'node:path';
import { sameDatabaseFile } from '../store/database-path.js';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';

interface DisabledWalletExecutionConfig {
  enabled: false;
}

interface EnabledWalletExecutionConfig {
  enabled: true;
  databasePath: string;
  rpcUrl: string;
  confirmations: number;
  maxBindingAgeMs: number;
  pollMs: number;
  scanStartBlock: bigint;
  authorizationKeyPath: string;
  webhookSigningSecret: string;
  privyAppId: string;
  privyAppSecret: string;
  privyJwtVerificationKey: string;
  gasPaymentMode: 'usdc';
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  usdcContract: typeof BASE_SEPOLIA_USDC;
}

export type WalletExecutionConfig = DisabledWalletExecutionConfig | EnabledWalletExecutionConfig;

const scopedKeys = [
  'MEOWWA_WALLET_EXECUTION_DB',
  'MEOWWA_WALLET_EXECUTION_RPC_URL',
  'MEOWWA_WALLET_EXECUTION_CONFIRMATIONS',
  'MEOWWA_WALLET_EXECUTION_MAX_BINDING_AGE_SECONDS',
  'MEOWWA_WALLET_EXECUTION_POLL_MS',
  'MEOWWA_WALLET_EXECUTION_SCAN_START_BLOCK',
  'MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE',
  'MEOWWA_PRIVY_GAS_PAYMENT_MODE',
] as const;

const requiredKeys = [
  ...scopedKeys,
  'PRIVY_WEBHOOK_SIGNING_SECRET',
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_JWT_VERIFICATION_KEY',
] as const;

function required(env: NodeJS.ProcessEnv, key: typeof requiredKeys[number]): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing sandbox wallet execution configuration: ${key}`);
  return value;
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the allowed range`);
  }
  return parsed;
}

function gasPaymentMode(value: string): 'usdc' {
  if (value === 'usdc') return value;
  throw new Error('Privy gas payment mode must be usdc');
}

export function validateWalletExecutionRpcUrl(value: string, nodeEnv: string | undefined): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Wallet execution RPC URL is invalid'); }
  if (parsed.username || parsed.password) throw new Error('Wallet execution RPC URL cannot contain credentials');
  if (parsed.protocol === 'https:') return parsed.toString();
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (!loopback) throw new Error('Wallet execution RPC URL must use HTTPS');
  if (nodeEnv !== 'test') throw new Error('Loopback wallet execution RPC is only allowed in test');
  return parsed.toString();
}

export function loadWalletExecutionConfig(env: NodeJS.ProcessEnv = process.env): WalletExecutionConfig {
  const enabledValue = env.MEOWWA_WALLET_EXECUTION_ENABLED?.trim();
  if (enabledValue !== undefined && enabledValue !== '' && enabledValue !== 'true' && enabledValue !== 'false') {
    throw new Error('MEOWWA_WALLET_EXECUTION_ENABLED must be true or false');
  }
  const hasOperationalConfiguration = scopedKeys
    .filter((key) => key !== 'MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE')
    .some((key) => Boolean(env[key]?.trim()));
  if (enabledValue !== 'true') {
    if (hasOperationalConfiguration && enabledValue !== 'false') throw new Error('Sandbox wallet execution configuration requires MEOWWA_WALLET_EXECUTION_ENABLED=true');
    return { enabled: false };
  }
  if (env.NODE_ENV === 'production') throw new Error('Sandbox wallet execution is refused in production');
  if (env.MEOWWA_WALLET_CONTROL_ENABLED !== 'true') throw new Error('Sandbox wallet execution requires wallet control to be enabled');

  const values = Object.fromEntries(requiredKeys.map((key) => [key, required(env, key)])) as Record<typeof requiredKeys[number], string>;
  const databasePath = values.MEOWWA_WALLET_EXECUTION_DB;
  if (databasePath === ':memory:' || !isAbsolute(databasePath)) throw new Error('MEOWWA_WALLET_EXECUTION_DB must be an absolute durable path');
  for (const [name, otherPath] of Object.entries({
    MEOWWA_WALLET_CONTROL_DB: env.MEOWWA_WALLET_CONTROL_DB?.trim(),
    MEOWWA_FUNDING_DB: env.MEOWWA_FUNDING_DB?.trim(),
    MEOWWA_STATE_DB: env.MEOWWA_STATE_DB?.trim() ?? './meowwa.sqlite',
    MEOWWA_JOB_DB: env.MEOWWA_JOB_DB?.trim() ?? './meowwa.jobs.sqlite',
  })) {
    if (otherPath && otherPath !== ':memory:' && sameDatabaseFile(databasePath, otherPath)) {
      throw new Error(`MEOWWA_WALLET_EXECUTION_DB must be separate from ${name}`);
    }
  }
  const authorizationKeyPath = values.MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE;
  if (!isAbsolute(authorizationKeyPath)) throw new Error('MEOWWA_PRIVY_AUTHORIZATION_KEY_FILE must be absolute');
  if (!/^whsec_[A-Za-z0-9_+/=-]{10,}$/.test(values.PRIVY_WEBHOOK_SIGNING_SECRET)) {
    throw new Error('Privy webhook signing secret is invalid');
  }

  return {
    enabled: true,
    databasePath,
    rpcUrl: validateWalletExecutionRpcUrl(values.MEOWWA_WALLET_EXECUTION_RPC_URL, env.NODE_ENV),
    confirmations: boundedInteger(values.MEOWWA_WALLET_EXECUTION_CONFIRMATIONS, 'Wallet execution confirmations', 2, 100),
    maxBindingAgeMs: boundedInteger(values.MEOWWA_WALLET_EXECUTION_MAX_BINDING_AGE_SECONDS, 'Wallet binding age', 5, 300) * 1000,
    pollMs: boundedInteger(values.MEOWWA_WALLET_EXECUTION_POLL_MS, 'Wallet execution poll interval', 1000, 300_000),
    scanStartBlock: BigInt(boundedInteger(values.MEOWWA_WALLET_EXECUTION_SCAN_START_BLOCK, 'Wallet receive scan start block', 0, Number.MAX_SAFE_INTEGER)),
    authorizationKeyPath,
    webhookSigningSecret: values.PRIVY_WEBHOOK_SIGNING_SECRET,
    privyAppId: values.PRIVY_APP_ID,
    privyAppSecret: values.PRIVY_APP_SECRET,
    privyJwtVerificationKey: values.PRIVY_JWT_VERIFICATION_KEY,
    gasPaymentMode: gasPaymentMode(values.MEOWWA_PRIVY_GAS_PAYMENT_MODE),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    usdcContract: BASE_SEPOLIA_USDC,
  };
}
