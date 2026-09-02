// @vitest-environment jsdom

/**
 * The profile REST helpers.
 *
 * These sit outside `Transport` because the endpoints are plain REST —
 * path parameters and `DELETE` — which means they build URLs by hand
 * and attach the auth header by hand. Both are things that are easy to
 * get right once and lose in an edit, and neither fails loudly: a
 * missing header is a 401 that reads as a broken endpoint, and an
 * unescaped id is a request to a path nobody intended.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

/** Loaded in `beforeAll`, not by a static import.
 *
 *  `authHeaders` reads the server-injected token **once at module
 *  load**, and static imports are evaluated before any module-scope
 *  statement in this file — so a tag appended here would land after
 *  the read and every helper would go out unauthenticated. In the
 *  browser the ordering holds for free: the tag is in the served
 *  `<head>` and is parsed before the module script runs. */
let profiles: typeof import('./profiles.js');

beforeAll(async () => {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'plamenix-api-token');
  meta.setAttribute('content', 'tok');
  document.head.appendChild(meta);
  profiles = await import('./profiles.js');
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The URL the helper actually requested. */
function requestedUrl(): string {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[0];
}

function requestInit(): RequestInit {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[1];
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listProfiles', () => {
  it('unwraps the envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { profiles: [{ id: 'a', name: 'A' }] }));

    await expect(profiles.listProfiles()).resolves.toEqual([{ id: 'a', name: 'A' }]);
    expect(requestedUrl()).toBe('/api/profiles');
  });

  it('reports the status and the body when the server refuses', async () => {
    // The user sees this string. "list profiles failed" alone would not
    // distinguish an expired token from an unreachable server.
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));

    await expect(profiles.listProfiles()).rejects.toThrow(/list profiles failed \(403\): nope/);
  });

  it('still throws when the error body cannot be read', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('stream closed')),
    } as unknown as Response);

    await expect(profiles.listProfiles()).rejects.toThrow(/list profiles failed \(500\)/);
  });
});

describe('saveProfile', () => {
  it('POSTs the draft as JSON and unwraps the saved profile', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { profile: { id: 'new', name: 'N' } }));
    const draft = {
      name: 'N',
      host: 'localhost',
      port: 3050,
      database: '/data/test.fdb',
      user: 'SYSDBA',
      encryptionRequired: false,
      pureRust: false,
    };

    await expect(profiles.saveProfile(draft)).resolves.toEqual({ id: 'new', name: 'N' });
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify(draft));
  });
});

describe('deleteProfile', () => {
  it('uses DELETE on the id path', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await profiles.deleteProfile('abc');

    expect(requestedUrl()).toBe('/api/profiles/abc');
    expect(requestInit().method).toBe('DELETE');
  });

  it('escapes an id so it cannot climb out of its path segment', async () => {
    // A profile id reaches here from stored data, not from a literal.
    // Interpolating it raw would let `../` address a different route
    // entirely — `/api/profiles/../sessions` is `/api/sessions`.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await profiles.deleteProfile('../sessions');

    expect(requestedUrl()).toBe('/api/profiles/..%2Fsessions');
    expect(requestedUrl()).not.toContain('/api/sessions');
  });

  it('escapes a query string out of an id', async () => {
    // `?` would otherwise end the path and turn the rest into
    // parameters the route never validated.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await profiles.deleteProfile('a?b=c');

    expect(requestedUrl()).toBe('/api/profiles/a%3Fb%3Dc');
  });
});

describe('touchProfileDisconnected', () => {
  it('POSTs to the touch path with the id escaped', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await profiles.touchProfileDisconnected('a b/c');

    expect(requestedUrl()).toBe('/api/profiles/a%20b%2Fc/touch-disconnected');
    expect(requestInit().method).toBe('POST');
  });
});

describe('connectByProfile', () => {
  it('sends the secret in the body, never in the path', async () => {
    // A password in a URL lands in access logs, proxy logs, and the
    // browser's history. The body is the only place it belongs.
    fetchMock.mockResolvedValue(jsonResponse(200, { sessionId: 'sess-1' }));

    await expect(profiles.connectByProfile('p1', { password: 'hunter2' })).resolves.toEqual({
      sessionId: 'sess-1',
    });

    expect(requestedUrl()).toBe('/api/profiles/p1/connect');
    expect(requestedUrl()).not.toContain('hunter2');
    expect(requestInit().body).toContain('hunter2');
  });

  it('names itself in the failure so the user knows what refused', async () => {
    fetchMock.mockResolvedValue(new Response('bad password', { status: 401 }));

    await expect(profiles.connectByProfile('p1', { password: 'x' })).rejects.toThrow(
      /profile connect failed \(401\): bad password/,
    );
  });
});

describe('every helper', () => {
  it('carries the auth header', async () => {
    // Each of these reaches `/api/*` with raw `fetch` rather than
    // through the transport, so each has its own chance to forget.
    const calls: [string, () => Promise<unknown>][] = [
      ['listProfiles', () => profiles.listProfiles()],
      [
        'saveProfile',
        () =>
          profiles.saveProfile({
            name: 'N',
            host: 'h',
            port: 3050,
            database: 'd',
            user: 'u',
            encryptionRequired: false,
            pureRust: false,
          }),
      ],
      ['deleteProfile', () => profiles.deleteProfile('id')],
      ['touchProfileDisconnected', () => profiles.touchProfileDisconnected('id')],
      ['connectByProfile', () => profiles.connectByProfile('id', { password: 'p' })],
    ];

    for (const [name, call] of calls) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(200, { profiles: [], profile: {}, sessionId: 's' }));
      await call();
      const headers = requestInit().headers as Record<string, string>;
      expect(headers.Authorization, `${name} sent no token`).toBe('Bearer tok');
    }
  });
});
