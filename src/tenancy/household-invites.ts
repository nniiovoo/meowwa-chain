import { createHash, randomBytes } from 'node:crypto';

const invitePattern = /^invite_[A-Za-z0-9_-]{43}$/;

export function householdInviteTokenHash(token: string): string {
  if (!invitePattern.test(token)) throw new Error('Household invite token is invalid');
  return createHash('sha256').update('meowwa:household-invite:v1\0', 'utf8').update(token, 'utf8').digest('hex');
}

export function issueHouseholdInvite(): { token: string; tokenHash: string } {
  const token = `invite_${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: householdInviteTokenHash(token) };
}
