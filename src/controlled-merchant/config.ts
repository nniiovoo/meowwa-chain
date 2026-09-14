import { isAbsolute } from 'node:path';
import { sameDatabaseFile } from '../store/database-path.js';
import { EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';

interface Environment { [key: string]: string | undefined }

export type ControlledMerchantConfig = { enabled: false } | {
  enabled: true;
  databasePath: string;
  rpcUrl: string;
  apiKey: string;
  keyPath: string;
  recipient: `0x${string}`;
  providerRevision: string;
  confirmations: number;
  host: string;
  port: number;
};

const scopedKeys = [
  'MEOWWA_CONTROLLED_MERCHANT_DB',
  'MEOWWA_CONTROLLED_MERCHANT_RPC_URL',
  'MEOWWA_CONTROLLED_MERCHANT_API_KEY',
  'MEOWWA_CONTROLLED_MERCHANT_KEY_FILE',
  'MEOWWA_CONTROLLED_MERCHANT_RECIPIENT',
  'MEOWWA_CONTROLLED_MERCHANT_PROVIDER_REVISION',
  'MEOWWA_CONTROLLED_MERCHANT_ENVIRONMENT',
  'MEOWWA_CONTROLLED_MERCHANT_CONFIRMATIONS',
  'MEOWWA_CONTROLLED_MERCHANT_HOST',
  'MEOWWA_CONTROLLED_MERCHANT_PORT',
] as const;

function required(environment: Environment, key: typeof scopedKeys[number]): string {
  const value = environment[key];
  if (!value || value.trim() !== value) throw new Error(`${key} is required`);
  return value;
}

function integer(value: string, minimum: number, maximum: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} is invalid`);
  return parsed;
}

function rpcUrl(value: string, nodeEnvironment: string | undefined): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('MEOWWA_CONTROLLED_MERCHANT_RPC_URL must be a valid URL'); }
  if (url.username || url.password) throw new Error('MEOWWA_CONTROLLED_MERCHANT_RPC_URL cannot contain URL credentials');
  if (url.protocol === 'https:') return url.toString();
  if (nodeEnvironment === 'test' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return url.toString();
  }
  throw new Error('MEOWWA_CONTROLLED_MERCHANT_RPC_URL must use HTTPS');
}

export function loadControlledMerchantConfig(environment: Environment = process.env): ControlledMerchantConfig {
  const flag = environment.MEOWWA_CONTROLLED_MERCHANT_ENABLED;
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false') {
    throw new Error('MEOWWA_CONTROLLED_MERCHANT_ENABLED must be true or false');
  }
  if (flag !== 'true') {
    if (flag !== 'false' && scopedKeys.some((key) => Boolean(environment[key]))) {
      throw new Error('Controlled merchant configuration requires MEOWWA_CONTROLLED_MERCHANT_ENABLED=true');
    }
    return { enabled: false };
  }
  const values = Object.fromEntries(scopedKeys.map((key) => [key, required(environment, key)])) as Record<typeof scopedKeys[number], string>;
  if (values.MEOWWA_CONTROLLED_MERCHANT_ENVIRONMENT !== 'staging') {
    throw new Error('MEOWWA_CONTROLLED_MERCHANT_ENVIRONMENT must be staging');
  }
  const databasePath = values.MEOWWA_CONTROLLED_MERCHANT_DB;
  if (databasePath === ':memory:' || !isAbsolute(databasePath)) throw new Error('MEOWWA_CONTROLLED_MERCHANT_DB must be an absolute durable path');
  for (const [label, path] of Object.entries({
    MEOWWA_MERCHANT_RECONCILIATION_DB: environment.MEOWWA_MERCHANT_RECONCILIATION_DB,
    MEOWWA_WALLET_EXECUTION_DB: environment.MEOWWA_WALLET_EXECUTION_DB,
    MEOWWA_STATE_DB: environment.MEOWWA_STATE_DB,
  })) {
    if (path && path !== ':memory:' && sameDatabaseFile(path, databasePath)) {
      throw new Error(`MEOWWA_CONTROLLED_MERCHANT_DB must be separate from ${label}`);
    }
  }
  const keyPath = values.MEOWWA_CONTROLLED_MERCHANT_KEY_FILE;
  if (!isAbsolute(keyPath)) throw new Error('MEOWWA_CONTROLLED_MERCHANT_KEY_FILE must be absolute');
  if (!/^merchant_[A-Za-z0-9_-]{32,}$/.test(values.MEOWWA_CONTROLLED_MERCHANT_API_KEY)) {
    throw new Error('MEOWWA_CONTROLLED_MERCHANT_API_KEY is invalid');
  }
  const recipient = values.MEOWWA_CONTROLLED_MERCHANT_RECIPIENT;
  if (!EVM_ADDRESS_PATTERN.test(recipient) || /^0x0{40}$/i.test(recipient)) {
    throw new Error('MEOWWA_CONTROLLED_MERCHANT_RECIPIENT is invalid');
  }
  const providerRevision = values.MEOWWA_CONTROLLED_MERCHANT_PROVIDER_REVISION;
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(providerRevision)) throw new Error('MEOWWA_CONTROLLED_MERCHANT_PROVIDER_REVISION is invalid');
  return {
    enabled: true,
    databasePath,
    rpcUrl: rpcUrl(values.MEOWWA_CONTROLLED_MERCHANT_RPC_URL, environment.NODE_ENV),
    apiKey: values.MEOWWA_CONTROLLED_MERCHANT_API_KEY,
    keyPath,
    recipient: recipient.toLowerCase() as `0x${string}`,
    providerRevision,
    confirmations: integer(values.MEOWWA_CONTROLLED_MERCHANT_CONFIRMATIONS, 2, 100, 'Controlled merchant confirmations'),
    host: values.MEOWWA_CONTROLLED_MERCHANT_HOST,
    port: integer(values.MEOWWA_CONTROLLED_MERCHANT_PORT, 1, 65_535, 'Controlled merchant port'),
  };
}
