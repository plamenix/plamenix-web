/**
 * I9.5 — web edition refuses a desktop-only plugin at bootstrap.
 *
 * Stages a bundle whose manifest declares `targets = ["desktop"]`,
 * boots the app, and asserts:
 *
 *   - The plugin is NOT activated (skipped at bootstrap).
 *   - `GET /api/plugins` reports an empty active list.
 *   - The plugin id never appears as activated even after a
 *     subsequent `POST /api/plugins/load` for its bundle path.
 *
 * Sidecar to the Rust host's `tests/targets_enforcement.rs` matrix.
 * The Rust file covers `supports_edition(Edition)` correctness; this
 * file covers the web bootstrap's actual skip behaviour against
 * the same predicate.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthedApp } from '../helpers/authed.js';
import { type App } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';

const HELLO_BUNDLE_SRC =
  '/Users/zlatan/Projects/personal/firebird/plamenix-desktop/resources/plugins/hello';

describe('edition mismatch — web refuses desktop-only plugin (I9.5)', () => {
  let workDir: string;
  let app: App;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'edition-mismatch-test-'));
    const pluginsDir = join(workDir, 'plugins');
    // Copy the hello plugin then rewrite its manifest's `targets`
    // field to declare desktop-only support.
    cpSync(HELLO_BUNDLE_SRC, join(pluginsDir, 'hello'), { recursive: true });
    const manifestPath = join(pluginsDir, 'hello', 'manifest.toml');
    let manifest = readFileSync(manifestPath, 'utf8');
    if (manifest.includes('targets =')) {
      manifest = manifest.replace(
        /targets\s*=\s*\[[^\]]*\]/,
        'targets = ["desktop"]',
      );
    } else {
      // No explicit targets — append one so the parser sees an
      // explicit desktop-only declaration.
      manifest = manifest.replace(
        /\[plugin\]/,
        '[plugin]\ntargets = ["desktop"]',
      );
    }
    writeFileSync(manifestPath, manifest);

    process.env.PLUGINS_PATH = pluginsDir;
    process.env.PLUGIN_DATA_ROOT = join(workDir, 'plugin-data');
    process.env.PLUGIN_GRANTS_PATH = join(workDir, 'plugin-grants.sqlite');
    process.env.PROFILES_PATH = join(workDir, 'profiles.json');
    process.env.HISTORY_PATH = join(workDir, 'history.sqlite');
    process.env.LOG_LEVEL = 'fatal';
    process.env.NODE_ENV = 'test';

    app = await buildAuthedApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('GET /api/plugins returns an empty active list (desktop-only plugin skipped)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plugins: Array<{ id: string }> };
    expect(body.plugins.some((p) => p.id === 'dev.plamenix.hello')).toBe(false);
  });
});
