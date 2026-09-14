import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MerchantWebhookHeaders {
  'x-meowwa-merchant-event-id'?: string | undefined;
  'x-meowwa-merchant-timestamp'?: string | undefined;
  'x-meowwa-merchant-signature'?: string | undefined;
}

export class HmacMerchantWebhookVerifier {
  readonly #secret: string;
  readonly #now: () => Date;
  readonly #toleranceMs: number;

  constructor(options: { secret: string; now?: () => Date; toleranceMs?: number }) {
    if (!/^mwhsec_[A-Za-z0-9_+/=-]{32,}$/.test(options.secret)) throw new Error('Merchant webhook secret is invalid');
    const toleranceMs = options.toleranceMs ?? 300_000;
    if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 1_000 || toleranceMs > 900_000) throw new Error('Merchant webhook tolerance is invalid');
    this.#secret = options.secret;
    this.#now = options.now ?? (() => new Date());
    this.#toleranceMs = toleranceMs;
  }

  verify(rawBody: string, headers: MerchantWebhookHeaders): { deliveryId: string } {
    const deliveryId = headers['x-meowwa-merchant-event-id'];
    const timestamp = headers['x-meowwa-merchant-timestamp'];
    const signature = headers['x-meowwa-merchant-signature'];
    if (!deliveryId || !timestamp || !signature || deliveryId.length > 255) throw new Error('Merchant webhook headers are invalid');
    if (!/^[0-9]{10,16}$/.test(timestamp)) throw new Error('Merchant webhook timestamp is invalid');
    const timestampMs = Number(timestamp);
    if (!Number.isSafeInteger(timestampMs) || Math.abs(this.#now().getTime() - timestampMs) > this.#toleranceMs) {
      throw new Error('Merchant webhook timestamp is outside tolerance');
    }
    const match = /^v1=([a-f0-9]{64})$/.exec(signature);
    if (!match) throw new Error('Merchant webhook signature is invalid');
    // The delivery id is the sole replay/idempotency key -- recordWebhookDelivery and recordWebhook
    // dedupe on it alone -- so leaving it out of the signed material made it attacker-mutable while
    // the signature stayed valid: one captured request could be re-driven under fresh ids for the
    // whole tolerance window, each re-run paying for a metered chain verifyTransfer. It is bound
    // first, in the same dot-separated construction as the timestamp.
    const expected = createHmac('sha256', this.#secret).update(`${deliveryId}.${timestamp}.${rawBody}`).digest();
    const supplied = Buffer.from(match[1]!, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Merchant webhook signature is invalid');
    return { deliveryId };
  }
}
