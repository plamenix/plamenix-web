import type { Transport } from '@plamenix/ui';
import { TransportError } from '@plamenix/ui';

// Maps `Transport.invoke(command, args)` onto `POST /api/<command>` with a
// JSON body. Commands without args use GET. Both editions stay
// transport-agnostic at the React layer.
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
      throw new TransportError(
        `HTTP transport got ${response.status} for '${command}'`,
        await response.text().catch(() => undefined),
      );
    }

    return (await response.json()) as T;
  },
};
