// @vitest-environment jsdom

/**
 * The HTTP transport, which every request in the web client goes
 * through.
 *
 * It had no tests. Two things here are load-bearing and silent when
 * wrong: the API token is read **once at module load**, so a token that
 * arrives late is a token that never arrives; and the error path
 * decides what the user is told when the server refuses — a lost
 * `message` turns "password authentication failed" into "HTTP
 * transport got 401".
 *
 * The module-level read is also why each test re-imports through
 * `vi.resetModules()` rather than sharing one import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only: erased at compile time, so it carries no module identity
// and cannot collide with the class `freshModule` hands back.
import type { TransportError } from '@plamenix/ui';

/** Puts the server-injected token tag in the document, or removes it. */
function setTokenMeta(content: string | null): void {
  document.head.querySelector('meta[name="plamenix-api-token"]')?.remove();
  if (content === null) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'plamenix-api-token');
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

/** Imports the module fresh, so the module-level token read runs again
 *  against whatever `setTokenMeta` just put in the document.
 *
 *  `TransportError` comes back from the same graph on purpose:
 *  `resetModules` gives `@plamenix/ui` a new module instance, so the
 *  class the transport throws is not the class a static import at the
 *  top of this file would hold, and every `instanceof` would fail for a
 *  reason that has nothing to do with the code under test. */
async function freshModule(): Promise<
  typeof import('./fetch.js') & { TransportError: typeof import('@plamenix/ui').TransportError }
> {
  vi.resetModules();
  const [mod, ui] = await Promise.all([import('./fetch.js'), import('@plamenix/ui')]);
  return { ...mod, TransportError: ui.TransportError };
}

/** A `Response` the transport will accept or reject as described. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  setTokenMeta(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authHeaders', () => {
  it('carries the token the server injected', async () => {
    setTokenMeta('a-real-token');
    const { authHeaders } = await freshModule();
    expect(authHeaders()).toEqual({ Authorization: 'Bearer a-real-token' });
  });

  it('sends nothing when the placeholder was never replaced', async () => {
    // The index.html ships `__PLAMENIX_API_TOKEN__` and the server
    // substitutes it. Sending the placeholder verbatim would produce a
    // 401 that looks like a bad token rather than an unserved page.
    setTokenMeta('__PLAMENIX_API_TOKEN__');
    const { authHeaders } = await freshModule();
    expect(authHeaders()).toEqual({});
  });

  it('sends nothing when the tag is absent or empty', async () => {
    const { authHeaders } = await freshModule();
    expect(authHeaders()).toEqual({});

    setTokenMeta('');
    const empty = await freshModule();
    expect(empty.authHeaders()).toEqual({});
  });
});

describe('fetchTransport.invoke', () => {
  it('POSTs args as JSON to /api/<command>', async () => {
    setTokenMeta('tok');
    const { fetchTransport } = await freshModule();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    const result = await fetchTransport.invoke('execute', { sql: 'SELECT 1' });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/execute');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ sql: 'SELECT 1' }));
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok',
    });
  });

  it('GETs when there are no args, and still authenticates', async () => {
    // A GET without the header is a 401 that reads as a broken
    // endpoint. Every route requires the token, reads included.
    setTokenMeta('tok');
    const { fetchTransport } = await freshModule();
    fetchMock.mockResolvedValue(jsonResponse(200, { pong: true }));

    await fetchTransport.invoke('ping');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ping');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('returns undefined for 204 rather than trying to parse a body', async () => {
    const { fetchTransport } = await freshModule();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(fetchTransport.invoke('close', { sessionId: 'x' })).resolves.toBeUndefined();
  });

  it('surfaces the server’s message on an error envelope', async () => {
    // The whole point of the envelope. Without this the user sees the
    // status code and has to guess.
    const { fetchTransport } = await freshModule();
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: 'connect_failed', message: 'password authentication failed' }),
    );

    await expect(fetchTransport.invoke('connect', { host: 'x' })).rejects.toThrow(
      /password authentication failed/,
    );
  });

  it('attaches the typed error tag as the cause', async () => {
    // Callers branch on `error`, not on the prose. Losing the envelope
    // would make every failure indistinguishable.
    const { fetchTransport, TransportError: ErrorClass } = await freshModule();
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'unknown_session', message: 'gone' }));

    const err = await fetchTransport
      .invoke('execute', { sessionId: 'x' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ErrorClass);
    expect((err as TransportError).cause).toEqual({ error: 'unknown_session', message: 'gone' });
  });

  it('falls back to the status when JSON carries no message', async () => {
    const { fetchTransport } = await freshModule();
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));

    const err = await fetchTransport.invoke('execute').catch((e: unknown) => e);

    expect((err as Error).message).toContain('500');
    expect((err as Error).message).toContain("'execute'");
    expect((err as TransportError).cause).toEqual({ error: 'boom' });
  });

  it('keeps a non-JSON error body as the cause', async () => {
    // A proxy or the framework's own 502 page. Discarding it leaves
    // nothing to diagnose with.
    const { fetchTransport, TransportError: ErrorClass } = await freshModule();
    fetchMock.mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const err = await fetchTransport.invoke('ping').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ErrorClass);
    expect((err as Error).message).toContain('502');
    expect((err as TransportError).cause).toContain('Bad Gateway');
  });

  it('survives an error body that claims JSON and is not', async () => {
    // A truncated response would otherwise throw inside the error
    // handler and replace a useful 500 with a parse error.
    const { fetchTransport, TransportError: ErrorClass } = await freshModule();
    fetchMock.mockResolvedValue(
      new Response('{"error":', { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const err = await fetchTransport.invoke('ping').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ErrorClass);
    expect((err as Error).message).toContain('500');
  });

  it('wraps a network failure, keeping the original as the cause', async () => {
    const boom = new TypeError('Failed to fetch');
    const { fetchTransport, TransportError: ErrorClass } = await freshModule();
    fetchMock.mockRejectedValue(boom);

    const err = await fetchTransport.invoke('ping').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ErrorClass);
    expect((err as Error).message).toContain("'ping'");
    expect((err as TransportError).cause).toBe(boom);
  });
});
