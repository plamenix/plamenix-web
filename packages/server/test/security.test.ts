/**
 * The gate, exercised without the helper that authenticates everything
 * else.
 *
 * Every other test file builds through `buildAuthedApp`, which supplies
 * a token and an allowed Host on every request. That keeps those tests
 * about their own subject — but it means none of them would notice if
 * the gate stopped running. These use a raw app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import {
  bearerToken,
  isAllowedHost,
  isAllowedOrigin,
} from '../src/security/gate.js';
import { DEFAULT_ACTOR, actorFor, resolveTokens } from '../src/security/token.js';
import { RateLimiter } from '../src/security/rate-limit.js';

const TOKEN = 'security-test-token-0123456789abc';

describe('security gate', () => {
  let workDir: string;
  let app: App;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'security-test-'));
    app = await buildApp(
      loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        AUTH_TOKEN: TOKEN,
        PROFILES_PATH: join(workDir, 'profiles.json'),
        PLUGINS_PATH: join(workDir, 'plugins'),
        PLUGIN_DATA_ROOT: join(workDir, 'plugin-data'),
      } as NodeJS.ProcessEnv),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  const localhost = { host: 'localhost:3000' };

  it('refuses an API request with no token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: localhost,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: { ...localhost, authorization: 'Bearer not-the-token-at-all-really' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the right token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: { ...localhost, authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a request whose Host is not one we answer to', async () => {
    // DNS rebinding. The attacker's page resolves their domain to
    // 127.0.0.1, so the request is same-origin and CORS never applies —
    // but the browser still sends their domain as Host, and that is
    // what we reject. Binding to loopback does not help here at all.
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { host: 'evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden_host' });
  });

  it('refuses a Host that merely starts with a loopback name', async () => {
    // `localhost.evil.com` resolves wherever the attacker likes. A
    // prefix check would have accepted it.
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { host: 'localhost.evil.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a cross-origin request even with a valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: {
        ...localhost,
        origin: 'https://evil.example.com',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden_origin' });
  });

  it('leaves the health check reachable without a token', async () => {
    // Something has to be able to say the server is up without holding
    // a credential. It reports liveness and nothing else.
    const res = await app.inject({ method: 'GET', url: '/api/ping', headers: localhost });
    expect(res.statusCode).toBe(200);
  });

  it('turns a request away before parsing its body', async () => {
    // The hook is `onRequest`, not `preHandler`. An unauthenticated
    // caller should not be able to make the server allocate for a
    // payload it will never look at.
    const res = await app.inject({
      method: 'POST',
      url: '/api/execute',
      headers: localhost,
      payload: { sessionId: 'x'.repeat(1024), sql: 'SELECT 1' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('host and origin matching', () => {
  it('accepts loopback names and rejects lookalikes', () => {
    for (const good of ['localhost', 'localhost:3000', '127.0.0.1:8080', '[::1]:3000']) {
      expect(isAllowedHost(good, [])).toBe(true);
    }
    for (const bad of [
      'evil.example.com',
      'localhost.evil.com',
      '127.0.0.1.evil.com',
      '',
      undefined,
    ]) {
      expect(isAllowedHost(bad, [])).toBe(false);
    }
  });

  it('honours an explicitly configured extra host', () => {
    expect(isAllowedHost('plamenix.internal:3000', ['plamenix.internal'])).toBe(true);
  });

  it('treats an absent Origin as fine and a foreign one as not', () => {
    // Absent covers same-origin navigations and non-browser clients.
    expect(isAllowedOrigin(undefined, [])).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000', [])).toBe(true);
    expect(isAllowedOrigin('https://evil.example.com', [])).toBe(false);
    // A sandboxed iframe sends this literal string.
    expect(isAllowedOrigin('null', [])).toBe(false);
  });
});

describe('token handling', () => {
  it('parses a bearer header and ignores anything else', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('generates a token when none is configured', () => {
    // There is no unauthenticated mode. An operator who forgets gets a
    // generated token, not an open server.
    const resolved = resolveTokens(undefined, undefined);
    expect(resolved.source).toBe('generated');
    expect(resolved.tokens).toHaveLength(1);
    expect(resolved.tokens[0]!.name).toBe(DEFAULT_ACTOR);
    expect(resolved.tokens[0]!.value.length).toBeGreaterThan(20);
  });

  it('generates a different token each time', () => {
    expect(resolveTokens(undefined, undefined).tokens[0]!.value).not.toBe(
      resolveTokens(undefined, undefined).tokens[0]!.value,
    );
  });

  it('refuses a configured token too short to be worth having', () => {
    // Refused rather than warned about: a warning is read once and then
    // scrolls away.
    expect(() => resolveTokens(undefined, 'short')).toThrow();
    expect(() => resolveTokens('alice:short', undefined)).toThrow();
  });

  it('names an unnamed token so the audit log has an actor', () => {
    const resolved = resolveTokens(undefined, 'a-long-enough-configured-token');
    expect(resolved.tokens).toEqual([
      { name: DEFAULT_ACTOR, value: 'a-long-enough-configured-token' },
    ]);
  });

  it('parses several named tokens', () => {
    const resolved = resolveTokens(
      'alice:alice-token-0123456789, bob:bob-token-0123456789',
      undefined,
    );
    expect(resolved.tokens.map((t) => t.name)).toEqual(['alice', 'bob']);
  });

  it('refuses duplicate names', () => {
    // Two operators sharing one name would make the audit log
    // unanswerable about who did something.
    expect(() =>
      resolveTokens('alice:token-one-0123456789,alice:token-two-0123456789', undefined),
    ).toThrow(/unique/);
  });

  it('refuses a malformed entry rather than skipping it', () => {
    // Skipping would silently drop a credential the operator believes
    // is live.
    expect(() => resolveTokens('no-colon-here-0123456789', undefined)).toThrow();
  });

  it('identifies which operator a token belongs to', () => {
    const tokens = [
      { name: 'alice', value: 'alice-token-0123456789' },
      { name: 'bob', value: 'bob-token-0123456789' },
    ];
    expect(actorFor('bob-token-0123456789', tokens)).toBe('bob');
    expect(actorFor('nobody-token-012345678', tokens)).toBeNull();
  });
});

describe('rate limiting', () => {
  it('permits up to the limit and refuses past it', () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
    expect(limiter.check('alice', 0).allowed).toBe(true);
    expect(limiter.check('alice', 1).allowed).toBe(true);
    expect(limiter.check('alice', 2).allowed).toBe(true);
    expect(limiter.check('alice', 3).allowed).toBe(false);
  });

  it('keeps one actor from spending another actor budget', () => {
    // A global counter would let one bad client lock everyone out,
    // which is the failure the limiter exists to prevent.
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });
    limiter.check('alice', 0);
    limiter.check('alice', 0);
    expect(limiter.check('alice', 0).allowed).toBe(false);
    expect(limiter.check('bob', 0).allowed).toBe(true);
  });

  it('starts a fresh window once the old one elapses', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('alice', 0).allowed).toBe(true);
    expect(limiter.check('alice', 500).allowed).toBe(false);
    expect(limiter.check('alice', 1000).allowed).toBe(true);
  });

  it('reports when the window resets so a Retry-After can be sent', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    limiter.check('alice', 0);
    expect(limiter.check('alice', 100).resetAt).toBe(1000);
  });

  it('sweeps expired windows so the map does not grow forever', () => {
    // One entry per distinct source address, otherwise — a slow leak an
    // attacker can drive.
    const limiter = new RateLimiter({ max: 5, windowMs: 1000 });
    limiter.check('a', 0);
    limiter.check('b', 0);
    expect(limiter.size()).toBe(2);
    expect(limiter.sweep(2000)).toBe(2);
    expect(limiter.size()).toBe(0);
  });
});
