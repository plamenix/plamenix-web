import type { Transport } from '@plamenix/ui';
import { TransportError } from '@plamenix/ui';

/**
 * HTTP-backed {@link Transport} implementation.
 *
 * Maps `invoke(command, args)` onto `POST /api/<command>` with a JSON
 * body. Commands without args use `GET` so simple read endpoints can
 * stay cacheable.
 *
 * On a non-2xx response, the body is parsed:
 *   - If it is JSON and matches `{ error, message }` (the server's
 *     standard error envelope), the rejection message is set to the
 *     server's `message` and the `cause` carries the typed `error` tag.
 *   - Otherwise the raw text body is attached as `cause`.
 *
 * On a network failure (DNS, offline, CORS), the rejection carries the
 * underlying exception as `cause`.
 */
/**
 * The API token the server injected into this document.
 *
 * Read once. A missing or unreplaced placeholder yields `null`, and
 * requests go out unauthenticated so the failure is a clear 401 rather
 * than a header containing the literal placeholder.
 */
function apiToken(): string | null {
  const meta = document.querySelector('meta[name="plamenix-api-token"]');
  const value = meta?.getAttribute('content') ?? '';
  if (value === '' || value.startsWith('__')) return null;
  return value;
}

const API_TOKEN = apiToken();

/**
 * Headers every API request must carry.
 *
 * Exported because several call sites reach `/api/*` with raw `fetch`
 * rather than through {@link fetchTransport}. Each of those would 401
 * without this, and the failure would look like a broken endpoint
 * rather than a missing header — so there is one source for it.
 */
export function authHeaders(): Record<string, string> {
  return API_TOKEN === null ? {} : { Authorization: `Bearer ${API_TOKEN}` };
}

/**
 * The raw token, for the one caller that cannot use a header.
 *
 * The browser `WebSocket` constructor takes a URL and a subprotocol
 * list and nothing else, so the push channel has to carry the token as
 * a subprotocol. Exported narrowly rather than making `API_TOKEN`
 * public: there is exactly one legitimate reason to want the bare
 * value, and everything else should go through {@link authHeaders}.
 */
export function apiTokenForUpgrade(): string | null {
  return API_TOKEN;
}

export const fetchTransport: Transport = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const url = `/api/${command}`;
    const init: RequestInit =
      args === undefined
        ? { method: 'GET', headers: authHeaders() }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(args),
          };

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      throw new TransportError(`HTTP transport failed for '${command}'`, cause);
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      const message =
        detail.serverMessage ?? `HTTP transport got ${response.status} for '${command}'`;
      throw new TransportError(message, detail.cause);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  },
};

interface ErrorDetail {
  /** Server-supplied `message` field when present. Used as the
   *  TransportError message so callers see a useful summary by default. */
  serverMessage?: string;
  /** Raw error envelope (object) or text body, attached as `cause` for
   *  consumers that want machine-readable error tags. */
  cause: unknown;
}

async function readErrorBody(response: Response): Promise<ErrorDetail> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const body = (await response.json()) as unknown;
      if (
        body !== null &&
        typeof body === 'object' &&
        'message' in body &&
        typeof (body as { message: unknown }).message === 'string'
      ) {
        return {
          serverMessage: (body as { message: string }).message,
          cause: body,
        };
      }
      return { cause: body };
    } catch {
      // fall through to text
    }
  }
  const text = await response.text().catch(() => undefined);
  return { cause: text };
}
