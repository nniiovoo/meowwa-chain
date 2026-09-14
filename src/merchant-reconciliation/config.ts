import { isAbsolute } from 'node:path';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_CONTRACT } from '@meowwa/chain-domain';
import { sameDatabaseFile } from '../store/database-path.js';

export type MerchantReconciliationConfig = { enabled: false } | {
  enabled: true;
  databasePath: string;
  gatewayUrl: string;
  gatewayApiKey: string;
  webhookSecret: string;
  rpcUrl: string;
  confirmations: number;
  pollMs: number;
  quoteRefreshMs: number;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  usdcContract: typeof BASE_SEPOLIA_USDC_CONTRACT;
};

const scopedKeys = [
  'MEOWWA_MERCHANT_RECONCILIATION_DB', 'MEOWWA_MERCHANT_GATEWAY_URL',
  'MEOWWA_MERCHANT_GATEWAY_API_KEY', 'MEOWWA_MERCHANT_WEBHOOK_SECRET',
  'MEOWWA_MERCHANT_RPC_URL', 'MEOWWA_MERCHANT_CONFIRMATIONS',
  'MEOWWA_MERCHANT_POLL_MS', 'MEOWWA_MERCHANT_QUOTE_REFRESH_MS',
] as const;

function required(env: NodeJS.ProcessEnv, key: typeof scopedKeys[number]): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing sandbox merchant reconciliation configuration: ${key}`);
  return value;
}

function bounded(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} is outside the allowed range`);
  return parsed;
}

function secureUrl(value: string, label: string, nodeEnv: string | undefined): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} URL is invalid`); }
  if (parsed.username || parsed.password) throw new Error(`${label} URL cannot contain credentials`);
  if (parsed.protocol === 'https:') return parsed.toString();
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (loopback && nodeEnv !== 'production') return parsed.toString();
  throw new Error(`${label} URL must use HTTPS`);
}

export function loadMerchantReconciliationConfig(env: NodeJS.ProcessEnv = process.env): MerchantReconciliationConfig {
  const enabled = env.MEOWWA_MERCHANT_RECONCILIATION_ENABLED?.trim();
  if (enabled !== undefined && enabled !== '' && enabled !== 'true' && enabled !== 'false') {
    throw new Error('MEOWWA_MERCHANT_RECONCILIATION_ENABLED must be true or false');
  }
  const hasScoped = scopedKeys.some((key) => Boolean(env[key]?.trim()));
  if (enabled !== 'true') {
    if (hasScoped && enabled !== 'false') throw new Error('Sandbox merchant reconciliation configuration requires MEOWWA_MERCHANT_RECONCILIATION_ENABLED=true');
    return { enabled: false };
  }
  if (env.NODE_ENV === 'production') throw new Error('Sandbox merchant reconciliation is refused in production');
  const values = Object.fromEntries(scopedKeys.map((key) => [key, required(env, key)])) as Record<typeof scopedKeys[number], string>;
  const databasePath = values.MEOWWA_MERCHANT_RECONCILIATION_DB;
  if (databasePath === ':memory:' || !isAbsolute(databasePath)) throw new Error('MEOWWA_MERCHANT_RECONCILIATION_DB must be an absolute durable path');
  for (const [name, path] of Object.entries({
    MEOWWA_STATE_DB: env.MEOWWA_STATE_DB ?? './meowwa.sqlite',
    MEOWWA_JOB_DB: env.MEOWWA_JOB_DB ?? './meowwa.jobs.sqlite',
    MEOWWA_FUNDING_DB: env.MEOWWA_FUNDING_DB, MEOWWA_WALLET_CONTROL_DB: env.MEOWWA_WALLET_CONTROL_DB,
    MEOWWA_WALLET_EXECUTION_DB: env.MEOWWA_WALLET_EXECUTION_DB,
  })) {
    if (path?.trim() && path !== ':memory:' && sameDatabaseFile(path, databasePath)) {
      throw new Error(`MEOWWA_MERCHANT_RECONCILIATION_DB must be separate from ${name}`);
    }
  }
  if (!/^merchant_[A-Za-z0-9_-]{32,}$/.test(values.MEOWWA_MERCHANT_GATEWAY_API_KEY)) {
    throw new Error('Merchant gateway API key is invalid');
  }
  if (!/^mwhsec_[A-Za-z0-9_+/=-]{32,}$/.test(values.MEOWWA_MERCHANT_WEBHOOK_SECRET)) {
    throw new Error('Merchant webhook secret is invalid');
  }
  return {
    enabled: true,
    databasePath,
    gatewayUrl: secureUrl(values.MEOWWA_MERCHANT_GATEWAY_URL, 'Merchant gateway', env.NODE_ENV),
    gatewayApiKey: values.MEOWWA_MERCHANT_GATEWAY_API_KEY,
    webhookSecret: values.MEOWWA_MERCHANT_WEBHOOK_SECRET,
    rpcUrl: secureUrl(values.MEOWWA_MERCHANT_RPC_URL, 'Merchant RPC', env.NODE_ENV),
    confirmations: bounded(values.MEOWWA_MERCHANT_CONFIRMATIONS, 'Merchant refund confirmations', 2, 100),
    pollMs: bounded(values.MEOWWA_MERCHANT_POLL_MS, 'Merchant reconciliation poll interval', 1_000, 300_000),
    quoteRefreshMs: bounded(values.MEOWWA_MERCHANT_QUOTE_REFRESH_MS, 'Merchant quote refresh interval', 30_000, 3_600_000),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    usdcContract: BASE_SEPOLIA_USDC_CONTRACT,
  };
}
