import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type AuthPrincipalType = 'owner' | 'member' | 'service';

export interface AuthPrincipal {
  type: AuthPrincipalType;
  subject: string;
  tenantId?: string;
  ownerId?: string;
  tokenId?: string;
  memberId?: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  audience: 'meowwa-api';
}

export interface StepUpClaims {
  version: 1 | 2;
  subject: string;
  tenantId?: string;
  action: string;
  resourceId: string;
  intentHash: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  audience: 'meowwa-step-up';
}

export interface StepUpReplayStore {
  consume(fingerprint: string, expiresAt: number, tenantId?: string): boolean | Promise<boolean>;
}

export interface StepUpContext {
  resourceId: string;
  intentHash: string;
}

const MIN_SECRET_BYTES = 32;
const MAX_AUTH_LIFETIME_SECONDS = 60 * 60;
const MAX_STEP_UP_LIFETIME_SECONDS = 5 * 60;

function assertStrongSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) throw new Error('Authentication secret must be at least 32 bytes');
}

export function isStrongAuthSecret(secret: string | undefined): boolean {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= MIN_SECRET_BYTES;
}

/**
 * Deepest intent this hash pre-image will canonicalize. `stepUpSchema.intent` is an open record and
 * the governance intent is arbitrary JSON, so a body far inside the 256 KB limit could nest deep
 * enough to overflow the stack — a RangeError, which is not a ZodError, so the error handler turned
 * a malformed input into a 500. Well above anything a real intent nests (the deepest is the
 * wallet-control batch scope at four levels).
 */
const MAX_INTENT_DEPTH = 64;

export class IntentTooDeepError extends Error {
  /**
   * What makes the backstop answer what it means. Nothing catches this class, and app.ts's error
   * handler reports 500 for anything that is neither a ZodError nor carries a 4xx `statusCode`, so
   * the guard below rejected a malformed body as a server fault — on a step-up path, where an
   * operator reads a 500 as an outage in the credential the owner is waiting on.
   */
  readonly statusCode = 400;

  constructor() {
    super('Step-up intent is nested too deeply');
    this.name = 'IntentTooDeepError';
  }
}

/**
 * The same bound, applied iteratively so it can be used as a schema refinement before anything
 * recursive touches the value. `canonicalize` keeps its own guard as a backstop for callers that
 * do not go through a schema.
 */
export function intentDepthWithinBound(value: unknown): boolean {
  const pending: Array<[unknown, number]> = [[value, 0]];
  while (pending.length > 0) {
    const [current, depth] = pending.pop()!;
    if (depth > MAX_INTENT_DEPTH) return false;
    if (Array.isArray(current)) {
      for (const item of current) pending.push([item, depth + 1]);
    } else if (current !== null && typeof current === 'object') {
      for (const item of Object.values(current)) pending.push([item, depth + 1]);
    }
  }
  return true;
}

type KeyOrder = (left: string, right: string) => number;

/**
 * What every deployed replica computes, and therefore what this function keeps minting.
 *
 * It is the wrong ordering: a collator resolves against the runtime's ICU build, so the canonical
 * byte string of a security-critical pre-image is a property of the Node image rather than of the
 * data — 'periodLimitMinor' sorts before 'perTransactionLimitMinor' under ICU and after it by code
 * point. Swapping it for `codePointKeyOrder` outright is what cannot be done in one deploy:
 * `validateGovernanceApprovals` re-derives a stored `approval.fingerprint` on every hydration, so
 * three replicas on one database, rolling, read each other's fingerprints — and the replica on the
 * other version rejects the tenant snapshot whole rather than the approval.
 */
const collationKeyOrder: KeyOrder = (left, right) => left.localeCompare(right);

/** What it should be: a property of the data alone. Accepted everywhere, minted nowhere yet. */
const codePointKeyOrder: KeyOrder = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function canonicalize(value: unknown, order: KeyOrder, depth = 0): unknown {
  if (depth > MAX_INTENT_DEPTH) throw new IntentTooDeepError();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, order, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => order(left, right))
      .map(([key, item]) => [key, canonicalize(item, order, depth + 1)]));
  }
  return value;
}

function intentDigest(value: unknown, order: KeyOrder): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value, order))).digest('hex');
}

export function stepUpIntentHash(value: unknown): string {
  return intentDigest(value, collationKeyOrder);
}

/**
 * The verification half of the pair above, and the only thing that makes the ordering movable: a
 * fingerprint minted under either ordering verifies against the same pre-image, so a record written
 * by an older replica, a newer one, or the same code on a Node build with a different ICU is
 * readable by all of them. Nothing else is relaxed — the pre-image still has to be exactly the one
 * that was signed for, and neither digest is accepted for a different one.
 *
 * That is what a later deploy needs: once every replica accepts both, minting can move to
 * `codePointKeyOrder` with no flag day, because the fingerprints it writes already verify on the
 * replicas still minting `collationKeyOrder`.
 */
export function stepUpIntentHashMatches(value: unknown, fingerprint: string): boolean {
  return fingerprint === intentDigest(value, collationKeyOrder) ||
    fingerprint === intentDigest(value, codePointKeyOrder);
}

interface AuthClaims {
  version: 1 | 2;
  type: AuthPrincipalType;
  subject: string;
  tenantId?: string;
  ownerId?: string;
  tokenId?: string;
  memberId?: string;
  scopes: string[];
  audience: 'meowwa-api';
  issuedAt: number;
  expiresAt: number;
}

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signature(input: string, secret: string): string {
  return encode(createHmac('sha256', secret).update(input).digest());
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalTenantId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

export function createAuthToken(input: {
  type: AuthPrincipalType;
  subject: string;
  tenantId?: string;
  ownerId?: string;
  memberId?: string;
  scopes?: string[];
  expiresInSeconds: number;
}, secret: string, now = Date.now()): string {
  assertStrongSecret(secret);
  if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0 || input.expiresInSeconds > MAX_AUTH_LIFETIME_SECONDS) {
    throw new Error('Auth token configuration is invalid');
  }
  if (input.tenantId !== undefined && !isCanonicalTenantId(input.tenantId)) throw new Error('Auth token tenant ID is invalid');
  const version = input.tenantId ? 2 : 1;
  const ownerId = version === 2 ? (input.ownerId ?? (input.type === 'owner' ? input.subject : undefined)) : undefined;
  const tokenId = version === 2 ? randomUUID() : undefined;
  if (version === 2 && (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 512 || ownerId.trim() !== ownerId)) {
    throw new Error('Auth token owner binding is invalid');
  }
  if (version === 1 && input.ownerId !== undefined) throw new Error('Auth token owner binding requires a tenant');
  const claims: AuthClaims = {
    version,
    type: input.type,
    subject: input.subject,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(tokenId ? { tokenId } : {}),
    ...(input.memberId ? { memberId: input.memberId } : {}),
    scopes: [...new Set(input.scopes ?? [])],
    audience: 'meowwa-api',
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + input.expiresInSeconds,
  };
  const payload = encode(JSON.stringify(claims));
  const unsigned = `v${version}.${payload}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifyAuthToken(
  token: string,
  secret: string,
  now = Date.now(),
  options: { requireTenant?: boolean } = {},
): AuthPrincipal {
  assertStrongSecret(secret);
  const parts = token.split('.');
  if (parts.length !== 3 || (parts[0] !== 'v1' && parts[0] !== 'v2')) throw new Error('Invalid auth token');
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(unsigned, secret));
  const received = Buffer.from(parts[2] ?? '');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('Invalid auth token');

  let claims: Partial<AuthClaims>;
  try {
    claims = JSON.parse(decode(parts[1] ?? '')) as Partial<AuthClaims>;
  } catch {
    throw new Error('Invalid auth token');
  }
  const nowSeconds = Math.floor(now / 1000);
  const expectedVersion = parts[0] === 'v2' ? 2 : 1;
  if (claims.version !== expectedVersion || claims.audience !== 'meowwa-api' ||
    (claims.type !== 'owner' && claims.type !== 'member' && claims.type !== 'service') ||
    typeof claims.subject !== 'string' || claims.subject.length === 0 ||
    (expectedVersion === 2 ? !isCanonicalTenantId(claims.tenantId) : claims.tenantId !== undefined) ||
    (expectedVersion === 2
      ? typeof claims.ownerId !== 'string' || claims.ownerId.length === 0 || claims.ownerId.length > 512 || claims.ownerId.trim() !== claims.ownerId
      : claims.ownerId !== undefined) ||
    (expectedVersion === 2
      ? typeof claims.tokenId !== 'string' || !CANONICAL_UUID.test(claims.tokenId)
      : claims.tokenId !== undefined) ||
    (options.requireTenant === true && expectedVersion !== 2) ||
    (claims.memberId !== undefined && (typeof claims.memberId !== 'string' || claims.memberId.length === 0)) ||
    !Number.isInteger(claims.issuedAt) || !Number.isInteger(claims.expiresAt) ||
    (claims.issuedAt as number) > nowSeconds + 60 || (claims.expiresAt as number) <= nowSeconds ||
    (claims.expiresAt as number) - (claims.issuedAt as number) > MAX_AUTH_LIFETIME_SECONDS ||
    !Array.isArray(claims.scopes) || claims.scopes.some((scope) => typeof scope !== 'string')) {
    throw new Error('Invalid auth token');
  }
  return {
    type: claims.type,
    subject: claims.subject,
    ...(claims.tenantId ? { tenantId: claims.tenantId } : {}),
    ...(claims.ownerId ? { ownerId: claims.ownerId } : {}),
    ...(claims.tokenId ? { tokenId: claims.tokenId } : {}),
    ...(claims.memberId ? { memberId: claims.memberId } : {}),
    scopes: claims.scopes,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    audience: claims.audience,
  } as AuthPrincipal;
}

export function authHeaderToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export function createStepUpToken(input: { subject: string; tenantId?: string; action: string; resourceId: string; intentHash: string; expiresInSeconds: number }, secret: string, now = Date.now()): string {
  assertStrongSecret(secret);
  if (!input.subject || !input.action || !input.resourceId || !/^[a-f0-9]{64}$/.test(input.intentHash) ||
    !Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0 || input.expiresInSeconds > MAX_STEP_UP_LIFETIME_SECONDS) {
    throw new Error('Step-up token configuration is invalid');
  }
  if (input.tenantId !== undefined && !isCanonicalTenantId(input.tenantId)) throw new Error('Step-up token tenant ID is invalid');
  const version = input.tenantId ? 2 : 1;
  const claims = {
    version, subject: input.subject, ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    action: input.action, resourceId: input.resourceId, intentHash: input.intentHash,
    nonce: randomUUID(), audience: 'meowwa-step-up' as const,
    issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + input.expiresInSeconds,
  };
  const payload = encode(JSON.stringify(claims));
  const unsigned = `su${version}.${payload}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifyStepUpToken(
  token: string,
  secret: string,
  now = Date.now(),
  options: { requireTenant?: boolean; expectedTenantId?: string } = {},
): StepUpClaims {
  assertStrongSecret(secret);
  const parts = token.split('.');
  if (parts.length !== 3 || (parts[0] !== 'su1' && parts[0] !== 'su2')) throw new Error('Invalid step-up token');
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(unsigned, secret));
  const received = Buffer.from(parts[2] ?? '');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('Invalid step-up token');
  let claims: Partial<StepUpClaims>;
  try {
    claims = JSON.parse(decode(parts[1] ?? '')) as Partial<StepUpClaims>;
  } catch {
    throw new Error('Invalid step-up token');
  }
  const nowSeconds = Math.floor(now / 1000);
  const expectedVersion = parts[0] === 'su2' ? 2 : 1;
  if (claims.version !== expectedVersion || claims.audience !== 'meowwa-step-up' || typeof claims.subject !== 'string' || typeof claims.action !== 'string' ||
    (expectedVersion === 2 ? !isCanonicalTenantId(claims.tenantId) : claims.tenantId !== undefined) ||
    (options.requireTenant === true && expectedVersion !== 2) ||
    (options.expectedTenantId !== undefined && claims.tenantId !== options.expectedTenantId) ||
    typeof claims.resourceId !== 'string' || typeof claims.intentHash !== 'string' || typeof claims.nonce !== 'string' ||
    !claims.subject || !claims.action || !claims.resourceId || !/^[a-f0-9]{64}$/.test(claims.intentHash) || !claims.nonce ||
    !Number.isInteger(claims.issuedAt) || !Number.isInteger(claims.expiresAt) ||
    (claims.issuedAt as number) > nowSeconds + 60 || (claims.expiresAt as number) <= nowSeconds ||
    (claims.expiresAt as number) - (claims.issuedAt as number) > MAX_STEP_UP_LIFETIME_SECONDS) throw new Error('Invalid step-up token');
  return claims as StepUpClaims;
}

export async function consumeVerifiedStepUp(
  headers: Record<string, unknown>,
  claimed: unknown,
  action: string,
  consumedTokens: Set<string> | StepUpReplayStore,
  expected?: StepUpContext,
): Promise<boolean> {
  if (headers['x-auth-mode'] === 'legacy') return claimed === true;
  if (claimed !== true || headers['x-step-up-action'] !== action) return false;
  if (expected && (headers['x-step-up-resource'] !== expected.resourceId || headers['x-step-up-intent'] !== expected.intentHash)) return false;
  const token = headers['x-step-up-token'];
  if (typeof token !== 'string') return false;
  const fingerprint = createHash('sha256').update(token).digest('hex');
  if ('consume' in consumedTokens) {
    const expiresAt = Number(headers['x-step-up-expires-at']);
    const tenantId = headers['x-meowwa-tenant-id'];
    return Number.isInteger(expiresAt) && await consumedTokens.consume(
      fingerprint,
      expiresAt,
      typeof tenantId === 'string' ? tenantId : undefined,
    );
  }
  if (consumedTokens.has(fingerprint)) return false;
  consumedTokens.add(fingerprint);
  return true;
}
