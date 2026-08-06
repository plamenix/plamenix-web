/**
 * Integration coverage for the plugin lifecycle routes.
 *
 * Boots a fresh Fastify app against a temp plugin bundle dir
 * (containing the desktop edition's `hello` plugin), exercises every
 * route, and asserts the napi-bound runtime + SQLite-backed grant
 * store agree.
 *
 * **Process-isolation caveat documented in I1.6**: the napi binding's
 * plugin registry is process-wide (a single shared `OnceLock` /
 * `Mutex<HashMap>` per Node process). Vitest runs each test file in
 * its own worker fork (the v4 default), so this file gets a clean
 * binding — but within the file the binding state is shared across
 * `it` blocks. The tests are therefore ordered + structured as one
 * scenario rather than independent cases. True restart-with-fresh-
 * binding semantics are exercised by `grant-store.test.ts`, which
 * touches only the SQLite layer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';

const HELLO_BUNDLE_SRC =
  '/Users/zlatan/Projects/personal/firebird/plamenix-desktop/resources/plugins/hello';

describe('plugin lifecycle routes', () => {
  let workDir: string;
  let app: App;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'plugin-routes-test-'));

    // Stage a plugins directory: copy the desktop edition's hello
    // bundle so the bootstrap discovers + activates it on app boot.
    const pluginsDir = join(workDir, 'plugins');
    cpSync(HELLO_BUNDLE_SRC, join(pluginsDir, 'hello'), { recursive: true });

    process.env.PLUGINS_PATH = pluginsDir;
    process.env.PLUGIN_DATA_ROOT = join(workDir, 'plugin-data');
    process.env.PLUGIN_GRANTS_PATH = join(workDir, 'plugin-grants.sqlite');
    process.env.PROFILES_PATH = join(workDir, 'profiles.json');
    process.env.HISTORY_PATH = join(workDir, 'history.sqlite');
    process.env.LOG_LEVEL = 'error';
    process.env.NODE_ENV = 'test';

    app = await buildApp(loadEnv());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('bootstraps the hello plugin and surfaces it via GET /api/plugins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plugins: Array<{ id: string; activation: { status: string } }> };
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0]?.id).toBe('dev.plamenix.hello');
    expect(body.plugins[0]?.activation.status).toBe('ok');
  });

  it('rejects POST /api/plugins/load with a malformed body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/load',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('grants a permission and shows it under grantedPermissions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.hello/grant',
      payload: { permission: 'db.schema.list' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{ id: string; grantedPermissions: string[] }>;
    };
    const hello = body.plugins.find((p) => p.id === 'dev.plamenix.hello');
    expect(hello?.grantedPermissions).toContain('db.schema.list');
  });

  it('refuses a grant whose capability string fails the grammar check', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.hello/grant',
      payload: { permission: 'this.is.not.a.real.capability' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'grant_failed' });
  });

  it('revokes a granted permission', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.hello/revoke',
      payload: { permission: 'db.schema.list' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{ id: string; grantedPermissions: string[] }>;
    };
    const hello = body.plugins.find((p) => p.id === 'dev.plamenix.hello');
    expect(hello?.grantedPermissions).not.toContain('db.schema.list');
  });

  it('refuses lifecycle actions on an unknown plugin id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/no.such.plugin/grant',
      payload: { permission: 'db.schema.list' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'grant_failed' });
  });

  it('GET /api/plugins/:id/ui.mjs serves the bundle when present', async () => {
    // Hello plugin has no ui.mjs in its bundle — stage one so the
    // route has a real file to serve.
    const bundleDir = join(workDir, 'plugins', 'hello');
    const uiPath = join(bundleDir, 'ui.mjs');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(uiPath, "export default { contributions: {} };\n");

    const res = await app.inject({
      method: 'GET',
      url: '/api/plugins/dev.plamenix.hello/ui.mjs',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toContain('export default');
  });

  it('GET /api/plugins/:id/ui.mjs returns 404 when the bundle has no ui.mjs', async () => {
    const bundleDir = join(workDir, 'plugins', 'hello');
    const uiPath = join(bundleDir, 'ui.mjs');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(uiPath);

    const res = await app.inject({
      method: 'GET',
      url: '/api/plugins/dev.plamenix.hello/ui.mjs',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'ui_bundle_missing' });
  });

  it('GET /api/plugins/:id/ui.mjs returns 404 for an unknown plugin id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/plugins/no.such.plugin/ui.mjs',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'plugin_not_loaded' });
  });

  it('GET /api/plugins/:id/ui.mjs rejects unsafe plugin ids', async () => {
    // Path-traversal attempt — Fastify routes will URL-decode but the
    // assertSafePluginId check refuses on `..` before any fs access.
    const res = await app.inject({
      method: 'GET',
      url: '/api/plugins/%2E%2E/ui.mjs',
    });
    // Fastify may collapse this at route-match time; either 400 or
    // 404 is acceptable so long as no fs traversal occurred.
    expect([400, 404]).toContain(res.statusCode);
  });

  it('POST /api/plugins/:id/reload reactivates without a host restart and replays persisted grants', async () => {
    // Grant a permission so the reload's replay path can be verified.
    await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.hello/grant',
      payload: { permission: 'os.notify' },
    });

    const reload = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.hello/reload',
    });
    expect(reload.statusCode).toBe(200);
    const body = reload.json() as {
      activated: { id: string; activation: { status: string }; grantedPermissions: string[] };
    };
    expect(body.activated.id).toBe('dev.plamenix.hello');
    expect(body.activated.activation.status).toBe('ok');
    // Grant replayed by the reload route's own bootstrap-style loop.
    expect(body.activated.grantedPermissions).toContain('os.notify');
  });

  it('POST /api/plugins/:id/reload returns 400 for an unknown plugin id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/no.such.plugin/reload',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'reload_failed' });
  });

  it('deactivates the plugin and removes it from the active list', async () => {
    const deactivate = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.hello/deactivate',
    });
    expect(deactivate.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/plugins' });
    const body = list.json() as { plugins: Array<{ id: string }> };
    expect(body.plugins.find((p) => p.id === 'dev.plamenix.hello')).toBeUndefined();
  });
});
