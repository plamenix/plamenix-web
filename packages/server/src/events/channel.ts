/**
 * The host→client push channel.
 *
 * The web edition had none. Everything the shell learned, it learned by
 * asking — which is why plugin events had nowhere to go on this
 * edition, and why the transport contract's push half was still a
 * promise. The desktop shell has had this since the beginning in the
 * form of Tauri events.
 *
 * ## Why the token cannot ride in a header
 *
 * The browser `WebSocket` constructor takes a URL and a subprotocol
 * list, and nothing else. It cannot set `Authorization`. The two ways
 * out are a query parameter and the subprotocol list, and the query
 * parameter is the worse one: URLs reach access logs, proxy logs, and
 * `Referer`, so a token there is a token written down in three places
 * nobody audits. The subprotocol travels in a request header, is echoed
 * back on acceptance, and is what the WHATWG spec leaves available for
 * exactly this.
 *
 * ## Why CORS does not help here
 *
 * A WebSocket upgrade is not subject to the same-origin policy: no
 * preflight is sent and no CORS header is consulted. A page on any
 * origin can open a socket to this server. What stops it is the same
 * pair that stops DNS rebinding on the HTTP side — the `Host` check,
 * which the gate already applies to the upgrade because that is an
 * ordinary request until it is switched — plus the token, which such a
 * page has no way to obtain.
 */

import type { FastifyInstance } from 'fastify';
// Imported for its `fastify` module augmentation as much as for the
// type: without it, `{ websocket: true }` is not a known route option
// and the handler is typed as an ordinary (request, reply) pair.
import type { WebSocket } from '@fastify/websocket';
import { actorFor, type NamedToken } from '../security/token.js';
import type { AuditSink } from '../security/gate.js';

/** Subprotocol prefix carrying the bearer token. */
const BEARER_PREFIX = 'plamenix.bearer.';

/** What the server pushes. Mirrors the shape `@plamenix/ui`'s event bus
 *  emits, so a client can forward it without translation. */
export interface PushEvent {
  topic: string;
  payload: unknown;
}

/** Extracts the token from a `Sec-WebSocket-Protocol` list. */
export function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  for (const raw of header.split(',')) {
    const value = raw.trim();
    if (value.startsWith(BEARER_PREFIX)) {
      const token = value.slice(BEARER_PREFIX.length);
      return token.length > 0 ? token : null;
    }
  }
  return null;
}

/** The subprotocol a client should offer for `token`. */
export function bearerProtocol(token: string): string {
  return `${BEARER_PREFIX}${token}`;
}

export interface EventChannelOptions {
  tokens: readonly NamedToken[];
  audit: AuditSink;
}

/**
 * A set of connected clients, with a broadcast.
 *
 * Deliberately not per-session or per-tenant. This edition is
 * single-user by decision (see the remediation plan's Q1 and Wave 5):
 * every named token reaches the same data, so a subscriber filter would
 * assert an isolation the rest of the server does not provide. When
 * multi-user isolation lands in 1.1, this is one of the places that has
 * to grow a scope — recorded here so it is not mistaken for done.
 */
export class EventChannel {
  readonly #clients = new Set<WebSocket>();

  /** How many sockets are currently attached. */
  get size(): number {
    return this.#clients.size;
  }

  add(socket: WebSocket): void {
    this.#clients.add(socket);
  }

  remove(socket: WebSocket): void {
    this.#clients.delete(socket);
  }

  /**
   * Sends an event to every attached client.
   *
   * A socket that throws on send is dropped rather than retried: it has
   * already failed its own close handshake, and keeping it would mean
   * every later broadcast pays for it again.
   *
   * @returns How many clients the event reached.
   */
  broadcast(event: PushEvent): number {
    const frame = JSON.stringify(event);
    let delivered = 0;
    for (const socket of [...this.#clients]) {
      try {
        socket.send(frame);
        delivered += 1;
      } catch {
        this.#clients.delete(socket);
      }
    }
    return delivered;
  }

  /** Closes every socket. For shutdown. */
  closeAll(): void {
    for (const socket of [...this.#clients]) {
      try {
        socket.close();
      } catch {
        // Already gone; nothing to do but stop tracking it.
      }
      this.#clients.delete(socket);
    }
  }
}

/**
 * Registers `GET /api/events` as a WebSocket endpoint.
 *
 * The upgrade has already passed the gate's `Host` and `Origin` checks
 * by the time this runs — an upgrade is an ordinary request until the
 * server switches protocols, so `onRequest` sees it. What the gate
 * cannot check is the token, because it arrives as a subprotocol rather
 * than an `Authorization` header, so that happens here.
 */
export function eventChannelRoute(channel: EventChannel, options: EventChannelOptions) {
  return async function (app: FastifyInstance): Promise<void> {
    app.get('/api/events', { websocket: true }, (socket, request) => {
      const offered = request.headers['sec-websocket-protocol'];
      const token = tokenFromProtocols(Array.isArray(offered) ? offered.join(',') : offered);
      const actor = token === null ? null : actorFor(token, options.tokens);

      if (actor === null) {
        options.audit({
          action: 'events.auth_refused',
          outcome: 'refused',
          remoteAddr: request.ip,
          detail: JSON.stringify({ offered: token === null ? 'none' : 'invalid' }),
        });
        // 1008 is "policy violation". Closing rather than never
        // accepting keeps the failure legible to the client, which
        // otherwise sees only a socket that ended.
        socket.close(1008, 'unauthorised');
        return;
      }

      channel.add(socket);
      options.audit({
        action: 'events.attached',
        outcome: 'allowed',
        actor,
        remoteAddr: request.ip,
      });

      socket.on('close', () => channel.remove(socket));
      socket.on('error', () => channel.remove(socket));
      // Nothing is read from the client. The channel is one-directional
      // by design: anything a client wants to say has an HTTP route,
      // and a socket that accepts commands is a second, unaudited way
      // into the server.
    });
  };
}
