export async function discardResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* status remains authoritative */ }
}

/**
 * The deadline has to cover `readBody`: `fetch` resolves when the headers arrive, so releasing the
 * timer there leaves a trickling body unbounded, and `/v1/evidence` awaits this call while holding
 * the per-tenant request lock.
 */
export async function fetchWithTimeout<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  readBody: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readBody(await fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}

/** Every provider response a `label` names is bounded, JSON-typed, and parsed the same way. */
export async function readBoundedJson(response: Response, maxBytes: number, label: string): Promise<unknown> {
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await discardResponseBody(response);
    throw new Error(`${label} response is not JSON`);
  }
  const text = await readBoundedResponseText(response, maxBytes, `${label} response is too large`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} response is invalid JSON`);
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Response byte limit is invalid');
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(maxBytes)) {
    try { await response.body?.cancel(); } catch { /* the size failure remains authoritative */ }
    throw new Error(tooLargeMessage);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* the size failure remains authoritative */ }
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
