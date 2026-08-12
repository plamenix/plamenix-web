import { eventBus } from '@plamenix/ui';
import { apiTokenForUpgrade } from '../transport/fetch.js';

/**
 * The client end of the host→client push channel.
 *
 * Feeds what the server pushes into the shared event bus, so a plugin
 * or a panel subscribing to a topic does not need to know whether the
 * event came from this edition's WebSocket or the desktop shell's Tauri
 * events. That symmetry is the point: it is what lets plugin event
 * subscriptions mean the same thing on both editions.
 *
 * The connection is expected to drop. A laptop sleeps, a proxy times an
 * idle socket out, the server restarts during development. So the
 * interesting behaviour here is not connecting, it is reconnecting —
 * and specifically, knowing when not to.
 */

/** Frame shape the server sends. */
export interface PushEvent {
  topic: string;
  payload: unknown;
}

/** Subprotocol prefix the server reads the token from. */
const BEARER_PREFIX = 'plamenix.bearer.';

/** First retry delay, in milliseconds. */
const BASE_DELAY_MS = 500;
/** Ceiling on the retry delay. Beyond this, waiting longer only makes a
 *  recovered server take longer to be noticed. */
const MAX_DELAY_MS = 30_000;

/**
 * Close codes that mean retrying is pointless.
 *
 * 1008 is what the server sends for a refused token. Retrying that is a
 * hot loop against the audit log — every attempt writes a refusal — and
 * it will never succeed, because the token is not going to change while
 * the page is open.
 */
const FATAL_CLOSE_CODES = new Set([1008]);

/** Backoff with jitter, so N tabs reconnecting after a server restart
 *  do not arrive in lockstep. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  // Full jitter: anywhere in [0, exponential]. Spreads a thundering
  // herd better than a fixed fraction does.
  return Math.round(exponential * random());
}

/** Parses a frame, or returns null when it is not one of ours. */
export function parsePushEvent(data: unknown): PushEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'topic' in parsed &&
      typeof (parsed as { topic: unknown }).topic === 'string'
    ) {
      return { topic: (parsed as { topic: string }).topic, payload: (parsed as PushEvent).payload };
    }
  } catch {
    // A frame that is not JSON is not something this client can act on.
  }
  return null;
}

export interface EventChannelOptions {
  /** Defaults to `/api/events` on the current origin. */
  url?: string;
  /** Defaults to the token the server injected into the page. */
  token?: string | null;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  /** Injectable for tests. */
  setTimeoutImpl?: (fn: () => void, ms: number) => number;
  clearTimeoutImpl?: (handle: number) => void;
  random?: () => number;
  /** Called with each event before it reaches the bus. For tests and
   *  diagnostics; the bus is the real destination. */
  onEvent?: (event: PushEvent) => void;
}

/**
 * Opens the channel and keeps it open.
 *
 * @returns A disposer that stops reconnecting and closes the socket.
 * Calling it is how a shell shuts the channel down; without it a
 * reconnect timer outlives the page's interest in the connection.
 */
export function connectEventChannel(options: EventChannelOptions = {}): () => void {
  const Impl = options.WebSocketImpl ?? WebSocket;
  const setTimer = options.setTimeoutImpl ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutImpl ?? ((handle) => window.clearTimeout(handle));
  const random = options.random ?? Math.random;
  const token = options.token === undefined ? apiTokenForUpgrade() : options.token;

  let socket: WebSocket | null = null;
  let timer: number | null = null;
  let attempt = 0;
  let stopped = false;

  const url =
    options.url ??
    `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/events`;

  function open(): void {
    if (stopped) return;
    // No token means the page was served without one. Connecting would
    // be refused on every attempt; not connecting at least fails
    // quietly and leaves the HTTP routes to report the real problem.
    if (token === null) return;

    const next = new Impl(url, [`${BEARER_PREFIX}${token}`]);
    socket = next;

    next.onopen = () => {
      // Reset only once a connection actually succeeds. Resetting on
      // the attempt would make a server that accepts and immediately
      // drops into a tight reconnect loop.
      attempt = 0;
    };

    next.onmessage = (event: MessageEvent) => {
      const parsed = parsePushEvent(event.data);
      if (parsed === null) return;
      options.onEvent?.(parsed);
      eventBus.emit(parsed.topic, parsed.payload);
    };

    next.onclose = (event: CloseEvent) => {
      socket = null;
      if (stopped || FATAL_CLOSE_CODES.has(event.code)) return;
      schedule();
    };

    next.onerror = () => {
      // `onclose` always follows, and that is where the retry lives —
      // scheduling here too would double every backoff.
    };
  }

  function schedule(): void {
    if (stopped || timer !== null) return;
    const delay = retryDelay(attempt, random);
    attempt += 1;
    timer = setTimer(() => {
      timer = null;
      open();
    }, delay);
  }

  open();

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    socket?.close();
    socket = null;
  };
}
