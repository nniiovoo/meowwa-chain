import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthorizationSigner, loadSandboxAuthorizationSigner } from './signer.js';

const directories: string[] = [];

function keyFile(curve = 'prime256v1'): { path: string; publicKey: KeyObject } {
  const directory = mkdtempSync(join(tmpdir(), 'meowwa-agent-auth-')); directories.push(directory);
  const keys = generateKeyPairSync('ec', { namedCurve: curve });
  const path = join(directory, 'authorization-key.pem');
  writeFileSync(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { path, publicKey: keys.publicKey };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('sandbox P-256 authorization signer', () => {
  it('returns only a base64 DER signature that verifies for the exact payload', async () => {
    const { path, publicKey } = keyFile();
    const signer = loadSandboxAuthorizationSigner({ keyPath: path, nodeEnv: 'development' });
    const payload = new TextEncoder().encode('exact Privy request payload');
    const signature = await signer.sign(payload);
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(signature).not.toContain('PRIVATE KEY');
    expect(verify('sha256', payload, publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    expect(verify('sha256', new TextEncoder().encode('different'), publicKey, Buffer.from(signature, 'base64'))).toBe(false);
  });

  it('rejects production, relative paths, permissive files, and non-P-256 keys', () => {
    const p256 = keyFile();
    expect(() => loadSandboxAuthorizationSigner({ keyPath: p256.path, nodeEnv: 'production' })).toThrow('production');
    expect(() => loadSandboxAuthorizationSigner({ keyPath: './relative.pem', nodeEnv: 'test' })).toThrow('absolute');
    chmodSync(p256.path, 0o644);
    expect(() => loadSandboxAuthorizationSigner({ keyPath: p256.path, nodeEnv: 'test' })).toThrow('0600');
    const wrongCurve = keyFile('secp256k1');
    expect(() => loadSandboxAuthorizationSigner({ keyPath: wrongCurve.path, nodeEnv: 'test' })).toThrow('P-256');
  });

  it('loads the same restricted signer for the isolated production wallet workload', async () => {
    const { path, publicKey } = keyFile();
    const payload = new TextEncoder().encode('tenant wallet authorization payload');
    const signature = await loadAuthorizationSigner(path).sign(payload);
    expect(verify('sha256', payload, publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  });
});
