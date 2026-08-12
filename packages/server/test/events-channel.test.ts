/**
 * The push channel, and who is allowed to attach to it.
 *
 * A WebSocket upgrade is not subject to the same-origin policy: no
 * preflight is sent and no CORS header is consulted, so a page on any
 * origin can try to open this socket. The `Host` check and the token
 * are the whole defence, which makes them worth testing rather than
 * assuming — especially the token, which cannot ride in an
 * `Authorization` header and so travels by a route nothing else uses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventChannel, bearerProtocol, tokenFromProtocols } from '../src/events/channel.js';
import { upgradeToken } from '../src/security/gate.js';
import { buildAuthedApp, TEST_TOKEN } from './helpers/authed.js';
import type { App } from '../src/app.js';

describe('tokenFromProtocols', () => {
  it('reads the token out of the subprotocol list', () => {
    expect(tokenFromProtocols(bearerProtocol('abc123'))).toBe('abc123');
  });

  it('finds it among other offered subprotocols', () => {
    // A client may legitimately offer more than one.
    expect(tokenFromProtocols(`json, ${bearerProtocol('abc123')}, msgpack`)).toBe('abc123');
  });

  it('reports nothing when no token was offered', () => {
    expect(tokenFromProtocols('json, msgpack')).toBeNull();
    expect(tokenFromProtocols('')).toBeNull();
    expect(tokenFromProtocols(undefined)).toBeNull();
  });

  it('treats an empty token as absent rather than as a token', () => {
    // `plamenix.bearer.` with nothing after it would otherwise be
    // compared against the configured tokens as the empty string.
    expect(tokenFromProtocols('plamenix.bearer.')).toBeNull();
  });
});

describe('upgradeToken', () => {
  it('agrees with the channel about what a token looks like', () => {
    // Two places parse this; they have to agree, or an upgrade the gate
    // admits could be refused by the route or the reverse.
    expect(upgradeToken(bearerProtocol('abc123'))).toBe('abc123');
    expect(upgradeToken(['json', bearerProtocol('abc123')])).toBe('abc123');
    expect(upgradeToken(undefined)).toBeNull();
    expect(upgradeToken('plamenix.bearer.')).toBeNull();
  });
});

describe('EventChannel', () => {
  interface FakeSocket {
    sent: string[];
    send: (frame: string) => void;
    close: () => void;
  }

  function socket(onSend?: () => void): FakeSocket {
    const sent: string[] = [];
    return {
      sent,
      send: (frame: string) => {
        onSend?.();
        sent.push(frame);
      },
      close: () => undefined,
    };
  }

  it('delivers an event to every attached client', () => {
    const channel = new EventChannel();
    const a = socket();
    const b = socket();
    channel.add(a as never);
    channel.add(b as never);

    expect(channel.broadcast({ topic: 'db/query/executed', payload: { rows: 3 } })).toBe(2);
    expect(JSON.parse(a.sent[0] ?? '')).toEqual({
      topic: 'db/query/executed',
      payload: { rows: 3 },
    });
    expect(b.sent).toHaveLength(1);
  });

  it('drops a socket that fails to send rather than retrying it', () => {
    // It has already failed its own close handshake. Keeping it means
    // every later broadcast pays for it again.
    const channel = new EventChannel();
    const bad = socket(() => {
      throw new Error('socket closed');
    });
    const good = socket();
    channel.add(bad as never);
    channel.add(good as never);

    expect(channel.broadcast({ topic: 't', payload: null })).toBe(1);
    expect(channel.size).toBe(1);
    expect(good.sent).toHaveLength(1);
  });

  it('stops tracking a socket once it closes', () => {
    const channel = new EventChannel();
    const s = socket();
    channel.add(s as never);
    channel.remove(s as never);

    expect(channel.broadcast({ topic: 't', payload: null })).toBe(0);
    expect(channel.size).toBe(0);
  });

  it('broadcasts to nobody without complaining', () => {
    expect(new EventChannel().broadcast({ topic: 't', payload: null })).toBe(0);
  });
});

describe('the upgrade, over the wire', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildAuthedApp({ LOG_LEVEL: 'fatal' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts an upgrade carrying a valid token', async () => {
    const socket = await app.injectWS('/api/events', {
      headers: {
        host: 'localhost:3000',
        'sec-websocket-protocol': bearerProtocol(TEST_TOKEN),
      },
    });
    expect(socket.readyState).toBe(socket.OPEN);
    socket.terminate();
  });

  it('refuses an upgrade with no token', async () => {
    // The gate turns this away before the route sees it, the same way
    // it turns away an unauthenticated GET. The upgrade never
    // completes, so this surfaces as a thrown handshake failure rather
    // than a socket that opens and then closes.
    await expect(
      app.injectWS('/api/events', { headers: { host: 'localhost:3000' } }),
    ).rejects.toThrow(/401/);
  });

  it('refuses an upgrade whose Host is not ours', async () => {
    // The rebinding case, and the one that matters most here: a
    // WebSocket upgrade gets no preflight, so this check is doing the
    // work CORS does not.
    await expect(
      app.injectWS('/api/events', {
        headers: {
          host: 'evil.example.com',
          'sec-websocket-protocol': bearerProtocol(TEST_TOKEN),
        },
      }),
    ).rejects.toThrow(/403/);
  });

  it('refuses an upgrade carrying the wrong token', async () => {
    await expect(
      app.injectWS('/api/events', {
        headers: {
          host: 'localhost:3000',
          'sec-websocket-protocol': bearerProtocol('not-the-right-token-0123456789'),
        },
      }),
    ).rejects.toThrow(/401/);
  });

});
