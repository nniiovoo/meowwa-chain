import { POC_CATALOG } from '@meowwa/chain-domain';
import { describe, expect, it, vi } from 'vitest';
import { GatewayMerchantProvider } from './gateway-provider.js';

const quotes = POC_CATALOG.map((product, index) => ({
  quoteId: `quote_provider_00${index + 1}`, providerRevision: 'rev_001', merchantId: product.merchantId,
  merchantName: 'MeowWa Controlled Merchant', merchantRecipient: '0x1111111111111111111111111111111111111111',
  productId: product.productId, productName: product.name, amountMinor: product.priceMinor, taxMinor: 0,
  shippingMinor: 0, feesMinor: 0, expiresAt: '2026-07-15T12:05:00.000Z', verifiedAt: '2026-07-15T12:00:00.000Z',
}));
const quote = quotes[0]!;

describe('merchant gateway provider', () => {
  it('allows HTTP only for an explicitly enabled loopback development gateway', () => {
    expect(() => new GatewayMerchantProvider({
      baseUrl: 'http://127.0.0.1:4010/v1/',
      apiKey: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
    })).toThrow('HTTPS');
    expect(() => new GatewayMerchantProvider({
      baseUrl: 'http://127.0.0.1:4010/v1/',
      apiKey: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      allowInsecureLoopback: true,
    })).not.toThrow();
    expect(() => new GatewayMerchantProvider({
      baseUrl: 'http://merchant.internal/v1/',
      apiKey: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      allowInsecureLoopback: true,
    })).toThrow('HTTPS');
  });

  it('allows production HTTP only for the exact Kubernetes gateway service, port, and path', () => {
    const apiKey = 'merchant_test_abcdefghijklmnopqrstuvwxyz012345';
    expect(() => new GatewayMerchantProvider({
      baseUrl: 'http://controlled-merchant.meowwa-staging.svc.cluster.local:4010/v1/',
      apiKey,
    })).toThrow('HTTPS');
    expect(() => new GatewayMerchantProvider({
      baseUrl: 'http://controlled-merchant.meowwa-staging.svc.cluster.local:4010/v1/',
      apiKey,
      allowInsecureKubernetesService: true,
    })).not.toThrow();
    for (const baseUrl of [
      'http://controlled-merchant.example:4010/v1/',
      'http://controlled-merchant.meowwa-staging.svc.cluster.local.attacker:4010/v1/',
      'http://controlled-merchant.meowwa-staging.svc.cluster.local:4011/v1/',
      'http://controlled-merchant.meowwa-staging.svc.cluster.local:4010/v2/',
    ]) {
      expect(() => new GatewayMerchantProvider({
        baseUrl,
        apiKey,
        allowInsecureKubernetesService: true,
      })).toThrow('HTTPS');
    }
  });

  it('uses authenticated requests and provider references as idempotency keys', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(quotes), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ providerReference: `mwo_${'a'.repeat(61)}`, providerOrderId: 'provider_order_001', status: 'pending' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new GatewayMerchantProvider({
      baseUrl: 'https://merchant.example/v1/', apiKey: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345', fetch,
    });
    await expect(provider.fetchQuotes()).resolves.toHaveLength(POC_CATALOG.length);
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://merchant.example/v1/quotes', expect.objectContaining({ method: 'GET' }));
    await provider.createOrder({
      providerReference: `mwo_${'a'.repeat(61)}`, quoteId: quote.quoteId, requestId: 'request_001',
      amountMinor: 1299, paymentTransactionHash: `0x${'1'.repeat(64)}`,
    });
    expect(fetch).toHaveBeenLastCalledWith('https://merchant.example/v1/orders', expect.objectContaining({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({
        authorization: 'Bearer merchant_test_abcdefghijklmnopqrstuvwxyz012345',
        'idempotency-key': `mwo_${'a'.repeat(61)}`,
      }),
    }));
  });

  it('creates and retrieves a refund with the exact provider reference', async () => {
    const providerReference = `mwr_${'b'.repeat(61)}`;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        providerReference, providerRefundId: 'provider_refund_001', status: 'pending',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        providerReference, providerRefundId: 'provider_refund_001', status: 'confirmed',
        transactionHash: `0x${'2'.repeat(64)}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new GatewayMerchantProvider({
      baseUrl: 'https://merchant.example/v1/', apiKey: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345', fetch,
    });

    await expect(provider.createRefund({
      providerReference, providerOrderId: 'provider_order_001', requestId: 'request_001', amountMinor: 1299,
    })).resolves.toMatchObject({ providerReference, status: 'pending' });
    await expect(provider.getRefund(providerReference)).resolves.toMatchObject({
      providerReference, providerRefundId: 'provider_refund_001', status: 'confirmed',
    });
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://merchant.example/v1/refunds', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'idempotency-key': providerReference }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, `https://merchant.example/v1/refunds/by-reference/${providerReference}`, expect.objectContaining({
      method: 'GET', redirect: 'error',
    }));
  });

  it('cancels an unused not-found response body before returning', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    });
    const provider = new GatewayMerchantProvider({
      baseUrl: 'https://merchant.example/v1/',
      apiKey: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
      fetch: vi.fn(async () => new Response(body, { status: 404 })),
    });

    await expect(provider.getOrder(`mwo_${'a'.repeat(61)}`)).resolves.toBeUndefined();

    expect(cancelled).toBe(true);
  });

  it('rejects malformed, oversized, non-JSON, and failed gateway responses without leaking the key', async () => {
    const apiKey = 'merchant_test_abcdefghijklmnopqrstuvwxyz012345';
    for (const response of [
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('x'.repeat(130_000), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response(JSON.stringify({ error: apiKey }), { status: 500, headers: { 'content-type': 'application/json' } }),
    ]) {
      const provider = new GatewayMerchantProvider({ baseUrl: 'https://merchant.example/v1/', apiKey, fetch: vi.fn(async () => response) });
      let message = '';
      try { await provider.fetchQuotes(); } catch (error) { message = String(error); }
      expect(message).not.toContain(apiKey);
      expect(message).not.toBe('');
    }
  });

  it('requires exactly one authenticated quote for every controlled product', async () => {
    for (const invalid of [quotes.slice(1), [...quotes.slice(0, -1), quotes[0]!], [...quotes.slice(0, -1), { ...quotes.at(-1)!, productId: 'product_unreviewed' }]]) {
      const provider = new GatewayMerchantProvider({
        baseUrl: 'https://merchant.example/v1/', apiKey: 'merchant_test_abcdefghijklmnopqrstuvwxyz012345',
        fetch: vi.fn(async () => new Response(JSON.stringify(invalid), { status: 200, headers: { 'content-type': 'application/json' } })),
      });
      await expect(provider.fetchQuotes()).rejects.toThrow();
    }
  });
});
