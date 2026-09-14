import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { AutonomyMandate, SignedMandateProof } from '@meowwa/chain-domain';
import type { PetMandate } from './store/memory-store.js';

export interface MandateAuthority {
  keyId: string;
  publicKey: string;
}

export interface MandateSigner extends MandateAuthority {
  sign(payload: string): string;
}

function keyId(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

export function createLocalMandateSigner(): MandateSigner {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    keyId: keyId(publicKey),
    publicKey,
    sign: (payload) => sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
  };
}

export function createMandateSignerFromPrivateKey(privateKeyBase64: string): MandateSigner {
  const encodedPrivateKey = Buffer.from(privateKeyBase64, 'base64');
  const privateKey = createPrivateKey({ key: encodedPrivateKey, format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Mandate signing key must be Ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKeyPem).export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    keyId: keyId(publicKey), publicKey,
    sign: (payload) => sign(null, Buffer.from(payload), privateKey).toString('base64'),
  };
}

function canonicalAutonomyMandate(mandate: AutonomyMandate): string {
  return JSON.stringify({
    autonomyId: mandate.autonomyId, ownerId: mandate.ownerId, petId: mandate.petId, agentId: mandate.agentId,
    mode: mandate.mode, level: mandate.level ?? 'automatic_replenishment',
    allowedNeedCode: mandate.allowedNeedCode, allowedMerchantId: mandate.allowedMerchantId, allowedProductId: mandate.allowedProductId,
    allowedProductIds: mandate.allowedProductIds ?? [mandate.allowedProductId],
    approvedAmountMinor: mandate.approvedAmountMinor, perTransactionLimitMinor: mandate.perTransactionLimitMinor,
    dailyLimitMinor: mandate.dailyLimitMinor, periodLimitMinor: mandate.periodLimitMinor, periodDays: mandate.periodDays,
    cooldownMinutes: mandate.cooldownMinutes, maxTransactionsPerPeriod: mandate.maxTransactionsPerPeriod,
    minimumSignalQuality: mandate.minimumSignalQuality, minimumInterpretationScore: mandate.minimumInterpretationScore,
    validFrom: mandate.validFrom, validUntil: mandate.validUntil, policyVersion: mandate.policyVersion,
    authorization: {
      kind: mandate.authorization.kind, approvedBy: mandate.authorization.approvedBy,
      approvedAt: mandate.authorization.approvedAt, displayedText: mandate.authorization.displayedText,
    },
  });
}

export function signAutonomyMandate(mandate: AutonomyMandate, signer: MandateSigner, signedAt = new Date().toISOString()): SignedMandateProof {
  const payload = canonicalAutonomyMandate(mandate);
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  return { algorithm: 'ed25519', keyId: signer.keyId, publicKey: signer.publicKey, payloadHash, signature: signer.sign(payload), signedAt };
}

export function verifyAutonomyMandate(mandate: AutonomyMandate, authority: MandateAuthority | undefined): boolean {
  const proof = mandate.authorization.proof;
  if (!authority || !proof || proof.algorithm !== 'ed25519' ||
    proof.keyId !== authority.keyId || proof.publicKey !== authority.publicKey ||
    keyId(proof.publicKey) !== proof.keyId) return false;
  const payload = canonicalAutonomyMandate(mandate);
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  if (payloadHash !== proof.payloadHash) return false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(proof.publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(payload), publicKey, Buffer.from(proof.signature, 'base64'));
  } catch {
    return false;
  }
}

export function canonicalPetMandate(mandate: PetMandate): string {
  return JSON.stringify({
    mandateId: mandate.mandateId, ownerId: mandate.ownerId, petId: mandate.petId, agentId: mandate.agentId,
    status: mandate.status, signatureVerified: mandate.signatureVerified, nonceValid: mandate.nonceValid,
    validFrom: mandate.validFrom, validUntil: mandate.validUntil, allowedNeeds: mandate.allowedNeeds,
    allowedCategories: mandate.allowedCategories, allowedMerchantIds: mandate.allowedMerchantIds,
    allowedProductIds: mandate.allowedProductIds, token: mandate.token, chainId: mandate.chainId,
    recipients: mandate.recipients, contracts: mandate.contracts, perTransactionLimitMinor: mandate.perTransactionLimitMinor,
    periodLimitMinor: mandate.periodLimitMinor, maxTransactions: mandate.maxTransactions,
    authorization: {
      kind: mandate.authorization.kind, approvedBy: mandate.authorization.approvedBy,
      approvedAt: mandate.authorization.approvedAt, displayedText: mandate.authorization.displayedText,
    },
  });
}

export function signPetMandate(mandate: PetMandate, signer: MandateSigner, signedAt = new Date().toISOString()): SignedMandateProof {
  const payload = canonicalPetMandate(mandate);
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  return { algorithm: 'ed25519', keyId: signer.keyId, publicKey: signer.publicKey, payloadHash, signature: signer.sign(payload), signedAt };
}

export function verifyPetMandate(mandate: PetMandate, authority: MandateAuthority | undefined): boolean {
  const proof = mandate.authorization.proof;
  if (!authority || !proof || proof.algorithm !== 'ed25519' ||
    proof.keyId !== authority.keyId || proof.publicKey !== authority.publicKey ||
    keyId(proof.publicKey) !== proof.keyId) return false;
  const payload = canonicalPetMandate(mandate);
  if (createHash('sha256').update(payload).digest('hex') !== proof.payloadHash) return false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(proof.publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(payload), publicKey, Buffer.from(proof.signature, 'base64'));
  } catch {
    return false;
  }
}
