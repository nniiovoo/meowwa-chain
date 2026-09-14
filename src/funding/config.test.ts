import { describe, expect, it } from 'vitest';
import { loadPrivyAuthConfig } from './config.js';


describe('Privy authentication configuration', () => {
  it('loads independently from Stripe and funding configuration', () => {
    expect(loadPrivyAuthConfig({
      MEOWWA_PRIVY_OWNER_ID: 'did:privy:owner_123',
      PRIVY_APP_ID: 'app_123',
      PRIVY_JWT_VERIFICATION_KEY: 'public-verification-key',
    })).toEqual({
      ownerId: 'did:privy:owner_123',
      appId: 'app_123',
      jwtVerificationKey: 'public-verification-key',
    });
  });

  it('fails closed on a partial Privy authentication configuration', () => {
    expect(() => loadPrivyAuthConfig({ PRIVY_APP_ID: 'app_123' })).toThrow(
      'Missing Privy owner authentication configuration: MEOWWA_PRIVY_OWNER_ID',
    );
  });

  it('requires message-verification credentials for multi-tenant Privy authentication', () => {
    expect(() => loadPrivyAuthConfig({
      PRIVY_APP_ID: 'app_123',
      PRIVY_JWT_VERIFICATION_KEY: 'public-verification-key',
    }, { tenantMode: true })).toThrow(
      'Missing Privy owner authentication configuration: PRIVY_APP_SECRET',
    );
    expect(loadPrivyAuthConfig({
      PRIVY_APP_ID: 'app_123',
      PRIVY_APP_SECRET: 'app-secret',
    }, { tenantMode: true })).toEqual({
      appId: 'app_123',
      appSecret: 'app-secret',
    });
    expect(loadPrivyAuthConfig({
      PRIVY_APP_ID: 'app_123',
      PRIVY_APP_SECRET: 'app-secret',
      PRIVY_JWT_VERIFICATION_KEY: 'public-verification-key',
    }, { tenantMode: true })).toEqual({
      appId: 'app_123',
      appSecret: 'app-secret',
      jwtVerificationKey: 'public-verification-key',
    });
  });

  // A test asserting on the Kubernetes deployment README lived here. That README is operator
  // infrastructure and is not published in this repository, so the case was removed rather than
  // stubbed. It still runs in the private application repository.
});
