import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function registerRawJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    request.rawBody = rawBody;
    try {
      done(null, JSON.parse(rawBody.toString('utf8')) as unknown);
    } catch (error) {
      const invalidJson = error instanceof Error ? error : new Error('Invalid JSON body');
      (invalidJson as Error & { statusCode?: number }).statusCode = 400;
      done(invalidJson, undefined);
    }
  });
}

export function rawBodyOf(request: FastifyRequest): Buffer {
  if (!request.rawBody) throw new Error('Raw request body is unavailable');
  return request.rawBody;
}

