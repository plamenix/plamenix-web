/**
 * A request must never choose which shared library the server loads.
 *
 * `POST /api/connect` and the profile routes used to accept an
 * `fbclientPath`, and the driver's `resolve_fbclient_path` gives an
 * explicit config value precedence over the server's own environment
 * variable. So the body of an unauthenticated request could name any
 * file on the server's filesystem and have the process `dlopen` it —
 * on a server that had no authentication on any route and, until the
 * same commit, bound to `0.0.0.0` by default.
 *
 * These tests are the reason it stays fixed. The field is easy to add
 * back: it is one line in a zod schema, it looks like every other
 * optional passthrough around it, and nothing about restoring it would
 * fail a test that did not exist.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthedApp } from './helpers/authed.js';
import { type App } from '../src/app.js';
import { loadEnv } from '../src/env.js';

describe('no request-controlled library loading', () => {
  let workDir: string;
  let profilesPath: string;
  let app: App;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'no-dlopen-test-'));
    profilesPath = join(workDir, 'profiles.json');

    process.env.PROFILES_PATH = profilesPath;
    process.env.HISTORY_PATH = join(workDir, 'history.sqlite');
    process.env.PLUGINS_PATH = join(workDir, 'plugins');
    process.env.PLUGIN_DATA_ROOT = join(workDir, 'plugin-data');
    process.env.PLUGIN_GRANTS_PATH = join(workDir, 'plugin-grants.sqlite');
    process.env.LOG_LEVEL = 'error';
    process.env.NODE_ENV = 'test';
    delete process.env.FBCLIENT_PATH;

    app = await buildAuthedApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('binds to loopback unless told otherwise', () => {
    // Not cosmetic. Every route is reachable by anyone who can open the
    // port, with no authentication, and they get whatever the
    // configured Firebird user has. Defaulting to 0.0.0.0 made that a
    // network service by accident rather than by decision.
    const env = loadEnv({ ...process.env, HOST: undefined } as NodeJS.ProcessEnv);
    expect(env.HOST).toBe('127.0.0.1');
  });

  it('rejects fbclientPath in a connect body', () => {
    // zod strips unknown keys rather than erroring, so the assertion
    // that matters is that it does not reach the config — see the next
    // test. This one pins that the field is not in the schema at all.
    const source = readFileSync(
      new URL('../src/routes/connect.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/fbclientPath:\s*z\./);
  });

  it('does not pass a request-supplied library path to the driver', async () => {
    // The end-to-end shape. The connect will fail — there is no
    // Firebird at this host — but it must fail for the right reason,
    // and never having tried to load the named file.
    const res = await app.inject({
      method: 'POST',
      url: '/api/connect',
      payload: {
        host: '127.0.0.1',
        port: 1,
        database: '/nonexistent.fdb',
        user: 'SYSDBA',
        password: 'masterkey',
        fbclientPath: '/tmp/evil.dylib',
      },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json() as { message?: string };
    expect(body.message ?? '').not.toContain('/tmp/evil.dylib');
  });

  it('never persists a library path a request supplied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        name: 'Planted',
        host: 'localhost',
        port: 3050,
        database: '/var/lib/firebird/data/test.fdb',
        user: 'SYSDBA',
        fbclientPath: '/tmp/evil.dylib',
      },
    });
    expect([200, 201]).toContain(res.statusCode);

    // Read the file rather than the API response: the hole was a value
    // reaching disk, where a later connect would pick it up.
    const stored = readFileSync(profilesPath, 'utf8');
    expect(stored).not.toContain('/tmp/evil.dylib');
  });

  it('ignores a library path planted in the profiles file by an older build', async () => {
    // Removing the write path is not enough on its own. A file written
    // before this change can still carry a value, and honouring it
    // would leave the original hole open to anyone who already planted
    // one.
    const current = JSON.parse(readFileSync(profilesPath, 'utf8')) as {
      profiles?: Array<Record<string, unknown>>;
    };
    const list = Array.isArray(current) ? current : (current.profiles ?? []);
    expect(list.length).toBeGreaterThan(0);
    list[0]!.fbclientPath = '/tmp/planted.dylib';
    writeFileSync(profilesPath, JSON.stringify(current, null, 2));

    const source = readFileSync(
      new URL('../src/routes/profiles.ts', import.meta.url),
      'utf8',
    );
    // The connect path must read the operator's setting, never the
    // stored field.
    expect(source).not.toMatch(/profile\.fbclientPath/);
    expect(source).toMatch(/env\.FBCLIENT_PATH/);
  });
});
