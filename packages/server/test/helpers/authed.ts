/**
 * Test app builder that carries a token.
 *
 * Every `/api/*` route now requires one. Rather than adding a header to
 * sixty-odd `inject` calls — where a missed one would look like a test
 * failure rather than a missing header — this wraps `inject` so the
 * existing calls are unchanged and authentication is the default.
 *
 * That does mean these tests no longer exercise the unauthenticated
 * path. `test/security.test.ts` does that deliberately, with a raw app.
 */

import { buildApp, type App } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';

/** Fixed so failures are reproducible. Long enough to pass the
 *  minimum-length check that refuses a token worth guessing. */
export const TEST_TOKEN = 'test-token-please-ignore-0123456789';

/** A Host header the security gate accepts. */
export const TEST_HOST = 'localhost:3000';

/**
 * Builds the app with a known token and wraps `inject` so requests are
 * authenticated and come from an allowed host by default.
 *
 * Per-call `headers` still win, so a test can deliberately send a bad
 * token or a foreign Host.
 */
export async function buildAuthedApp(overrides: NodeJS.ProcessEnv = {}): Promise<App> {
  const app = await buildApp(
    loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      AUTH_TOKEN: TEST_TOKEN,
      ...process.env,
      ...overrides,
    } as NodeJS.ProcessEnv),
  );

  const original = app.inject.bind(app);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).inject = (opts: any) =>
    original({
      ...opts,
      headers: {
        host: TEST_HOST,
        authorization: `Bearer ${TEST_TOKEN}`,
        ...(opts?.headers ?? {}),
      },
    });

  return app;
}
