import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { ControlledMerchantRepository } from './repository.js';
import { FirstPartyControlledMerchantService } from './service.js';
import { buildControlledMerchantApp } from './http.js';

const apiKey = 'merchant_abcdefghijklmnopqrstuvwxyz012345';
const merchant = `0x${'4'.repeat(40)}` as const;
const pet = `0x${'5'.repeat(40)}` as const;
const paymentHash = `0x${'1'.repeat(64)}` as const;
const refundHash = keccak256('0x1234');
const blockHash = `0x${'3'.repeat(64)}` as const;
const orderReference = `mwo_${'a'.repeat(61)}`;
const refundReference = `mwr_${'b'.repeat(61)}`;
const now = new Date('2026-07-17T12:01:00.000Z');

function fixture() {
  const repository = new ControlledMerchantRepository(':memory:', { now: () => now });
  const service = new FirstPartyControlledMerchantService({
    repository,
    paymentReader: { verifyPayment: vi.fn(async () => ({
      sender: pet, transactionHash: paymentHash, blockHash, blockNumber: 100, logIndex: 2,
      blockTimestamp: '2026-07-17T12:01:00.000Z',
    })) },
    refundExecutor: {
      prepareRefund: vi.fn(async () => ({ transactionHash: refundHash, serializedTransaction: '0x1234' as const })),
      broadcastAndConfirm: vi.fn(async () => 'confirmed' as const),
    },
    merchantRecipient: merchant,
    providerRevision: 'poc-merchant-2026-07-17',
    confirmations: 2,
    now: () => now,
  });
  const app = buildControlledMerchantApp({ service, apiKey, ready: async () => true });
  app.addHook('onClose', async () => repository.close());
  return app;
}

describe('controlled merchant HTTP gateway', () => {
  it('requires bearer authentication and an exact idempotency key', async () => {
    const app = fixture();
    expect((await app.inject({ method: 'GET', url: '/v1/quotes' })).statusCode).toBe(401);
    const quotes = await app.inject({ method: 'GET', url: '/v1/quotes', headers: { authorization: `Bearer ${apiKey}` } });
    const quote = quotes.json()[0];
    const wrong = await app.inject({
      method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'wrong' },
      payload: { providerReference: orderReference, quoteId: quote.quoteId, requestId: 'request_1', amountMinor: quote.amountMinor, paymentTransactionHash: paymentHash },
    });
    expect(wrong.statusCode).toBe(400);
    await app.close();
  });

  it('runs the quote, exact paid order, and exact refund contract used by the worker', async () => {
    const app = fixture();
    const headers = { authorization: `Bearer ${apiKey}` };
    const quote = (await app.inject({ method: 'GET', url: '/v1/quotes', headers })).json()[0];
    const order = await app.inject({
      method: 'POST', url: '/v1/orders', headers: { ...headers, 'idempotency-key': orderReference },
      payload: { providerReference: orderReference, quoteId: quote.quoteId, requestId: 'request_1', amountMinor: quote.amountMinor, paymentTransactionHash: paymentHash },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ providerReference: orderReference, status: 'confirmed' });
    const refund = await app.inject({
      method: 'POST', url: '/v1/refunds', headers: { ...headers, 'idempotency-key': refundReference },
      payload: { providerReference: refundReference, providerOrderId: order.json().providerOrderId, requestId: 'request_1', amountMinor: quote.amountMinor },
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json()).toMatchObject({ providerReference: refundReference, status: 'confirmed', transactionHash: refundHash });
    const replay = await app.inject({ method: 'GET', url: `/v1/refunds/by-reference/${refundReference}`, headers });
    expect(replay.json()).toEqual(refund.json());
    await app.close();
  });
});
