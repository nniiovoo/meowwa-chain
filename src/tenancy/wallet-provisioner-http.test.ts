import { describe, expect, it, vi } from 'vitest';
import { paymentIntentDigest, type PaymentIntent } from '../adapters/wallet.js';
import { BASE_SEPOLIA_USDC } from '../wallet-control/policy.js';
import type { TenantWalletBinding } from './financial-repository.js';
import type { TenantWalletProvisioningClient } from './funding-routes.js';
import { TenantWalletProvisioningStageError } from './privy-wallet-provisioner.js';
import {
  buildTenantWalletProvisionerApp,
  HttpTenantWalletProvisioningClient,
} from './wallet-provisioner-http.js';
import { TenantWalletWebhookEventError, TenantWalletWebhookVerificationError } from './tenant-wallet-reconciliation.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const address = '0x1111111111111111111111111111111111111111';
const solanaAddress = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const token = Buffer.alloc(32, 11).toString('base64');

function binding(): TenantWalletBinding {
  return {
    tenantId, walletId: 'wallet_mochi', petId: 'pet_mochi', provider: 'privy',
    privyEmbeddedWalletId: 'embedded_mochi', smartWalletAddress: address,
    ownerQuorumId: 'quorum_owner_123', ownerPrivyUserId: null, revocationReason: null,
    agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123', policyDigest: 'a'.repeat(64),
    policyValidUntil: '2026-08-01T00:00:00.000Z', controlVerifiedAt: '2026-07-17T00:00:00.000Z',
    chainKey: 'base_sepolia', chainId: 84532, status: 'active',
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

/** The pet's Solana binding: the same pet, the suffixed wallet id, no numeric chain id. */
function solanaBinding(): TenantWalletBinding {
  return {
    ...binding(), walletId: 'wallet_mochi_solana', privyEmbeddedWalletId: 'embedded_mochi_solana',
    smartWalletAddress: solanaAddress, chainKey: 'solana_devnet', chainId: null,
  };
}

/** The wire contract deliberately omits the owner identity: only the provisioner workload needs it. */
function wire(value: TenantWalletBinding = binding()): Omit<TenantWalletBinding, 'ownerPrivyUserId' | 'revocationReason'> {
  const { ownerPrivyUserId, revocationReason, ...rest } = value;
  void ownerPrivyUserId;
  void revocationReason;
  return rest;
}

const request = {
  tenantId, ownerSubject: 'owner_a', privyUserId: 'did:privy:owner_a',
  petId: 'pet_mochi', walletId: 'wallet_mochi', chain: 'base_sepolia' as const,
};
const solanaRequest = { ...request, chain: 'solana_devnet' as const };

const complete = async () => binding();

function payment(): PaymentIntent {
  const fields: Omit<PaymentIntent, 'intentHash'> = {
    requestId: 'request_123', ownerId: 'owner_a', petId: 'pet_mochi', mandateId: 'mandate_alpha',
    merchantId: 'merchant_approved_1', productId: 'product_mouse_1', quantity: 1, amountMinor: 1299,
    currency: 'USDC', chainId: 84532, recipient: address, contract: BASE_SEPOLIA_USDC,
    quoteId: 'quote_mouse', quoteExpiresAt: '2026-07-17T23:30:00.000Z', requestNonce: 'nonce_12345678',
    approvedBy: 'owner_a', ownerConfirmationStatus: 'confirmed', requestedApprovalMode: 'EVERY_REQUEST',
    policyVersion: 'v1',
  };
  return { ...fields, intentHash: paymentIntentDigest(fields) };
}

describe('wallet provisioner workload HTTP boundary', () => {
  it('rejects identifiers and human-readable strings as service credentials', () => {
    expect(() => new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: tenantId, requestTimeoutMs: 5000,
    })).toThrow('canonical base64');
    expect(() => buildTenantWalletProvisionerApp({
      provisioner: { provision: async () => binding(), complete }, internalAuthToken: 'x'.repeat(44), ready: async () => true,
    })).toThrow('canonical base64');
  });

  it('calls only the exact internal HTTPS endpoint with a bearer service secret and validates the response', async () => {
    let captured: { input: string | URL | Request; init?: RequestInit } | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured = { input, ...(init === undefined ? {} : { init }) };
      return new Response(JSON.stringify({ wallet: wire() }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const client = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: fetcher as typeof fetch,
    });
    await expect(client.provision(request)).resolves.toEqual(binding());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(captured?.input).toBe('https://provisioner.internal.example/internal/v1/wallets/provision');
    expect(new Headers(captured?.init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(captured?.init?.body))).toEqual(request);
    expect(JSON.parse(String(captured?.init?.body))).not.toHaveProperty('ownerAuthorizationToken');
  });

  it('carries an owner-authorized preparation and completion across the private boundary without a user JWT', async () => {
    const attachment = {
      walletAddress: address,
      agentSignerId: 'quorum_agent_123',
      agentPolicyId: 'policy_123',
      expectedPolicyDigest: 'a'.repeat(64),
      policyValidUntil: '2026-08-01T00:00:00.000Z',
      removeExistingSigners: false,
    };
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return path.endsWith('/provision')
        ? Response.json({ status: 'owner-authorization-required', attachment }, { status: 202 })
        : Response.json({ wallet: wire() });
    });
    const client = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: fetcher as typeof fetch,
    });
    await expect(client.provision(request)).resolves.toEqual({ status: 'owner-authorization-required', attachment });
    const completion = { ...request, agentPolicyId: attachment.agentPolicyId,
      expectedPolicyDigest: attachment.expectedPolicyDigest, policyValidUntil: attachment.policyValidUntil };
    await expect(client.complete(completion)).resolves.toEqual(binding());
    expect(requests.map(({ path }) => path)).toEqual([
      '/internal/v1/wallets/provision', '/internal/v1/wallets/complete-provisioning',
    ]);
    expect(requests.every(({ body }) => !('ownerAuthorizationToken' in body))).toBe(true);
  });

  it('fails closed on a provider error or malformed cross-tenant response', async () => {
    let cancelled = false;
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    });
    const unavailable = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: (async () => new Response(errorBody, { status: 503 })) as typeof fetch,
    });
    await expect(unavailable.provision(request)).rejects.toThrow('unavailable');
    expect(cancelled).toBe(true);
    const wrongTenant = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: (async () => new Response(JSON.stringify({ wallet: { ...wire(), tenantId: '22222222-2222-4222-8222-222222222222' } }), { status: 200 })) as typeof fetch,
    });
    await expect(wrongTenant.provision(request)).rejects.toThrow('does not match');
  });

  it('exposes revocation verification only to an authenticated service caller', async () => {
    // This endpoint exists because the API holds no Privy app secret and so cannot verify
    // detachment itself. It must not be reachable without the internal service credential.
    const revocation = { verify: vi.fn(async () => ({ status: 'revoked' as const, reason: 'owner-authorized-detachment-verified' })) };
    const app = buildTenantWalletProvisionerApp({
      provisioner: { provision: async () => binding(), complete }, revocation, internalAuthToken: token, ready: async () => true,
    });
    try {
      const unauthenticated = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/verify-revocation',
        payload: { tenantId, petId: 'pet_mochi' },
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(revocation.verify).not.toHaveBeenCalled();

      const authenticated = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/verify-revocation',
        headers: { authorization: `Bearer ${token}` }, payload: { tenantId, petId: 'pet_mochi' },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toEqual({ status: 'revoked', reason: 'owner-authorized-detachment-verified' });
      expect(revocation.verify).toHaveBeenCalledWith({ tenantId, petId: 'pet_mochi' });

      // A pet with two bindings names the one to verify; the chain travels with the request.
      const solana = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/verify-revocation',
        headers: { authorization: `Bearer ${token}` }, payload: { tenantId, petId: 'pet_mochi', chain: 'solana_devnet' },
      });
      expect(solana.statusCode).toBe(200);
      expect(revocation.verify).toHaveBeenLastCalledWith({ tenantId, petId: 'pet_mochi', chain: 'solana_devnet' });
      const unknownChain = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/verify-revocation',
        headers: { authorization: `Bearer ${token}` }, payload: { tenantId, petId: 'pet_mochi', chain: 'solana' },
      });
      expect(unknownChain.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated internal requests before the Privy provisioner is called', async () => {
    const provisioner: TenantWalletProvisioningClient = { provision: vi.fn(async () => binding()), complete };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    const response = await app.inject({ method: 'POST', url: '/internal/v1/wallets/provision', payload: request });
    expect(response.statusCode).toBe(401);
    expect(provisioner.provision).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts one authenticated strict request and returns only the normalized binding', async () => {
    const provisioner: TenantWalletProvisioningClient = { provision: vi.fn(async () => binding()), complete };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    const response = await app.inject({
      method: 'POST', url: '/internal/v1/wallets/provision',
      headers: { authorization: `Bearer ${token}` }, payload: request,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ wallet: wire() });
    expect(provisioner.provision).toHaveBeenCalledWith(request);
    const injected = await app.inject({
      method: 'POST', url: '/internal/v1/wallets/provision', headers: { authorization: `Bearer ${token}` },
      payload: { ...request, attackerAddress: '0x2222222222222222222222222222222222222222' },
    });
    expect(injected.statusCode).toBe(400);
    expect(provisioner.provision).toHaveBeenCalledOnce();
    await app.close();
  });

  it('returns a strict 202 preparation and authenticates the matching completion route', async () => {
    const attachment = {
      walletAddress: address, agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
      expectedPolicyDigest: 'a'.repeat(64), policyValidUntil: '2026-08-01T00:00:00.000Z',
      removeExistingSigners: false,
    };
    const provisioner: TenantWalletProvisioningClient = {
      provision: vi.fn(async () => ({ status: 'owner-authorization-required' as const, attachment })),
      complete: vi.fn(async () => binding()),
    };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    const prepared = await app.inject({
      method: 'POST', url: '/internal/v1/wallets/provision',
      headers: { authorization: `Bearer ${token}` }, payload: request,
    });
    expect(prepared.statusCode).toBe(202);
    expect(prepared.json()).toEqual({ status: 'owner-authorization-required', attachment });
    const completion = { ...request, agentPolicyId: attachment.agentPolicyId,
      expectedPolicyDigest: attachment.expectedPolicyDigest, policyValidUntil: attachment.policyValidUntil };
    expect((await app.inject({ method: 'POST', url: '/internal/v1/wallets/complete-provisioning', payload: completion })).statusCode)
      .toBe(401);
    const completed = await app.inject({
      method: 'POST', url: '/internal/v1/wallets/complete-provisioning',
      headers: { authorization: `Bearer ${token}` }, payload: completion,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ wallet: wire() });
    expect(provisioner.complete).toHaveBeenCalledWith(completion);
    await app.close();
  });

  it('reports readiness from the dedicated database boundary and closes the provisioner once', async () => {
    const close = vi.fn(async () => undefined);
    const provisioner: TenantWalletProvisioningClient = { provision: async () => binding(), complete, close };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => false });
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('sends an exact tenant execution request through only the authenticated private endpoint', async () => {
    let captured: { input: string | URL | Request; init?: RequestInit } | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured = { input, ...(init === undefined ? {} : { init }) };
      return new Response(JSON.stringify({ submission: { status: 'pending', submissionId: `mw_${'a'.repeat(61)}` } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const client = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: fetcher as typeof fetch,
    });
    const input = { tenantId, ownerSubject: 'owner_a', payment: payment() };
    await expect(client.submit(input)).resolves.toEqual({ status: 'pending', submissionId: `mw_${'a'.repeat(61)}` });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(captured?.input).toBe('https://provisioner.internal.example/internal/v1/wallets/execute');
    expect(new Headers(captured?.init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(captured?.init?.body))).toEqual(input);
  });

  it('reports an ambiguous tenant execution outcome as unknown rather than a terminal failure', async () => {
    // The wallet service never answers 'failed' once it has attempted the Privy transfer, so a
    // lost response, a 5xx, or a body it cannot describe all mean "unknown". Returning 'failed'
    // here would release the budget reservation and tell the owner no funds were deducted.
    const input = { tenantId, ownerSubject: 'owner_a', payment: payment() };
    let cancelled = false;
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    });
    for (const fetcher of [
      (async () => { throw new Error('transport detail'); }) as typeof fetch,
      (async () => new Response(errorBody, { status: 503 })) as typeof fetch,
      (async () => new Response('{}', { status: 409 })) as typeof fetch,
      (async () => new Response(JSON.stringify({ submission: { status: 'pending', submissionId: 'wrong' } }), { status: 200 })) as typeof fetch,
      (async () => new Response(JSON.stringify({ submission: { status: 'confirmed', transactionHash: '0xshort', network: 'Base Sepolia', token: 'test USDC' } }), { status: 200 })) as typeof fetch,
    ]) {
      const client = new HttpTenantWalletProvisioningClient({
        baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000, fetch: fetcher,
      });
      await expect(client.submit(input)).rejects.toThrow(/Wallet service/);
    }
    expect(cancelled).toBe(true);
  });

  it('reports a pre-submission rejection from the wallet service as a terminal failure', async () => {
    const input = { tenantId, ownerSubject: 'owner_a', payment: payment() };
    for (const status of [400, 401, 403, 404, 413, 422]) {
      const client = new HttpTenantWalletProvisioningClient({
        baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
        fetch: (async () => new Response('{}', { status })) as typeof fetch,
      });
      await expect(client.submit(input)).resolves.toEqual({ status: 'failed', reason: 'WALLET_SERVICE_REJECTED' });
    }
  });

  it('authenticates and strictly validates the private execution route before invoking the service', async () => {
    const execute = vi.fn(async () => ({ status: 'pending' as const, submissionId: `mw_${'b'.repeat(61)}` }));
    const app = buildTenantWalletProvisionerApp({
      provisioner: { provision: async () => binding(), complete }, execution: { submit: execute },
      internalAuthToken: token, ready: async () => true,
    });
    const input = { tenantId, ownerSubject: 'owner_a', payment: payment() };
    expect((await app.inject({ method: 'POST', url: '/internal/v1/wallets/execute', payload: input })).statusCode).toBe(401);
    const invalid = await app.inject({
      method: 'POST', url: '/internal/v1/wallets/execute', headers: { authorization: `Bearer ${token}` },
      payload: { ...input, attackerWallet: address },
    });
    expect(invalid.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST', url: '/internal/v1/wallets/execute', headers: { authorization: `Bearer ${token}` }, payload: input,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ submission: { status: 'pending', submissionId: `mw_${'b'.repeat(61)}` } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(input);
    await app.close();
  });

  it('requires Privy signature headers and forwards the exact raw webhook to the verifier boundary', async () => {
    const process = vi.fn(async (...args: [Buffer, {
      'svix-id': string; 'svix-timestamp': string; 'svix-signature': string;
    }]) => {
      void args;
      return { received: true as const, duplicate: false, handled: true };
    });
    const app = buildTenantWalletProvisionerApp({
      provisioner: { provision: async () => binding(), complete }, webhookProcessor: { process },
      internalAuthToken: token, ready: async () => true,
    });
    const event = { type: 'transaction.confirmed', transaction_id: 'privy_tx_123' };
    expect((await app.inject({ method: 'POST', url: '/v1/webhooks/privy', payload: event })).statusCode).toBe(400);
    expect(process).not.toHaveBeenCalled();
    const accepted = await app.inject({
      method: 'POST', url: '/v1/webhooks/privy',
      headers: { 'svix-id': 'msg_123', 'svix-timestamp': '1784325600', 'svix-signature': 'valid' },
      payload: event,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ received: true, duplicate: false, handled: true });
    expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]?.[0].toString('utf8')).toBe(JSON.stringify(event));
    expect(process.mock.calls[0]?.[1]).toEqual({
      'svix-id': 'msg_123', 'svix-timestamp': '1784325600', 'svix-signature': 'valid',
    });
    await app.close();
  });

  it('maps verified webhook validation failures without exposing provider detail', async () => {
    for (const [error, status, type] of [
      [new TenantWalletWebhookVerificationError(), 400, 'invalid-privy-signature'],
      [new TenantWalletWebhookEventError(), 400, 'invalid-privy-event'],
      [new Error('database detail'), 503, 'privy-processing-unavailable'],
    ] as const) {
      const app = buildTenantWalletProvisionerApp({
        provisioner: { provision: async () => binding(), complete },
        webhookProcessor: { process: async () => { throw error; } },
        internalAuthToken: token, ready: async () => true,
      });
      const response = await app.inject({
        method: 'POST', url: '/v1/webhooks/privy',
        headers: { 'svix-id': 'msg_123', 'svix-timestamp': '1784325600', 'svix-signature': 'invalid' },
        payload: { type: 'transaction.confirmed' },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ type, status });
      expect(response.body).not.toContain('database detail');
      await app.close();
    }
  });
});

describe('wallet provisioner workload HTTP boundary on Solana Devnet', () => {
  it('carries the chain to the provisioner and accepts only the matching Solana binding back', async () => {
    let captured: { input: string | URL | Request; init?: RequestInit } | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured = { input, ...(init === undefined ? {} : { init }) };
      return Response.json({ wallet: wire(solanaBinding()) });
    });
    const client = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: fetcher as typeof fetch,
    });
    await expect(client.provision(solanaRequest)).resolves.toEqual(solanaBinding());
    expect(JSON.parse(String(captured?.init?.body))).toEqual(solanaRequest);

    // A Base binding does not answer a Solana request, and a Solana binding does not answer a Base one.
    const crossed = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: (async () => Response.json({ wallet: wire() })) as typeof fetch,
    });
    await expect(crossed.provision(solanaRequest)).rejects.toThrow('does not match');
    const reversed = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: (async () => Response.json({ wallet: wire(solanaBinding()) })) as typeof fetch,
    });
    await expect(reversed.provision(request)).rejects.toThrow('does not match');
  });

  it('validates the wire binding for its family: ids, address shape and attestation must agree with the registry', async () => {
    const attested = {
      ...wire(solanaBinding()), fundingChainKey: 'solana' as const, fundingChainId: null,
      fundingEnvironment: 'production' as const, custodyClassification: 'owner_controlled' as const,
      fundingVerifiedAt: '2026-07-17T00:00:00.000Z',
    };
    const ok = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: (async () => Response.json({ wallet: attested })) as typeof fetch,
    });
    await expect(ok.provision(solanaRequest)).resolves.toMatchObject({ fundingChainKey: 'solana', fundingChainId: null });

    for (const wallet of [
      { ...wire(solanaBinding()), chainId: 84532 },
      { ...wire(solanaBinding()), smartWalletAddress: address },
      { ...wire(), smartWalletAddress: solanaAddress },
      { ...wire(), chainId: null },
      { ...attested, fundingChainKey: 'base' },
      { ...attested, fundingChainId: 8453 },
      { ...wire(), fundingChainKey: 'base', fundingChainId: 8453, fundingEnvironment: 'production', custodyClassification: 'owner_controlled' },
    ]) {
      const client = new HttpTenantWalletProvisioningClient({
        baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
        fetch: (async () => Response.json({ wallet })) as typeof fetch,
      });
      await expect(client.provision(wallet.chainKey === 'solana_devnet' ? solanaRequest : request)).rejects.toThrow('invalid response');
    }
  });

  it('bridges the rollout in both directions: a chainless API request and a chainless provisioner binding both mean Base', async () => {
    const { chainKey, ...legacy } = wire();
    void chainKey;
    const client = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: (async () => Response.json({ wallet: legacy })) as typeof fetch,
    });
    await expect(client.provision(request)).resolves.toEqual(binding());

    const { chain, ...chainless } = request;
    void chain;
    const provisioner: TenantWalletProvisioningClient = { provision: vi.fn(async () => binding()), complete };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    try {
      const response = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/provision',
        headers: { authorization: `Bearer ${token}` }, payload: chainless,
      });
      expect(response.statusCode).toBe(200);
      expect(provisioner.provision).toHaveBeenCalledWith(request);
    } finally {
      await app.close();
    }
  });

  it('rejects a preparation whose wallet is not an address of the requested chain', async () => {
    const attachment = {
      walletAddress: address, agentSignerId: 'quorum_agent_123', agentPolicyId: 'policy_123',
      expectedPolicyDigest: 'a'.repeat(64), policyValidUntil: '2026-08-01T00:00:00.000Z', removeExistingSigners: false,
    };
    const client = new HttpTenantWalletProvisioningClient({
      baseUrl: 'https://provisioner.internal.example', authToken: token, requestTimeoutMs: 5000,
      fetch: (async () => Response.json({ status: 'owner-authorization-required', attachment }, { status: 202 })) as typeof fetch,
    });
    await expect(client.provision(solanaRequest)).rejects.toThrow('invalid response');
    await expect(client.provision(request)).resolves.toEqual({ status: 'owner-authorization-required', attachment });

    const provisioner: TenantWalletProvisioningClient = {
      provision: async () => ({ status: 'owner-authorization-required' as const, attachment }), complete,
    };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    try {
      const response = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/provision',
        headers: { authorization: `Bearer ${token}` }, payload: solanaRequest,
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(address);
    } finally {
      await app.close();
    }
  });

  it('serves a strict Solana provisioning round trip and rejects an unknown chain before the provisioner', async () => {
    const attachment = {
      walletAddress: solanaAddress, agentSignerId: 'quorum_agent_123',
      agentPolicyId: 'policy_123', expectedPolicyDigest: 'a'.repeat(64), policyValidUntil: '2026-08-01T00:00:00.000Z',
      removeExistingSigners: false,
    };
    const provisioner: TenantWalletProvisioningClient = {
      provision: vi.fn(async () => ({ status: 'owner-authorization-required' as const, attachment })),
      complete: vi.fn(async () => solanaBinding()),
    };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    try {
      const prepared = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/provision',
        headers: { authorization: `Bearer ${token}` }, payload: solanaRequest,
      });
      expect(prepared.statusCode).toBe(202);
      expect(prepared.json()).toEqual({ status: 'owner-authorization-required', attachment });
      expect(provisioner.provision).toHaveBeenCalledWith(solanaRequest);

      const completion = { ...solanaRequest, agentPolicyId: attachment.agentPolicyId,
        expectedPolicyDigest: attachment.expectedPolicyDigest, policyValidUntil: attachment.policyValidUntil };
      const completed = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/complete-provisioning',
        headers: { authorization: `Bearer ${token}` }, payload: completion,
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toEqual({ wallet: wire(solanaBinding()) });
      expect(provisioner.complete).toHaveBeenCalledWith(completion);

      const unknown = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/provision',
        headers: { authorization: `Bearer ${token}` }, payload: { ...request, chain: 'solana' },
      });
      expect(unknown.statusCode).toBe(400);
      expect(provisioner.provision).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('refuses to hand out a binding on another chain than the one requested', async () => {
    const provisioner: TenantWalletProvisioningClient = { provision: vi.fn(async () => binding()), complete: async () => binding() };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    try {
      const response = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/provision',
        headers: { authorization: `Bearer ${token}` }, payload: solanaRequest,
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(address);
    } finally {
      await app.close();
    }
  });

  it('redacts a Solana address from provider failure detail before it reaches the log', async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const provisioner: TenantWalletProvisioningClient = {
      provision: async () => {
        throw new TenantWalletProvisioningStageError('create-wallet', {
          status: 422, error: { code: 'invalid_wallet', message: `wallet ${solanaAddress} for did:privy:owner_a rejected` },
        });
      },
      complete: async () => binding(),
    };
    const app = buildTenantWalletProvisionerApp({ provisioner, internalAuthToken: token, ready: async () => true });
    try {
      const response = await app.inject({
        method: 'POST', url: '/internal/v1/wallets/provision',
        headers: { authorization: `Bearer ${token}` }, payload: solanaRequest,
      });
      expect(response.statusCode).toBe(500);
      const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === 'wallet-provisioner.stage-failed');
      expect(logged).toMatchObject({ stage: 'create-wallet', status: 422, code: 'invalid_wallet' });
      expect(String(logged?.detail)).not.toContain(solanaAddress);
      expect(String(logged?.detail)).not.toContain('owner_a');
    } finally {
      write.mockRestore();
      await app.close();
    }
  });
});
