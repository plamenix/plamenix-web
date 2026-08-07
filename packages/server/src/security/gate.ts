/**
 * The gate every request passes before a route sees it.
 *
 * Four checks, each closing something the others do not, and every
 * refusal recorded.
 *
 * ## Host — the one that matters most
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
 * token alone already makes classic CSRF impossible. This is redundant
 * with that on purpose: it costs one comparison and still holds if a
 * future change introduces a cookie.
 *
 * ## Token — other processes on this machine
 *
 * Loopback is not a trust boundary between local processes. Anything
 * running as any user on the machine can open a socket to the port.
 * Tokens are named, so the audit log records which operator acted
 * rather than only that someone did.
 *
 * ## Rate limit — bounded effort
 *
 * Keyed by actor once authenticated, by source address before that, so
 * one client's loop cannot exhaust another's budget.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorFor, type NamedToken } from './token.js';
import type { RateLimiter } from './rate-limit.js';

/** Paths served without a token. */
const PUBLIC_PATHS = new Set(['/api/ping']);

/**
 * Host names a loopback binding may legitimately be reached by.
 *
 * Deliberately not pattern-matched: `startsWith('localhost')` would
 * accept `localhost.evil.com`, which resolves wherever the attacker
 * likes.
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
export function isAllowedOrigin(origin: string | undefined, extra: readonly string[]): boolean {
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

/** How the gate reports an event worth recording. */
export type AuditSink = (entry: {
  action: string;
  outcome: 'allowed' | 'refused';
  actor?: string | undefined;
  remoteAddr?: string | undefined;
  target?: string | undefined;
  detail?: string | undefined;
}) => void;

export interface GateOptions {
  tokens: readonly NamedToken[];
  /** Extra host names beyond loopback, for a deliberate non-loopback
   *  deployment behind a proxy. */
  allowedHosts: readonly string[];
  limiter: RateLimiter;
  audit: AuditSink;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Token name that authenticated this request, once it has. */
    actor?: string;
  }
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
    const remoteAddr = request.ip;

    if (!isAllowedHost(request.headers.host, options.allowedHosts)) {
      // Recorded, and with the Host attached. A rebinding attempt is
      // one of the few events here that means someone is actively
      // trying something, and the domain names them.
      options.audit({
        action: 'request.host_refused',
        outcome: 'refused',
        remoteAddr,
        detail: JSON.stringify({ host: request.headers.host, url: request.url }),
      });
      return reply.code(403).send({ error: 'forbidden_host' });
    }

    if (!isAllowedOrigin(request.headers.origin, options.allowedHosts)) {
      options.audit({
        action: 'request.origin_refused',
        outcome: 'refused',
        remoteAddr,
        detail: JSON.stringify({ origin: request.headers.origin, url: request.url }),
      });
      return reply.code(403).send({ error: 'forbidden_origin' });
    }

    // Only the API is gated. The SPA and its assets have to load before
    // there is anything to hold a token.
    if (!request.url.startsWith('/api/')) return;

    const path = request.url.split('?')[0] ?? '';
    const isPublic = PUBLIC_PATHS.has(path);

    let actor: string | null = null;
    if (!isPublic) {
      const supplied = bearerToken(request.headers.authorization);
      actor = supplied === null ? null : actorFor(supplied, options.tokens);
      if (actor === null) {
        options.audit({
          action: 'auth.refused',
          outcome: 'refused',
          remoteAddr,
          target: path,
          detail: JSON.stringify({ reason: supplied === null ? 'missing' : 'unknown_token' }),
        });
        return reply.code(401).send({ error: 'unauthorized' });
      }
      request.actor = actor;
    }

    // Keyed by actor once we know one, by source address before that,
    // so one operator's loop cannot exhaust another's budget and an
    // unauthenticated flood is bounded per source rather than globally.
    const verdict = options.limiter.check(actor ?? `addr:${remoteAddr}`);
    if (!verdict.allowed) {
      options.audit({
        action: 'request.rate_limited',
        outcome: 'refused',
        actor: actor ?? undefined,
        remoteAddr,
        target: path,
      });
      return reply
        .code(429)
        .header('retry-after', Math.max(1, Math.ceil((verdict.resetAt - Date.now()) / 1000)))
        .send({ error: 'rate_limited' });
    }
    return;
  });
}
