import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { encodeBase58, isSolanaAddress, isSolanaSignature } from '@meowwa/chain-domain';
import { describe, expect, it, vi } from 'vitest';
import { StripeOnrampProvider, stripeOnrampChainKey, stripeOnrampNetwork } from './stripe-onramp.js';

const address = '0x1111111111111111111111111111111111111111' as const;
const transactionHash = `0x${'a'.repeat(64)}`;

// A 32-byte base58 pubkey and a 64-byte base58 signature. The signature is all 0xff so it takes
// the longest base58 form (88 characters), the worst case for anything that bounds evidence.
const solanaAddress = encodeBase58(new Uint8Array(32).fill(1));
const solanaSignature = encodeBase58(new Uint8Array(64).fill(255));
// The same characters as solanaAddress with one letter's case flipped: a different, valid key.
const caseFlippedSolanaAddress = `${solanaAddress.slice(0, 2)}${solanaAddress[2]!.toLowerCase()}${solanaAddress.slice(3)}`;

function sessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cos_123', object: 'crypto.onramp_session', status: 'initialized', livemode: false,
    redirect_url: 'https://crypto.link.com?session_hash=safe', metadata: {
      meowwa_tenant_id: '11111111-1111-4111-8111-111111111111',
      meowwa_funding_id: 'funding_1', meowwa_owner_id: 'owner_1', meowwa_pet_id: 'pet_mochi', meowwa_wallet_id: 'wallet_mochi',
    },
    transaction_details: {
      destination_currency: 'usdc', destination_network: 'base', destination_amount: null,
      destination_currencies: ['usdc'], destination_networks: ['base'], lock_wallet_address: true,
      wallet_address: address, wallet_addresses: { base: address }, transaction_id: null,
      source_currency: 'usd', source_amount: '25.00', fees: null,
    },
    ...overrides,
  };
}

function solanaSessionResponse(overrides: Record<string, unknown> = {}) {
  const base = sessionResponse();
  return {
    ...base,
    transaction_details: {
      ...base.transaction_details,
      destination_network: 'solana', destination_networks: ['solana'],
      wallet_address: solanaAddress, wallet_addresses: { solana: solanaAddress },
    },
    ...overrides,
  };
}

function legacyBaseWireKey(callerKey: string, customerIpAddress: string): string {
  return `meowwa_${createHash('sha256').update(`meowwa:stripe-onramp-wire:v1\0${callerKey}\0${customerIpAddress}`, 'utf8').digest('hex')}`;
}

function provider(fetchImplementation: typeof fetch) {
  return new StripeOnrampProvider({
    secretKey: 'sk_test_example', webhookSecret: 'whsec_test_secret', fetch: fetchImplementation,
  });
}

describe('Stripe Crypto Onramp provider', () => {
  it('lets the API create sessions without receiving the webhook secret', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(sessionResponse()), { status: 200 }));
    const onramp = new StripeOnrampProvider({ secretKey: 'sk_test_example', fetch: request as typeof fetch });
    await expect(onramp.createSession({
      tenantId: '11111111-1111-4111-8111-111111111111',
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
      chainKey: 'base', walletAddress: address, customerIpAddress: '203.0.113.7', idempotencyKey: 'funding-idem-1',
    })).resolves.toMatchObject({ providerSessionId: 'cos_123' });
    expect(() => onramp.constructWebhook(Buffer.from('{}'), 'signature'))
      .toThrow('not configured in this workload');
  });

  it('creates a locked hosted Base USDC session with server-owned metadata and idempotency', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify(sessionResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const onramp = provider(request as typeof fetch);
    await expect(onramp.createSession({
      tenantId: '11111111-1111-4111-8111-111111111111',
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
      chainKey: 'base', walletAddress: address, sourceAmountMinor: 2500, customerIpAddress: '203.0.113.7', idempotencyKey: 'funding-idem-1',
    })).resolves.toEqual({ providerSessionId: 'cos_123', redirectUrl: 'https://crypto.link.com/?session_hash=safe', status: 'initialized' });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/crypto/onramp_sessions');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk_test_example');
    // The wire key is derived from the caller key plus the customer IP so it always matches the body.
    // For Base it is byte-identical to the key sent before Solana existed: a Base retry crossing
    // the deploy must replay Stripe's cached session rather than 409.
    expect(headers.get('idempotency-key')).toMatch(/^meowwa_[0-9a-f]{64}$/);
    expect(headers.get('idempotency-key')).toBe(legacyBaseWireKey('funding-idem-1', '203.0.113.7'));
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      source_currency: 'usd', source_amount: '25.00', destination_currency: 'usdc', destination_network: 'base',
      'destination_currencies[0]': 'usdc', 'destination_networks[0]': 'base',
      'wallet_addresses[base]': address, lock_wallet_address: 'true', customer_ip_address: '203.0.113.7',
      'metadata[meowwa_tenant_id]': '11111111-1111-4111-8111-111111111111',
      'metadata[meowwa_funding_id]': 'funding_1', 'metadata[meowwa_owner_id]': 'owner_1',
      'metadata[meowwa_pet_id]': 'pet_mochi', 'metadata[meowwa_wallet_id]': 'wallet_mochi',
    });
  });

  it('converges a same-key retry from a different client network instead of hitting a Stripe idempotency conflict', async () => {
    // Faithful to https://docs.stripe.com/api/errors: reusing an Idempotency-Key with a different
    // body returns HTTP 409 with type=idempotency_error; an exact replay returns the cached response.
    const cache = new Map<string, { body: string; response: string }>();
    let minted = 0;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      const key = new Headers(init?.headers).get('idempotency-key')!;
      const body = String(init?.body);
      const cached = cache.get(key);
      if (cached && cached.body !== body) {
        return new Response(JSON.stringify({ error: {
          type: 'idempotency_error', code: 'idempotency_error',
          message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
        } }), { status: 409 });
      }
      if (cached) return new Response(cached.response, { status: 200 });
      minted += 1;
      const response = JSON.stringify(sessionResponse({ id: `cos_${minted}` }));
      cache.set(key, { body, response });
      return new Response(response, { status: 200 });
    });
    const onramp = provider(request as typeof fetch);
    const session = (customerIpAddress: string) => onramp.createSession({
      tenantId: '11111111-1111-4111-8111-111111111111',
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
      chainKey: 'base', walletAddress: address, sourceAmountMinor: 2500, customerIpAddress, idempotencyKey: 'funding-idem-1',
    });

    await expect(session('203.0.113.7')).resolves.toMatchObject({ providerSessionId: 'cos_1' });
    await expect(session('198.51.100.9')).resolves.toMatchObject({ providerSessionId: 'cos_2' });
    await expect(session('203.0.113.7')).resolves.toMatchObject({ providerSessionId: 'cos_1' });
    expect(minted).toBe(2);

    const wireKeys = request.mock.calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));
    const bodies = request.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get('customer_ip_address'));
    expect(wireKeys[0]).not.toBe(wireKeys[1]);
    expect(wireKeys[2]).toBe(wireKeys[0]);
    expect(bodies).toEqual(['203.0.113.7', '198.51.100.9', '203.0.113.7']);
  });

  it('retrieves and strictly parses the locked provider state', async () => {
    const complete = sessionResponse({
      status: 'fulfillment_complete', redirect_url: null,
      transaction_details: {
        ...sessionResponse().transaction_details,
        destination_amount: '24.123456', transaction_id: transactionHash,
      },
    });
    const request = vi.fn(async () => new Response(JSON.stringify(complete), { status: 200 }));
    const onramp = provider(request as typeof fetch);
    await expect(onramp.retrieveSession('cos_123')).resolves.toMatchObject({
      providerSessionId: 'cos_123', status: 'fulfillment_complete', livemode: false, chainKey: 'base',
      walletAddress: address, destinationCurrency: 'usdc', destinationNetwork: 'base',
      destinationAmountAtomic: '24123456', transactionHash,
      metadata: { meowwa_funding_id: 'funding_1' },
    });
    expect(request).toHaveBeenCalledWith('https://api.stripe.com/v1/crypto/onramp_sessions/cos_123', expect.objectContaining({ method: 'GET' }));
  });

  describe('Solana rail', () => {
    it('uses fixtures of the shapes Solana actually produces', () => {
      expect(isSolanaAddress(solanaAddress)).toBe(true);
      expect(isSolanaAddress(caseFlippedSolanaAddress)).toBe(true);
      expect(caseFlippedSolanaAddress).not.toBe(solanaAddress);
      expect(isSolanaSignature(solanaSignature)).toBe(true);
      expect(solanaSignature).toHaveLength(88);
    });

    it('maps each funding rail to its Stripe network and back, and nothing else', () => {
      expect(stripeOnrampNetwork('base')).toBe('base');
      expect(stripeOnrampNetwork('solana')).toBe('solana');
      expect(() => stripeOnrampNetwork('base_sepolia' as never)).toThrow('Invalid Stripe Onramp chain');
      expect(() => stripeOnrampNetwork('solana_devnet' as never)).toThrow('Invalid Stripe Onramp chain');
      expect(stripeOnrampChainKey('base')).toBe('base');
      expect(stripeOnrampChainKey('solana')).toBe('solana');
      expect(stripeOnrampChainKey('ethereum')).toBeUndefined();
      expect(stripeOnrampChainKey('solana_devnet')).toBeUndefined();
      expect(stripeOnrampChainKey(undefined)).toBeUndefined();
    });

    it('creates a locked hosted Solana USDC session keyed under wallet_addresses[solana]', async () => {
      const request = vi.fn(async () => new Response(JSON.stringify(solanaSessionResponse()), { status: 200 }));
      const onramp = provider(request as typeof fetch);
      await expect(onramp.createSession({
        tenantId: '11111111-1111-4111-8111-111111111111',
        fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
        chainKey: 'solana', walletAddress: solanaAddress, sourceAmountMinor: 2500,
        customerIpAddress: '203.0.113.7', idempotencyKey: 'funding-idem-1',
      })).resolves.toEqual({ providerSessionId: 'cos_123', redirectUrl: 'https://crypto.link.com/?session_hash=safe', status: 'initialized' });
      const [, init] = request.mock.calls[0]! as unknown as [string, RequestInit];
      const body = Object.fromEntries(new URLSearchParams(String(init.body)));
      expect(body).toMatchObject({
        destination_currency: 'usdc', destination_network: 'solana', 'destination_networks[0]': 'solana',
        'wallet_addresses[solana]': solanaAddress, lock_wallet_address: 'true',
      });
      expect(body).not.toHaveProperty('wallet_addresses[base]');
      // The chain is part of the body, so it is part of the wire key: the same caller key and IP
      // on Solana must not replay a cached Base session.
      const wireKey = new Headers(init.headers).get('idempotency-key');
      expect(wireKey).toMatch(/^meowwa_[0-9a-f]{64}$/);
      expect(wireKey).not.toBe(legacyBaseWireKey('funding-idem-1', '203.0.113.7'));
    });

    it('converges a same-key Solana retry and keeps Base and Solana sessions apart at Stripe', async () => {
      const cache = new Map<string, { body: string; response: string }>();
      let minted = 0;
      const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        const key = new Headers(init?.headers).get('idempotency-key')!;
        const body = String(init?.body);
        const cached = cache.get(key);
        if (cached && cached.body !== body) {
          return new Response(JSON.stringify({ error: { type: 'idempotency_error', code: 'idempotency_error', message: 'conflict' } }), { status: 409 });
        }
        if (cached) return new Response(cached.response, { status: 200 });
        minted += 1;
        const network = new URLSearchParams(body).get('destination_network');
        const response = JSON.stringify(network === 'solana' ? solanaSessionResponse({ id: `cos_${minted}` }) : sessionResponse({ id: `cos_${minted}` }));
        cache.set(key, { body, response });
        return new Response(response, { status: 200 });
      });
      const onramp = provider(request as typeof fetch);
      const common = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
        sourceAmountMinor: 2500, customerIpAddress: '203.0.113.7', idempotencyKey: 'funding-idem-1',
      } as const;
      await expect(onramp.createSession({ ...common, chainKey: 'base', walletAddress: address })).resolves.toMatchObject({ providerSessionId: 'cos_1' });
      await expect(onramp.createSession({ ...common, chainKey: 'solana', walletAddress: solanaAddress })).resolves.toMatchObject({ providerSessionId: 'cos_2' });
      await expect(onramp.createSession({ ...common, chainKey: 'solana', walletAddress: solanaAddress })).resolves.toMatchObject({ providerSessionId: 'cos_2' });
      await expect(onramp.createSession({ ...common, chainKey: 'base', walletAddress: address })).resolves.toMatchObject({ providerSessionId: 'cos_1' });
      expect(minted).toBe(2);
    });

    it('retrieves a completed Solana session with the signature and address kept verbatim', async () => {
      const complete = solanaSessionResponse({
        status: 'fulfillment_complete', redirect_url: null,
        transaction_details: {
          ...solanaSessionResponse().transaction_details,
          destination_amount: '24.123456', transaction_id: solanaSignature,
        },
      });
      const request = vi.fn(async () => new Response(JSON.stringify(complete), { status: 200 }));
      const session = await provider(request as typeof fetch).retrieveSession('cos_123');
      expect(session).toMatchObject({
        providerSessionId: 'cos_123', status: 'fulfillment_complete', chainKey: 'solana',
        destinationCurrency: 'usdc', destinationNetwork: 'solana', destinationAmountAtomic: '24123456',
      });
      expect(session.walletAddress).toBe(solanaAddress);
      expect(session.transactionHash).toBe(solanaSignature);
    });

    it('falls back to wallet_addresses[solana] when Stripe omits the flat wallet_address', async () => {
      const details = solanaSessionResponse().transaction_details as Record<string, unknown>;
      delete details.wallet_address;
      const request = vi.fn(async () => new Response(JSON.stringify(solanaSessionResponse({ transaction_details: details })), { status: 200 }));
      await expect(provider(request as typeof fetch).retrieveSession('cos_123')).resolves.toMatchObject({ chainKey: 'solana', walletAddress: solanaAddress });
    });

    it('rejects a Solana session whose address differs only by letter case from the requested wallet', async () => {
      // Lowercasing base58 would make these equal; they are different keys.
      const request = vi.fn(async () => new Response(JSON.stringify(solanaSessionResponse({
        transaction_details: {
          ...solanaSessionResponse().transaction_details,
          wallet_address: caseFlippedSolanaAddress, wallet_addresses: { solana: caseFlippedSolanaAddress },
        },
      })), { status: 200 }));
      await expect(provider(request as typeof fetch).createSession({
        fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
        chainKey: 'solana', walletAddress: solanaAddress, customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
      })).rejects.toThrow('does not match the requested funding destination');
    });

    it('rejects a session on the other rail than the one requested', async () => {
      const solanaBack = vi.fn(async () => new Response(JSON.stringify(solanaSessionResponse()), { status: 200 }));
      await expect(provider(solanaBack as typeof fetch).createSession({
        fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
        chainKey: 'base', walletAddress: address, customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
      })).rejects.toThrow('does not match the requested funding destination');
      const baseBack = vi.fn(async () => new Response(JSON.stringify(sessionResponse()), { status: 200 }));
      await expect(provider(baseBack as typeof fetch).createSession({
        fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
        chainKey: 'solana', walletAddress: solanaAddress, customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
      })).rejects.toThrow('does not match the requested funding destination');
    });

    it.each([
      ['an EVM address on a Solana session', { wallet_address: address, wallet_addresses: { solana: address } }],
      ['a Solana address under the Base key', { wallet_address: undefined, wallet_addresses: { base: solanaAddress } }],
      ['an EVM hash as a Solana transaction id', { transaction_id: transactionHash }],
      ['a Solana signature under the Base network', { destination_network: 'base', wallet_address: address, wallet_addresses: { base: address }, transaction_id: solanaSignature }],
      ['an unlocked Solana wallet', { lock_wallet_address: false }],
    ])('rejects %s', async (_label, details) => {
      const request = vi.fn(async () => new Response(JSON.stringify(solanaSessionResponse({
        transaction_details: { ...solanaSessionResponse().transaction_details, ...details },
      })), { status: 200 }));
      await expect(provider(request as typeof fetch).retrieveSession('cos_123')).rejects.toThrow(/Stripe Onramp session/i);
    });

    it.each([
      ['a wrong-family address', { chainKey: 'solana', walletAddress: address }],
      ['a base58 address on the Base rail', { chainKey: 'base', walletAddress: solanaAddress }],
      ['a control-plane chain', { chainKey: 'solana_devnet', walletAddress: solanaAddress }],
    ] as const)('refuses to create a session with %s', async (_label, destination) => {
      const request = vi.fn(async () => new Response(JSON.stringify(solanaSessionResponse()), { status: 200 }));
      await expect(provider(request as typeof fetch).createSession({
        fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
        ...(destination as { chainKey: 'base' | 'solana'; walletAddress: string }),
        customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
      })).rejects.toThrow(/Invalid Stripe Onramp (chain|wallet address)/);
      expect(request).not.toHaveBeenCalled();
    });
  });

  it('still matches a checksummed (mixed-case) Base address against the lowercase one it requested', async () => {
    const checksummed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const request = vi.fn(async () => new Response(JSON.stringify(sessionResponse({
      transaction_details: { ...sessionResponse().transaction_details, wallet_address: checksummed, wallet_addresses: { base: checksummed } },
    })), { status: 200 }));
    await expect(provider(request as typeof fetch).createSession({
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi',
      chainKey: 'base', walletAddress: checksummed.toLowerCase(), customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
    })).resolves.toMatchObject({ providerSessionId: 'cos_123' });
  });

  it('rejects an unsafe hosted redirect when retrieving an existing session', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(sessionResponse({
      redirect_url: 'https://user:password@crypto.link.com:8443?session_hash=safe',
    })), { status: 200 }));
    await expect(provider(request as typeof fetch).retrieveSession('cos_123'))
      .rejects.toThrow('Stripe Onramp hosted redirect is invalid');
  });

  it('rejects a provider response whose live mode does not match the configured Stripe key', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(sessionResponse({ livemode: true })), { status: 200 }));
    await expect(provider(request as typeof fetch).retrieveSession('cos_123'))
      .rejects.toThrow('Stripe Onramp session mode does not match the configured key');
  });

  it.each([
    { transaction_details: { ...sessionResponse().transaction_details, destination_currency: 'eth' } },
    { transaction_details: { ...sessionResponse().transaction_details, destination_network: 'ethereum' } },
    { transaction_details: { ...sessionResponse().transaction_details, destination_network: 'solana_devnet' } },
    { transaction_details: { ...sessionResponse().transaction_details, lock_wallet_address: false } },
    { transaction_details: { ...sessionResponse().transaction_details, wallet_address: 'attacker' } },
  ])('rejects a provider session that violates the locked Base USDC contract', async (override) => {
    const request = vi.fn(async () => new Response(JSON.stringify(sessionResponse(override)), { status: 200 }));
    await expect(provider(request as typeof fetch).retrieveSession('cos_123')).rejects.toThrow(/Stripe Onramp session/i);
  });

  it('fails safely when Stripe has no hosted redirect or returns an API error', async () => {
    const noRedirect = vi.fn(async () => new Response(JSON.stringify(sessionResponse({ redirect_url: null })), { status: 200 }));
    await expect(provider(noRedirect as typeof fetch).createSession({
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi', chainKey: 'base', walletAddress: address,
      customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
    })).rejects.toThrow('Stripe did not return a hosted Onramp redirect');

    const apiError = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'crypto_onramp_unsupported_location', message: 'Unsupported' } }), { status: 400 }));
    await expect(provider(apiError as typeof fetch).createSession({
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi', chainKey: 'base', walletAddress: address,
      customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
    })).rejects.toMatchObject({ name: 'StripeOnrampError', code: 'crypto_onramp_unsupported_location' });
  });

  // A provider timeout is the one failure the "Add money" screen must classify, and it never
  // reached the classifier: the request aborts with a TimeoutError DOMException and a dropped
  // connection rejects with a fetch TypeError, neither of which is a StripeOnrampError, so the
  // route's mapping was skipped and the owner got a bare 500 Internal Server Error with no
  // indication of whether their card was charged. Both are the provider not answering.
  it.each([
    ['timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['dropped connection', new TypeError('fetch failed')],
  ])('reports a %s as a provider failure rather than an unmapped rejection', async (_label, cause) => {
    const request = vi.fn(async () => { throw cause; });
    await expect(provider(request as unknown as typeof fetch).createSession({
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi', chainKey: 'base', walletAddress: address,
      customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
    })).rejects.toMatchObject({ name: 'StripeOnrampError', code: 'provider_unreachable', statusCode: 504 });
  });

  it.each([
    'https://user:password@crypto.link.com?session_hash=safe',
    'https://crypto.link.com:8443?session_hash=safe',
    'http://crypto.link.com?session_hash=safe',
    'https://crypto.link.com.attacker.example?session_hash=safe',
  ])('rejects a hosted redirect outside the exact Stripe origin: %s', async (redirectUrl) => {
    const request = vi.fn(async () => new Response(JSON.stringify(sessionResponse({ redirect_url: redirectUrl })), { status: 200 }));
    await expect(provider(request as typeof fetch).createSession({
      fundingId: 'funding_1', ownerId: 'owner_1', petId: 'pet_mochi', walletId: 'wallet_mochi', chainKey: 'base', walletAddress: address,
      customerIpAddress: '203.0.113.7', idempotencyKey: 'idem',
    })).rejects.toThrow('Stripe Onramp hosted redirect is invalid');
  });

  it('verifies the signature against the exact raw bytes and rejects tampering or stale signatures', () => {
    const onramp = provider(vi.fn() as unknown as typeof fetch);
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', livemode: false, type: 'crypto.onramp_session.updated', data: { object: sessionResponse() } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
    expect(onramp.constructWebhook(Buffer.from(payload), signature)).toMatchObject({ id: 'evt_1', type: 'crypto.onramp_session.updated' });
    expect(() => onramp.constructWebhook(Buffer.from(`${payload} `), signature)).toThrow();
    const stale = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret', timestamp: 1 });
    expect(() => onramp.constructWebhook(Buffer.from(payload), stale)).toThrow();
  });

  it('rejects a signed webhook from the wrong Stripe mode', () => {
    const onramp = provider(vi.fn() as unknown as typeof fetch);
    const payload = JSON.stringify({ id: 'evt_live', object: 'event', livemode: true, type: 'crypto.onramp_session.updated', data: { object: sessionResponse({ livemode: true }) } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
    expect(() => onramp.constructWebhook(Buffer.from(payload), signature))
      .toThrow('Stripe webhook mode does not match the configured key');
  });
});
