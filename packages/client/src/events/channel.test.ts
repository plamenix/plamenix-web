// @vitest-environment jsdom

/**
 * The client end of the push channel.
 *
 * The connection is expected to drop — laptops sleep, proxies time out
 * idle sockets, servers restart. So the behaviour worth pinning is not
 * connecting, it is reconnecting, and specifically knowing when not to:
 * retrying a refused token is a hot loop that writes an audit entry per
 * attempt and can never succeed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A WebSocket stand-in whose lifecycle the test drives. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** Drives a server-side close. */
  fireClose(code = 1006): void {
    this.onclose?.({ code });
  }
}

let channel: typeof import('./channel.js');
let bus: typeof import('@plamenix/ui').eventBus;

beforeEach(async () => {
  FakeSocket.instances = [];
  vi.resetModules();
  channel = await import('./channel.js');
  bus = (await import('@plamenix/ui')).eventBus;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Opens a channel with everything injectable stubbed out. */
function connect(overrides: Partial<Parameters<typeof channel.connectEventChannel>[0]> = {}) {
  const timers: { fn: () => void; ms: number }[] = [];
  const dispose = channel.connectEventChannel({
    url: 'ws://localhost/api/events',
    token: 'tok',
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    setTimeoutImpl: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearTimeoutImpl: () => undefined,
    random: () => 1,
    ...overrides,
  });
  return { dispose, timers, sockets: FakeSocket.instances };
}

describe('connecting', () => {
  it('offers the token as a subprotocol, not in the URL', () => {
    // A token in the query string lands in access logs, proxy logs and
    // Referer. The subprotocol is the only header a browser WebSocket
    // lets a caller set.
    const { sockets } = connect();
    expect(sockets[0]?.url).not.toContain('tok');
    expect(sockets[0]?.protocols).toEqual(['plamenix.bearer.tok']);
  });

  it('does not connect at all without a token', () => {
    // Every attempt would be refused. Failing quietly leaves the HTTP
    // routes to report the real problem, which they do with a status
    // code rather than a socket that keeps dying.
    const { sockets } = connect({ token: null });
    expect(sockets).toHaveLength(0);
  });
});

describe('receiving', () => {
  it('forwards an event onto the shared bus', () => {
    // The whole point: a subscriber should not need to know whether the
    // event arrived over a WebSocket or a Tauri event.
    const seen: unknown[] = [];
    const sub = bus.subscribe('test.client', 'db/query/executed', (_topic, payload) => {
      seen.push(payload);
    });
    const { sockets } = connect();

    sockets[0]?.onmessage?.({
      data: JSON.stringify({ topic: 'db/query/executed', payload: { rows: 3 } }),
    });

    expect(seen).toEqual([{ rows: 3 }]);
    sub.dispose();
  });

  it('ignores a frame that is not ours rather than throwing', () => {
    // A proxy injecting a keepalive, or a future frame type this
    // version does not know. Throwing inside onmessage kills the
    // handler for every later frame.
    const { sockets } = connect();
    expect(() => sockets[0]?.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(() => sockets[0]?.onmessage?.({ data: '{"no":"topic"}' })).not.toThrow();
    expect(() => sockets[0]?.onmessage?.({ data: 42 })).not.toThrow();
  });
});

describe('reconnecting', () => {
  it('retries after an unexpected close', () => {
    const { sockets, timers } = connect();
    sockets[0]?.fireClose(1006);

    expect(timers).toHaveLength(1);
    timers[0]?.fn();
    expect(sockets).toHaveLength(2);
  });

  it('backs off further on each failure', () => {
    const { sockets, timers } = connect();
    sockets[0]?.fireClose(1006);
    timers[0]?.fn();
    sockets[1]?.fireClose(1006);

    expect(timers[1]?.ms).toBeGreaterThan(timers[0]?.ms ?? 0);
  });

  it('caps the delay so a recovered server is noticed', () => {
    const { sockets, timers } = connect();
    for (let i = 0; i < 12; i += 1) {
      sockets[i]?.fireClose(1006);
      timers[i]?.fn();
    }
    expect(timers.at(-1)?.ms).toBeLessThanOrEqual(30_000);
  });

  it('starts over once a connection succeeds', () => {
    // Resetting on the attempt rather than the success would turn a
    // server that accepts and immediately drops into a tight loop.
    const { sockets, timers } = connect();
    sockets[0]?.fireClose(1006);
    timers[0]?.fn();
    sockets[1]?.onopen?.();
    sockets[1]?.fireClose(1006);

    expect(timers[1]?.ms).toBe(timers[0]?.ms);
  });

  it('gives up on a refused token', () => {
    // 1008 is what the server sends for a bad token. Retrying writes an
    // audit entry per attempt and can never succeed — the token is not
    // going to change while the page is open.
    const { sockets, timers } = connect();
    sockets[0]?.fireClose(1008);

    expect(timers).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it('does not schedule twice for one close', () => {
    // `onerror` fires alongside `onclose`; retrying from both would
    // double every backoff.
    const { sockets, timers } = connect();
    sockets[0]?.onerror?.();
    sockets[0]?.fireClose(1006);

    expect(timers).toHaveLength(1);
  });
});

describe('disposing', () => {
  it('closes the socket and stops retrying', () => {
    const { sockets, timers, dispose } = connect();
    dispose();

    expect(sockets[0]?.closed).toBe(true);
    sockets[0]?.fireClose(1006);
    expect(timers).toHaveLength(0);
  });

  it('does not reconnect from a timer that had already been scheduled', () => {
    // The disposer clears the timer, but a firing that slips through
    // must not resurrect the connection.
    const { sockets, timers, dispose } = connect();
    sockets[0]?.fireClose(1006);
    dispose();
    timers[0]?.fn();

    expect(sockets).toHaveLength(1);
  });
});

describe('retryDelay', () => {
  it('grows with the attempt and stays under the cap', () => {
    expect(channel.retryDelay(0, () => 1)).toBe(500);
    expect(channel.retryDelay(1, () => 1)).toBe(1000);
    expect(channel.retryDelay(20, () => 1)).toBe(30_000);
  });

  it('jitters, so tabs do not reconnect in lockstep', () => {
    // A server restart wakes every open tab at once; without jitter
    // they all arrive together and do it again on the next failure.
    expect(channel.retryDelay(4, () => 0)).toBe(0);
    expect(channel.retryDelay(4, () => 0.5)).toBeLessThan(channel.retryDelay(4, () => 1));
  });
});
