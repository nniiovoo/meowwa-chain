import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HmacMerchantWebhookVerifier } from './webhook.js';

const secret = 'mwhsec_abcdefghijklmnopqrstuvwxyz0123456789';
const now = () => new Date('2026-07-15T12:00:00.000Z');

function headers(payload: string, timestamp = String(now().getTime()), deliveryId = 'merchant_event_001') {
  const digest = createHmac('sha256', secret).update(`${deliveryId}.${timestamp}.${payload}`).digest('hex');
  return {
    'x-meowwa-merchant-event-id': deliveryId,
    'x-meowwa-merchant-timestamp': timestamp,
    'x-meowwa-merchant-signature': `v1=${digest}`,
  };
}

describe('merchant webhook verifier', () => {
  it('verifies the exact raw body with a bounded timestamp', () => {
    const verifier = new HmacMerchantWebhookVerifier({ secret, now, toleranceMs: 300_000 });
    const payload = JSON.stringify({ type: 'order.confirmed' });
    expect(verifier.verify(payload, headers(payload))).toEqual({ deliveryId: 'merchant_event_001' });
    expect(() => verifier.verify(`${payload} `, headers(payload))).toThrow('signature');
  });

  it('refuses a captured signed request re-driven under a fresh delivery id', () => {
    // The delivery id is the sole replay/idempotency key, so while it sat outside the signed
    // material one captured request could be replayed under any number of fresh ids for the whole
    // tolerance window -- each replay a metered chain verifyTransfer -- with no secret needed.
    const verifier = new HmacMerchantWebhookVerifier({ secret, now, toleranceMs: 300_000 });
    const payload = JSON.stringify({ type: 'refund.confirmed' });
    const captured = headers(payload);

    expect(verifier.verify(payload, captured)).toEqual({ deliveryId: 'merchant_event_001' });
    expect(() => verifier.verify(payload, { ...captured, 'x-meowwa-merchant-event-id': 'merchant_event_002' }))
      .toThrow('signature');
  });

  it('rejects stale, malformed, and missing signatures', () => {
    const verifier = new HmacMerchantWebhookVerifier({ secret, now, toleranceMs: 300_000 });
    const payload = '{}';
    expect(() => verifier.verify(payload, headers(payload, String(now().getTime() - 300_001)))).toThrow('timestamp');
    expect(() => verifier.verify(payload, { ...headers(payload), 'x-meowwa-merchant-signature': 'v1=nope' })).toThrow('signature');
    expect(() => verifier.verify(payload, {})).toThrow('headers');
  });
});

