const logLevels = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export interface SafeLoggerOptions {
  level: string;
  redact: { censor: string; paths: string[] };
  serializers: {
    req: typeof safeRequestProjection;
    res: typeof safeResponseProjection;
    err: typeof safeErrorProjection;
    error: typeof safeErrorProjection;
  };
}

export function safeRequestProjection(request: { method?: unknown; [key: string]: unknown }): { method: string } {
  const method = typeof request.method === 'string' && /^[A-Z]{3,10}$/.test(request.method) ? request.method : 'UNKNOWN';
  return { method };
}

function safeResponseProjection(response: { statusCode?: unknown }): { statusCode: number } {
  return { statusCode: Number.isInteger(response.statusCode) ? Number(response.statusCode) : 0 };
}

/**
 * The only shape an error may take in a log line. A provider error message carries whatever the
 * provider put in it -- the RPC URL with its embedded API key, a merchant endpoint, response
 * headers -- so the message and stack never survive; the name and an allowlisted code do.
 * Accepts `unknown` so non-logger call sites (stderr writers) can project through it too.
 */
export function safeErrorProjection(error: unknown): { type: string; message: string; stack: string; code?: string } {
  const source = (error ?? {}) as { name?: unknown; code?: unknown };
  const type = typeof source.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(source.name) ? source.name : 'Error';
  const code = typeof source.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(source.code) ? source.code : undefined;
  return { type, message: '[REDACTED]', stack: '', ...(code ? { code } : {}) };
}

export function productionLoggerConfig(level = 'info'): SafeLoggerOptions {
  if (!logLevels.has(level)) throw new Error('MEOWWA_LOG_LEVEL is not an allowed log level');
  return {
    level,
    redact: {
      censor: '[REDACTED]',
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["set-cookie"]',
        'req.headers["x-step-up-token"]',
        'req.headers["stripe-signature"]',
        'req.headers["svix-signature"]',
        'req.headers["x-merchant-signature"]',
        'req.body',
        'res.headers["set-cookie"]',
        'authorization',
        'cookie',
        'token',
        'secret',
        'privateKey',
        'connectionString',
      ],
    },
    serializers: {
      req: safeRequestProjection,
      res: safeResponseProjection,
      err: safeErrorProjection,
      // pino keys serializers by field name, so `log.error({ error }, ...)` bypassed the `err`
      // projection entirely and printed the raw message. Both spellings project the same way.
      error: safeErrorProjection,
    },
  };
}
