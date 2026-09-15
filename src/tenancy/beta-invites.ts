import { createHash, randomBytes } from 'node:crypto';

const betaInvitePattern = /^beta_[A-Za-z0-9_-]{43}$/;

export function betaInviteTokenHash(token: string): string {
  if (!betaInvitePattern.test(token)) throw new Error('Beta invite token is invalid');
  return createHash('sha256').update('meowwa:beta-invite:v1\0', 'utf8').update(token, 'utf8').digest('hex');
}

export function issueBetaInvite(): { token: string; tokenHash: string } {
  const token = `beta_${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: betaInviteTokenHash(token) };
}
