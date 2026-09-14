import { createPrivateKey, sign as signPayload, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface SandboxAuthorizationSigner {
  sign(payload: Uint8Array): Promise<string>;
}

function loadP256Key(keyPath: string): KeyObject {
  if (!isAbsolute(keyPath)) throw new Error('Agent authorization key path must be absolute');
  const file = statSync(keyPath);
  if (!file.isFile()) throw new Error('Agent authorization key path must be a regular file');
  if ((file.mode & 0o077) !== 0) throw new Error('Agent authorization key file must use mode 0600');
  if (file.size <= 0 || file.size > 16_384) throw new Error('Agent authorization key file has an invalid size');
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Agent authorization key must be a PKCS#8 P-256 private key');
  }
  return key;
}

export function loadSandboxAuthorizationSigner(input: {
  keyPath: string;
  nodeEnv?: string;
}): SandboxAuthorizationSigner {
  if (input.nodeEnv === 'production') throw new Error('Sandbox authorization signer is refused in production');
  return loadAuthorizationSigner(input.keyPath);
}

export function loadAuthorizationSigner(keyPath: string): SandboxAuthorizationSigner {
  const key = loadP256Key(keyPath);
  return {
    async sign(payload: Uint8Array): Promise<string> {
      if (!(payload instanceof Uint8Array) || payload.byteLength === 0 || payload.byteLength > 1_000_000) {
        throw new Error('Invalid authorization payload');
      }
      return signPayload('sha256', payload, { key, dsaEncoding: 'der' }).toString('base64');
    },
  };
}
