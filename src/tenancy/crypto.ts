import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function canonicalTenantEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('Tenant state encryption key must be a canonical base64-encoded 32-byte key');
  }
  return key;
}

export function tenantEncryptionKeyId(key: Buffer): string {
  if (key.length !== 32) throw new Error('Tenant encryption key ID input is invalid');
  return createHash('sha256')
    .update('meowwa:tenant-encryption-key:v1\0', 'utf8')
    .update(key)
    .digest('hex');
}

export function encryptTenantJson(key: Buffer, aad: string, plaintext: string): string {
  const iv = randomBytes(12);
  const keyId = tenantEncryptionKeyId(key);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${aad}\0${keyId}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:v2:${keyId}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptTenantJson(key: Buffer, aad: string, value: string): string {
  const parts = value.split(':');
  const version = parts[0] === 'enc' ? parts[1] : undefined;
  if ((version === 'v1' && parts.length !== 5) || (version === 'v2' && parts.length !== 6) ||
    (version !== 'v1' && version !== 'v2')) throw new Error('Invalid encrypted tenant data');
  try {
    const keyId = version === 'v2' ? parts[2]! : undefined;
    if (keyId !== undefined && keyId !== tenantEncryptionKeyId(key)) throw new Error('key mismatch');
    const offset = version === 'v2' ? 1 : 0;
    // authTagLength pins the tag at the full 16 bytes. Without it Node accepts a truncated tag, so
    // a forger needs 2^32 attempts rather than 2^128 -- the same defect fixed in
    // postgres-repository.ts, and this decoder covers far more than the tenant snapshot.
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2 + offset]!, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(keyId === undefined ? aad : `${aad}\0${keyId}`));
    decipher.setAuthTag(Buffer.from(parts[3 + offset]!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[4 + offset]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Invalid encrypted tenant data');
  }
}

export function encryptedTenantJsonKeyId(value: string): string | undefined {
  const parts = value.split(':');
  return parts.length === 6 && parts[0] === 'enc' && parts[1] === 'v2' && /^[0-9a-f]{64}$/.test(parts[2]!)
    ? parts[2]
    : undefined;
}

export function isCanonicalEncryptedTenantJson(value: string): boolean {
  const parts = value.split(':');
  const version = parts[0] === 'enc' ? parts[1] : undefined;
  if ((version === 'v1' && parts.length !== 5) || (version === 'v2' && parts.length !== 6) ||
    (version !== 'v1' && version !== 'v2')) return false;
  try {
    const offset = version === 'v2' ? 1 : 0;
    if (version === 'v2' && !/^[0-9a-f]{64}$/.test(parts[2]!)) return false;
    const iv = Buffer.from(parts[2 + offset]!, 'base64url');
    const tag = Buffer.from(parts[3 + offset]!, 'base64url');
    const ciphertext = Buffer.from(parts[4 + offset]!, 'base64url');
    return iv.length === 12 && tag.length === 16 && ciphertext.length > 0 &&
      iv.toString('base64url') === parts[2 + offset] && tag.toString('base64url') === parts[3 + offset] &&
      ciphertext.toString('base64url') === parts[4 + offset];
  } catch {
    return false;
  }
}
