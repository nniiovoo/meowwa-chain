import { CHAINS } from '@meowwa/chain-domain';

/**
 * The production funding rail is Base mainnet, chain 8453, canonical USDC
 * 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913. The exported values come from the chain registry;
 * the literals below are the reviewed production pins. If the registry ever moves, this module
 * refuses to load rather than let the funding indexer and withdrawal route quietly follow it.
 */
const REVIEWED_FUNDING_CHAIN_ID = 8453;
const REVIEWED_FUNDING_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
if (CHAINS.base.chainId !== REVIEWED_FUNDING_CHAIN_ID || CHAINS.base.usdc.asset !== REVIEWED_FUNDING_USDC) {
  throw new Error('Chain registry no longer matches the reviewed Base funding pins');
}

export const BASE_MAINNET_CHAIN_ID = CHAINS.base.chainId;
export const BASE_MAINNET_USDC = CHAINS.base.usdc.asset;

export interface PrivyAuthConfig {
  ownerId?: string;
  appId: string;
  appSecret?: string;
  jwtVerificationKey?: string;
}

const privyAuthKeys = [
  'MEOWWA_PRIVY_OWNER_ID',
  'PRIVY_APP_ID',
  'PRIVY_JWT_VERIFICATION_KEY',
] as const;

export function loadPrivyAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { tenantMode?: boolean } = {},
): PrivyAuthConfig | undefined {
  const requiredKeys = options.tenantMode
    // Current Privy apps publish rotating ES256 keys at their app-scoped JWKS endpoint. The
    // official Node client consumes that endpoint when no static override is supplied, so tenant
    // deployments need the server credential but do not need to freeze one public key in Secret
    // Manager. Legacy deployments may retain the explicit key during migration.
    ? ['PRIVY_APP_ID', 'PRIVY_APP_SECRET'] as const
    : privyAuthKeys;
  const requested = privyAuthKeys.some((key) => Boolean(env[key]?.trim()));
  if (!requested) return undefined;
  if (options.tenantMode && env.MEOWWA_PRIVY_OWNER_ID?.trim()) {
    throw new Error('MEOWWA_PRIVY_OWNER_ID must be unset in multi-tenant Privy authentication mode');
  }
  const values = Object.fromEntries(requiredKeys.map((key) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing Privy owner authentication configuration: ${key}`);
    return [key, value];
  })) as Record<typeof requiredKeys[number], string>;
  return {
    appId: values.PRIVY_APP_ID,
    ...(env.PRIVY_JWT_VERIFICATION_KEY?.trim()
      ? { jwtVerificationKey: env.PRIVY_JWT_VERIFICATION_KEY.trim() }
      : {}),
    ...(env.PRIVY_APP_SECRET?.trim() ? { appSecret: env.PRIVY_APP_SECRET.trim() } : {}),
    ...(!options.tenantMode ? { ownerId: env.MEOWWA_PRIVY_OWNER_ID!.trim() } : {}),
  };
}
