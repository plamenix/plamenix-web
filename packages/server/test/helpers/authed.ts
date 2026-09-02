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

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type App } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';

/** The full Firebird install both editions ship. */
export const FBCLIENT = resolve(
  import.meta.dirname,
  '../../../../../plamenix-desktop/resources/fbclient/v50/Resources/lib/libfbclient.dylib',
);

/** Is the metadata database reachable in this checkout? */
export const HAS_FIREBIRD = existsSync(FBCLIENT);

/**
 * One metadata database per test process.
 *
 * Firebird's embedded engine takes the file exclusively and the napi
 * binding opens it once per process, so a shared default path would
 * have test files fighting over one file and losing to whichever got
 * there first. Vitest isolates each test file into its own process,
 * which makes one temp file per process exactly one per test file.
 */
const META_DIR = mkdtempSync(join(tmpdir(), 'plamenix-server-test-'));

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
      METADATA_PATH: join(META_DIR, 'meta.fdb'),
      ...(HAS_FIREBIRD ? { FBCLIENT_PATH: FBCLIENT } : {}),
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
