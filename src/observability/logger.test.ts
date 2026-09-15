import { describe, expect, it } from 'vitest';
import { productionLoggerConfig, safeErrorProjection, safeRequestProjection } from './logger.js';

describe('production logging', () => {
  it('projects requests without URLs, headers, bodies, identities, or wallet material', () => {
    const projected = safeRequestProjection({
      method: 'POST',
      url: '/v1/requests/request_secret/execute',
      headers: { authorization: 'Bearer token_secret', cookie: 'session=secret', 'x-step-up-token': 'step_secret' },
      body: { privateKey: 'wallet_secret', ownerId: 'owner_secret' },
      ip: '203.0.113.1',
    });
    const serialized = JSON.stringify(projected);
    expect(projected).toEqual({ method: 'POST' });
    for (const secret of ['request_secret', 'token_secret', 'session=secret', 'step_secret', 'wallet_secret', 'owner_secret', '203.0.113.1']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('uses an allowlisted log level and explicit defense-in-depth redaction', () => {
    expect(productionLoggerConfig('debug')).toMatchObject({ level: 'debug' });
    expect(() => productionLoggerConfig('trace-all')).toThrow('log level');
    const config = productionLoggerConfig('info');
    const redactions = (config.redact as { paths: string[] }).paths;
    expect(redactions).toContain('req.headers.authorization');
    expect(redactions).toContain('req.headers.cookie');
    expect(redactions).toContain('req.body');
    expect(redactions).toContain('res.headers["set-cookie"]');
  });

  // pino resolves serializers by field name, so `log.error({ error }, ...)` -- the spelling used
  // by every worker error handler -- never reached the `err` projection and printed the raw
  // message: the RPC endpoint with its embedded provider key, merchant URLs, response headers.
  it('projects an error under either field name and keeps provider URLs out of it', () => {
    const config = productionLoggerConfig('info');
    expect(config.serializers.error).toBe(config.serializers.err);

    const failure = Object.assign(
      // secret-scan: allow-test-fixture
      new Error('fetch failed for https://base-mainnet.g.alchemy.com/v2/A1b2C3d4E5f6G7h8I9j0K1'),
      { code: 'ECONNREFUSED' },
    );
    const projected = config.serializers.error(failure);
    expect(projected).toEqual({ type: 'Error', message: '[REDACTED]', stack: '', code: 'ECONNREFUSED' });
    expect(JSON.stringify(projected)).not.toContain('alchemy.com');
    // Non-logger call sites hand it whatever a rejected promise carried.
    expect(safeErrorProjection('https://base-mainnet.g.alchemy.com/v2/key')).toEqual({
      type: 'Error', message: '[REDACTED]', stack: '',
    });
    expect(safeErrorProjection(undefined)).toEqual({ type: 'Error', message: '[REDACTED]', stack: '' });
  });
});
