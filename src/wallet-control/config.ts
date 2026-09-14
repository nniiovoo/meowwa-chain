import { sameDatabaseFile } from '../store/database-path.js';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC } from './policy.js';
import { EVM_ADDRESS_PATTERN } from '@meowwa/chain-domain';

interface DisabledWalletControlConfig {
  enabled: false;
}

interface EnabledWalletControlConfig {
  enabled: true;
  databasePath: string;
  privyOwnerId: string;
  privyAppId: string;
  privyAppSecret: string;
  privyJwtVerificationKey: string;
  agentSignerId: string;
  allowedRecipients: string[];
  perTransactionLimitAtomic: string;
  maxDurationSeconds: number;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  usdcContract: typeof BASE_SEPOLIA_USDC;
}

export type WalletControlConfig = DisabledWalletControlConfig | EnabledWalletControlConfig;

const scopedKeys = [
  'MEOWWA_WALLET_CONTROL_DB',
  'MEOWWA_PRIVY_AGENT_SIGNER_ID',
  'MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS',
  'MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC',
  'MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS',
] as const;

const requiredKeys = [
  ...scopedKeys,
  'MEOWWA_PRIVY_OWNER_ID',
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_JWT_VERIFICATION_KEY',
] as const;

function required(env: NodeJS.ProcessEnv, key: typeof requiredKeys[number]): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing sandbox wallet control configuration: ${key}`);
  return value;
}

export function parseSignerId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(value) || /^(0x)?[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error('MEOWWA_PRIVY_AGENT_SIGNER_ID must be a Privy key quorum ID, not raw key material');
  }
  return value;
}

export function parseRecipients(value: string): string[] {
  const recipients = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    if (!EVM_ADDRESS_PATTERN.test(item)) throw new Error('Wallet control recipient must be a valid EVM address');
    return item.toLowerCase();
  }))].sort();
  if (recipients.length === 0) throw new Error('MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS must contain at least one address');
  if (recipients.length > 10) throw new Error('MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS supports at most 10 addresses');
  return recipients;
}

export function parseAtomicLimit(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC must be a positive integer');
  if (BigInt(value) > 1_000_000_000n) throw new Error('MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC exceeds the sandbox safety ceiling');
  return value;
}

export function parseDuration(value: string): number {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 3_600 || duration > 2_592_000) {
    throw new Error('MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS must be between 3600 and 2592000');
  }
  return duration;
}

export function loadWalletControlConfig(env: NodeJS.ProcessEnv = process.env): WalletControlConfig {
  const enabledValue = env.MEOWWA_WALLET_CONTROL_ENABLED?.trim();
  if (enabledValue !== undefined && enabledValue !== '' && enabledValue !== 'true' && enabledValue !== 'false') {
    throw new Error('MEOWWA_WALLET_CONTROL_ENABLED must be true or false');
  }
  const hasOperationalConfiguration = scopedKeys
    .filter((key) => key !== 'MEOWWA_PRIVY_AGENT_SIGNER_ID')
    .some((key) => Boolean(env[key]?.trim()));
  if (enabledValue !== 'true') {
    if (hasOperationalConfiguration) throw new Error('Sandbox wallet control configuration requires MEOWWA_WALLET_CONTROL_ENABLED=true');
    return { enabled: false };
  }
  if (env.NODE_ENV === 'production') throw new Error('Sandbox wallet control cannot be enabled in production');

  const values = Object.fromEntries(requiredKeys.map((key) => [key, required(env, key)])) as Record<typeof requiredKeys[number], string>;
  const databasePath = values.MEOWWA_WALLET_CONTROL_DB;
  if (databasePath === ':memory:') throw new Error('MEOWWA_WALLET_CONTROL_DB must be durable');
  for (const [name, otherPath] of Object.entries({
    MEOWWA_FUNDING_DB: env.MEOWWA_FUNDING_DB?.trim(),
    MEOWWA_STATE_DB: env.MEOWWA_STATE_DB?.trim() ?? './meowwa.sqlite',
    MEOWWA_JOB_DB: env.MEOWWA_JOB_DB?.trim() ?? './meowwa.jobs.sqlite',
  })) {
    if (otherPath && otherPath !== ':memory:' && sameDatabaseFile(databasePath, otherPath)) {
      throw new Error(`MEOWWA_WALLET_CONTROL_DB must be separate from ${name}`);
    }
  }

  return {
    enabled: true,
    databasePath,
    privyOwnerId: values.MEOWWA_PRIVY_OWNER_ID,
    privyAppId: values.PRIVY_APP_ID,
    privyAppSecret: values.PRIVY_APP_SECRET,
    privyJwtVerificationKey: values.PRIVY_JWT_VERIFICATION_KEY,
    agentSignerId: parseSignerId(values.MEOWWA_PRIVY_AGENT_SIGNER_ID),
    allowedRecipients: parseRecipients(values.MEOWWA_WALLET_CONTROL_ALLOWED_RECIPIENTS),
    perTransactionLimitAtomic: parseAtomicLimit(values.MEOWWA_WALLET_CONTROL_PER_TX_LIMIT_ATOMIC),
    maxDurationSeconds: parseDuration(values.MEOWWA_WALLET_CONTROL_MAX_DURATION_SECONDS),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    usdcContract: BASE_SEPOLIA_USDC,
  };
}
