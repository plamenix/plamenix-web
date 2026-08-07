/**
 * End-to-end smoke for the web edition's full plugin loop:
 *
 *   bundle on disk → POST bootstrap → GET /api/plugins/:id/ui.mjs
 *     → SDK loader → registry → assertion
 *
 * Server-side half of Section I2.8's cross-edition smoke. The
 * plamenix-ui side (`plugin-react/e2e.test.tsx`) covers the
 * client-side chain ending in real React DOM; this file covers the
 * server side ending at the registry. Together they prove the SDK
 * contract every host wrapper will compose against.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthedApp } from '../helpers/authed.js';
import { type App } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';

const HELLO_BUNDLE_SRC =
  '/Users/zlatan/Projects/personal/firebird/plamenix-desktop/resources/plugins/hello';

/** Minimal plugin bundle text — exports the contribution shape that
 *  the SDK's `loadPluginUiFromBytes` would dynamic-import. Plain data
 *  payload, no React in scope, no externalised dep wrinkles. */
const UI_BUNDLE = `
export default {
  contributions: {
    sidebar_panels: [
      {
        id: 'e2e-panel',
        priority: 5,
        payload: { label: 'E2E PANEL LABEL', icon: 'sparkles' }
      }
    ]
  }
};
`;

describe('plugin e2e (web edition full loop)', () => {
  let workDir: string;
  let app: App;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'plugin-e2e-test-'));

    // Stage the hello bundle + a real ui.mjs alongside it so the
    // `GET /api/plugins/:id/ui.mjs` endpoint has something to serve.
    const pluginsDir = join(workDir, 'plugins');
    cpSync(HELLO_BUNDLE_SRC, join(pluginsDir, 'hello'), { recursive: true });
    writeFileSync(join(pluginsDir, 'hello', 'ui.mjs'), UI_BUNDLE);

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

  it('serves the staged ui.mjs and SDK can load it from the fetched bytes', async () => {
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/plugins/dev.plamenix.hello/ui.mjs',
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).toContain('export default');
    expect(fetched.body).toContain('E2E PANEL LABEL');

    // Feed the fetched bytes through the SDK's loader and assert the
    // registry sees the plugin's contribution. This is the same call
    // chain the web client will use in production once the host
    // wrapper lands in I4: fetch → bytes → loadPluginUiFromBytes →
    // registry → <PluginOutlet>.
    const { loadPluginUiFromBytes, registry, createPluginAPI } = await import(
      '../../../../../plamenix-ui/dist/plugin-react.mjs'
    );

    const api = createPluginAPI('dev.plamenix.hello', {
      log: () => {},
      notify: () => {},
      invokeCommand: async () => null,
      getSetting: async () => null,
      setSetting: async () => {},
      subscribe: () => ({ dispose: () => {} }),
    });

    await loadPluginUiFromBytes('dev.plamenix.hello', fetched.body, api);

    const contributions = registry.getContributions('sidebar_panels');
    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.pluginId).toBe('dev.plamenix.hello');
    expect(contributions[0]?.contribution.id).toBe('e2e-panel');
    expect(
      (contributions[0]?.contribution.payload as { label?: string }).label,
    ).toBe('E2E PANEL LABEL');

    // Hand back to the registry so the suite leaves the singleton
    // clean for the next test file.
    registry.__reset();
  });

  it('reloads the plugin after editing its ui.mjs without a host restart', async () => {
    const newBundle = UI_BUNDLE.replace('E2E PANEL LABEL', 'EDITED LABEL');
    writeFileSync(join(workDir, 'plugins', 'hello', 'ui.mjs'), newBundle);

    // The reload route exercises the napi `reloadPlugin` path; the
    // ui.mjs route then serves the freshly written file. Cache header
    // says 5min so we add a query param to bust like a real client.
    const reload = await app.inject({
      method: 'POST',
      url: '/api/plugins/dev.plamenix.hello/reload',
    });
    expect(reload.statusCode).toBe(200);

    const refetched = await app.inject({
      method: 'GET',
      url: `/api/plugins/dev.plamenix.hello/ui.mjs?v=${Date.now()}`,
    });
    expect(refetched.body).toContain('EDITED LABEL');
    expect(refetched.body).not.toContain('E2E PANEL LABEL');
  });
});
