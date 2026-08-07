/**
 * Does anything actually reach the audit log?
 *
 * The gate calls an audit sink and the sink is fire-and-forget, which
 * means a broken write is silent by design — the alternative turns a
 * full disk into a denial of service. Silent-by-design needs a test, or
 * the log becomes a thing everyone believes in and nobody has read.
 *
 * These go through the real store, in Firebird Embedded, because the
 * point is that entries survive the process. A mocked sink would only
 * prove the gate calls a function.
 *
 * Needs the bundled Firebird; skipped without it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as native from '@plamenix/native';
import { buildApp, type App } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const TOKEN = 'audit-test-token-0123456789abc';
const HOST = { host: 'localhost:3000' };

/** The full Firebird install both editions ship. */
const FBCLIENT = resolve(
  import.meta.dirname,
  '../../../../plamenix-desktop/resources/fbclient/v50/Resources/lib/libfbclient.dylib',
);

/** Waits for the fire-and-forget writes to land. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
}

async function entries(): Promise<string> {
  return JSON.stringify(await native.auditRecent(200));
}

describe.skipIf(!existsSync(FBCLIENT))('audit log', () => {
  let workDir: string;
  let app: App;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'audit-test-'));
    app = await buildApp(
      loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        AUTH_TOKENS: `alice:${TOKEN}`,
        FBCLIENT_PATH: FBCLIENT,
        METADATA_PATH: join(workDir, 'meta.fdb'),
        PROFILES_PATH: join(workDir, 'profiles.json'),
        HISTORY_PATH: join(workDir, 'history.sqlite'),
        PLUGINS_PATH: join(workDir, 'plugins'),
        PLUGIN_DATA_ROOT: join(workDir, 'plugin-data'),
        PLUGIN_GRANTS_PATH: join(workDir, 'grants.sqlite'),
      } as NodeJS.ProcessEnv),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('records a rebinding attempt, with the domain that tried it', async () => {
    // One of the few events here that means someone is actively trying
    // something rather than misconfiguring something.
    await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { host: 'evil.example.com' },
    });
    await settle();

    const log = await entries();
    expect(log).toContain('request.host_refused');
    expect(log).toContain('evil.example.com');
  });

  it('records a refused authentication', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: { ...HOST, authorization: 'Bearer wrong-token-0123456789' },
    });
    await settle();

    expect(await entries()).toContain('auth.refused');
  });

  it('names the operator on an authenticated write', async () => {
    // The whole reason tokens are named. "Someone deleted a profile" is
    // not an answer anyone can act on.
    await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: { ...HOST, authorization: `Bearer ${TOKEN}` },
      payload: {
        name: 'Audited',
        host: 'localhost',
        port: 3050,
        database: '/var/lib/firebird/data/test.fdb',
        user: 'SYSDBA',
      },
    });
    await settle();

    const log = await entries();
    expect(log).toContain('alice');
    expect(log).toContain('http.post');
  });

  it('does not record a read', async () => {
    // Every GET would drown the log in noise and make the writes harder
    // to find, which is the opposite of what it is for.
    await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: { ...HOST, authorization: `Bearer ${TOKEN}` },
    });
    await settle();

    expect(await entries()).not.toContain('http.get');
  });
});
