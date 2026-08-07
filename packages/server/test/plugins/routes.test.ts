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
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthedApp } from '../helpers/authed.js';
import { type App } from '../../src/app.js';
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

    // A second bundle, for the grant/revoke assertions.
    //
    // They used to run against `hello`, which declared `db.schema.list`
    // while targeting `plugin-minimal` — a world that imports nothing
    // but `host`. The host now refuses a capability the declared world
    // cannot reach, and `hello`'s manifest was corrected to request
    // nothing, so there is no longer anything to grant it.
    //
    // Only a UI-only plugin can hold a capability at present: the
    // higher worlds are declared in the WIT but none of their imports
    // has a host implementation, so a *wasm* plugin that declared one
    // would be refused at load. That is a real limitation of this
    // build, not of this test.
    mkdirSync(join(pluginsDir, 'grantable'), { recursive: true });
    writeFileSync(
      join(pluginsDir, 'grantable', 'manifest.toml'),
      `
[plugin]
id = "dev.plamenix.grantable"
name = "Grantable"
version = "1.0.0"
plamenix_min_version = ">=1.0.0-beta"
plugin_api = "1.0"
world = "plamenix:plugin@1.0.0/plugin-integrated"

[entry_points]
ui = "ui.mjs"

[permissions]
required = ["db.schema.list"]
optional = ["clipboard.read"]
`,
    );
    writeFileSync(join(pluginsDir, 'grantable', 'ui.mjs'), 'export default {};\n');

    process.env.PLUGINS_PATH = pluginsDir;
    process.env.PLUGIN_DATA_ROOT = join(workDir, 'plugin-data');
    process.env.PLUGIN_GRANTS_PATH = join(workDir, 'plugin-grants.sqlite');
    process.env.PROFILES_PATH = join(workDir, 'profiles.json');
    process.env.HISTORY_PATH = join(workDir, 'history.sqlite');
    process.env.LOG_LEVEL = 'error';
    process.env.NODE_ENV = 'test';

    app = await buildAuthedApp();
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
    // Two bundles are staged: the wasm `hello` and the UI-only
    // `grantable` the permission tests need.
    const hello = body.plugins.find((p) => p.id === 'dev.plamenix.hello');
    expect(hello).toBeDefined();
    expect(hello?.activation.status).toBe('ok');
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
      url: '/api/plugins/dev.plamenix.grantable/grant',
      payload: { permission: 'db.schema.list' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{ id: string; grantedPermissions: string[] }>;
    };
    const granted = body.plugins.find((p) => p.id === 'dev.plamenix.grantable');
    expect(granted?.grantedPermissions).toContain('db.schema.list');
  });

  it('refuses a grant whose capability string fails the grammar check', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.grantable/grant',
      payload: { permission: 'this.is.not.a.real.capability' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'grant_failed' });
  });

  it('revokes a granted permission', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.grantable/revoke',
      payload: { permission: 'db.schema.list' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{ id: string; grantedPermissions: string[] }>;
    };
    const granted = body.plugins.find((p) => p.id === 'dev.plamenix.grantable');
    expect(granted?.grantedPermissions).not.toContain('db.schema.list');
  });

  it('refuses lifecycle actions on an unknown plugin id', async () => {
    // 404 rather than a generic failure: the route now looks the
    // plugin up to read its declared capabilities, so "no such plugin"
    // is distinguishable from "that grant was rejected".
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/no.such.plugin/grant',
      payload: { permission: 'db.schema.list' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'unknown_plugin' });
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
    // Against `grantable` rather than `hello`: only a UI-only plugin
    // can currently hold a capability at all, because the worlds that
    // expose the imports behind one are not linkable in this build.
    await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.grantable/grant',
      payload: { permission: 'clipboard.read' },
    });

    const reload = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.grantable/reload',
    });
    expect(reload.statusCode).toBe(200);
    const body = reload.json() as {
      activated: { id: string; activation: { status: string }; grantedPermissions: string[] };
    };
    expect(body.activated.id).toBe('dev.plamenix.grantable');
    expect(body.activated.activation.status).toBe('ok');
    // Grant replayed by the reload route's own bootstrap-style loop.
    expect(body.activated.grantedPermissions).toContain('clipboard.read');
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
