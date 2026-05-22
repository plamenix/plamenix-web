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
export const fetchTransport: Transport = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const url = `/api/${command}`;
    const init: RequestInit =
      args === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
