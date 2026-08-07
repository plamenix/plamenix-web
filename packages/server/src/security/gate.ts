/**
 * The gate every request passes before a route sees it.
 *
 * Three checks, each closing something the others do not.
 *
 * ## Host — this is the one that matters most
 *
 * Binding to loopback is not a defence against a web page. An attacker
 * points a domain they control at `127.0.0.1`, waits for the DNS TTL to
 * flip, and their page's requests to the local API are *same-origin* —
 * so no preflight happens and CORS never applies. That is DNS
 * rebinding, and it is the specific attack a localhost service gets.
 *
 * What the attacker cannot do is change the `Host` header: the browser
 * sets it to the domain they navigated to. Rejecting any `Host` that is
 * not a loopback name is what actually closes it.
 *
 * ## Origin — CSRF, for requests that carry one
 *
 * Bearer tokens are not attached by the browser automatically, so the
 * token alone already makes classic CSRF impossible. The Origin check
 * is redundant with that on purpose: it costs one comparison and it
 * still holds if a future change introduces a cookie.
 *
 * ## Bearer token — other processes on this machine
 *
 * Loopback is not a trust boundary between local processes. Anything
 * running as any user on the machine can open a socket to the port, and
 * without a token it would get the same access the person sitting at
 * the keyboard has, to whatever the configured Firebird user can reach.
 *
 * The token is delivered to the SPA by injecting it into the served
 * HTML rather than in a cookie, so it travels in an `Authorization`
 * header the browser never sends on its own.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Paths served without a token. */
const PUBLIC_PATHS = new Set(['/api/ping']);

/**
 * Host names a loopback binding may legitimately be reached by.
 *
 * Deliberately not configurable per request, and deliberately not
 * pattern-matched: `startsWith('localhost')` would accept
 * `localhost.evil.com`, which resolves wherever the attacker likes.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Strips the `:port` suffix, leaving IPv6 brackets intact. */
function hostname(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** Whether `host` is one this server answers to. */
export function isAllowedHost(hostHeader: string | undefined, extra: readonly string[]): boolean {
  if (hostHeader === undefined || hostHeader === '') {
    // HTTP/1.1 requires a Host header. A request without one is not a
    // browser being helpful.
    return false;
  }
  const name = hostname(hostHeader);
  return LOOPBACK_HOSTS.has(name) || extra.includes(name);
}

/** Whether an `Origin`, when present, is one of ours. */
export function isAllowedOrigin(
  origin: string | undefined,
  extra: readonly string[],
): boolean {
  // Absent is fine: same-origin navigations and non-browser clients
  // (curl, the desktop shell) do not send one.
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) || extra.includes(url.hostname);
  } catch {
    return false;
  }
}

/** Reads a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Compares two tokens without leaking their common prefix through
 * timing.
 *
 * The window is small over loopback, but constant-time comparison is
 * one function call and the alternative is explaining why it was fine.
 */
export function tokensMatch(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i += 1) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** What the gate needs to know. */
export interface GateOptions {
  /** The token every `/api/*` request must present. */
  token: string;
  /** Extra host names to accept beyond loopback, for a deliberate
   *  non-loopback deployment behind a proxy. */
  allowedHosts: readonly string[];
}

/**
 * Installs the gate as an `onRequest` hook.
 *
 * `onRequest` rather than `preHandler` so a rejected request is turned
 * away before its body is parsed — an unauthenticated caller should not
 * be able to make the server allocate for a payload.
 */
export function installSecurityGate(app: FastifyInstance, options: GateOptions): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAllowedHost(request.headers.host, options.allowedHosts)) {
      request.log.warn(
        { host: request.headers.host },
        'refused a request whose Host is not one this server answers to',
      );
      return reply.code(403).send({ error: 'forbidden_host' });
    }

    if (!isAllowedOrigin(request.headers.origin, options.allowedHosts)) {
      request.log.warn({ origin: request.headers.origin }, 'refused a cross-origin request');
      return reply.code(403).send({ error: 'forbidden_origin' });
    }

    // Only the API is gated. The SPA and its assets have to load before
    // there is anything to hold a token.
    if (!request.url.startsWith('/api/')) return;
    if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return;

    const supplied = bearerToken(request.headers.authorization);
    if (supplied === null || !tokensMatch(supplied, options.token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return;
  });
}
