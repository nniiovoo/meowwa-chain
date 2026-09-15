/**
 * The owner step-up confirmation envelope, and the one number derived from it.
 *
 * This module is the money-safety slice of the step-up boundary: the exact bytes an owner is asked
 * to sign before a financial control moves, and the ceiling that shape implies. The routes that
 * mint, parse and exchange these challenges live outside this tree; what is needed here is the
 * formatter and its measured maximum, because the funding verifier
 * (`funding/privy.ts`) has its own independent ceiling and the two must not drift apart.
 */
import { randomUUID } from 'node:crypto';

/**
 * Every action an owner-scoped step-up can confirm. Only the widest entry matters to the envelope
 * size, but the list is kept whole so the bound stays derived rather than written down twice.
 */
const ownerStepUpActions = [
  'purchase-approve', 'purchase-execute', 'purchase-approve-and-execute', 'policy-change', 'autonomy-enable', 'autonomy-recover',
  'mandate-resume', 'mandate-reauthorize', 'mandate-revoke', 'mandate-scope-update', 'privacy-export', 'wallet-revoke', 'wallet-recover',
  'account-closure', 'emergency-clear', 'session-revoke-all', 'support-resolve',
  'wallet-control-provision', 'wallet-control-pause', 'wallet-withdrawal',
  'withdrawal-destination-register', 'wallet-resume',
  'pet-archive', 'pet-restore', 'pet-delete', 'governance-approve',
] as const;

// Owner-scoped step-ups use the owner subject as the resource ID, and the auth boundary accepts
// subjects up to 512 bytes. A narrower cap here locks long-subject owners out of every
// owner-scoped confirmation, including account closure and emergency clearing.
const MAX_RESOURCE_ID_CHARACTERS = 512;
const MAX_ACTION_CHARACTERS = Math.max(...ownerStepUpActions.map((action) => action.length));

/**
 * A disclosure that does not fit is refused, never truncated. Truncation is itself a disclosure
 * hole: a client that controls any part of an intent can pad it until the terms that matter fall
 * off the end of the line the owner reads, while the signature still binds them.
 *
 * The budget is chosen so the honest disclosures the product actually produces clear it with room
 * to grow, and everything downstream of it (the signed envelope, the parser, the verifier) is
 * derived from it rather than written down again. Two copies of this number is what made the
 * owner's own policy change unsignable once the disclosure grew. It only ever moves up.
 */
const MAX_DETAIL_CHARACTERS = 2_100;

const PRIVY_CHALLENGE_TTL_SECONDS = 5 * 60;
const PRIVY_CHALLENGE_TTL_MS = PRIVY_CHALLENGE_TTL_SECONDS * 1_000;

/**
 * The exact text an owner signs. Every bound above is the one this formatter writes with; a parser
 * or verifier stricter than it mints challenges that can never be exchanged.
 */
function stepUpMessage(input: {
  action: string; resourceId: string; details: string; intentHash: string; nonce: string; issuedAt: number;
}): string {
  return [
    'MeowWa owner confirmation v3',
    `Expires in: ${PRIVY_CHALLENGE_TTL_SECONDS} seconds`,
    `Action: ${input.action}`,
    `Resource: ${input.resourceId}`,
    `Details: ${input.details}`,
    `Intent: ${input.intentHash}`,
    `Nonce: ${input.nonce}`,
    `IssuedAt: ${input.issuedAt}`,
    `ExpiresAt: ${input.issuedAt + PRIVY_CHALLENGE_TTL_MS}`,
  ].join('\n');
}

/**
 * Measured off the formatter itself, at every field's maximum, so no second copy of the envelope
 * size exists to drift from it. `funding/privy.ts` refused anything over its own ceiling while this
 * envelope had grown past it, which did not weaken a signature -- it locked the owner out of
 * changing policy, adjusting autonomy and resolving support at all. `privy.test.ts` pins the two
 * together.
 */
export const MAX_STEP_UP_MESSAGE_CHARACTERS = stepUpMessage({
  action: 'a'.repeat(MAX_ACTION_CHARACTERS),
  resourceId: 'r'.repeat(MAX_RESOURCE_ID_CHARACTERS),
  details: 'd'.repeat(MAX_DETAIL_CHARACTERS),
  intentHash: 'f'.repeat(64),
  nonce: randomUUID(),
  // The largest issuedAt whose expiresAt is still 13 digits, i.e. the widest both lines can be.
  issuedAt: 9_999_999_999_999 - PRIVY_CHALLENGE_TTL_MS,
}).length;

/**
 * Characters that cannot survive being read aloud in a confirmation: control and separator classes,
 * and the space-lookalikes that are not a space. Line breaks are what a forger would use to fake a
 * second field inside a signed message, so they fail here rather than being rewritten.
 */
const unstatableCharacters = /[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

/**
 * The zero-width joiner inside an emoji sequence is exempt, and only for this test. A family emoji
 * is one glyph to a reader and several code points to a parser, and refusing it would refuse an
 * ordinary pet name. Nothing stored, signed or displayed is altered by the exemption.
 */
const emojiZeroWidthJoiner = /(?<=\p{Extended_Pictographic}️?)‍(?=\p{Extended_Pictographic})/gu;

/** Whether text can be stated verbatim in an owner confirmation without being rewritten. */
export function isDisclosableText(text: string): boolean {
  return !unstatableCharacters.test(text.replaceAll(emojiZeroWidthJoiner, ''));
}

/** The 400 those routes answer with, in one place so all of them say the same thing. */
export const DISCLOSABLE_TEXT_REQUIREMENT =
  'Text cannot contain line breaks or control, invisible or text-direction characters';
