import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { rawBodyOf, registerRawJsonBodyParser } from './raw-body.js';

describe('raw JSON body preservation', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('preserves the exact bytes while still parsing JSON', async () => {
    const app = Fastify(); apps.push(app);
    registerRawJsonBodyParser(app);
    app.post('/webhook', async (request) => ({ parsed: request.body, raw: rawBodyOf(request).toString('base64') }));
    const payload = '{\n  "amount": 25, "currency": "usd"\n}\n';
    const response = await app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json' }, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ parsed: { amount: 25, currency: 'usd' }, raw: Buffer.from(payload).toString('base64') });
  });

  it('rejects malformed JSON and enforces Fastify body limits', async () => {
    const malformed = Fastify(); apps.push(malformed); registerRawJsonBodyParser(malformed);
    malformed.post('/webhook', async () => ({ ok: true }));
    expect((await malformed.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json' }, payload: '{nope' })).statusCode).toBe(400);

    const limited = Fastify({ bodyLimit: 16 }); apps.push(limited); registerRawJsonBodyParser(limited);
    limited.post('/webhook', async () => ({ ok: true }));
    expect((await limited.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ value: 'too long for limit' }) })).statusCode).toBe(413);
  });
});
