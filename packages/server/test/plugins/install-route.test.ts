/**
 * I7.8 — install-route contract tests.
 *
 * Exercises the request validation + 501 stub path. Real install
 * integration tests land alongside I7.10's `.plx` extractor.
 *
 * Process isolation: this file does NOT activate plugins from disk;
 * the napi binding state isn't perturbed, so the install-route
 * tests can run alongside the activate / grant / revoke tests in a
 * single Vitest worker without cross-test interference.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';

describe('POST /api/plugins/install (I7.8 stub)', () => {
  let workDir: string;
  let app: App;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'install-route-test-'));
    const pluginsDir = join(workDir, 'plugins');
    const pluginDataRoot = join(workDir, 'plugin-data');
    const grantsPath = join(workDir, 'grants.sqlite');
    const profilesPath = join(workDir, 'profiles.json');
    const historyPath = join(workDir, 'history.sqlite');
    const env = loadEnv({
      PLUGINS_PATH: pluginsDir,
      PLUGIN_DATA_ROOT: pluginDataRoot,
      PLUGIN_GRANTS_PATH: grantsPath,
      PROFILES_PATH: profilesPath,
      HISTORY_PATH: historyPath,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
    });
    app = await buildApp(env);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns 400 when body is missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ error: 'invalid_body' });
  });

  it('returns 400 when bundleBase64 is empty string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: { bundleBase64: '', grantedOptional: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ error: 'invalid_body' });
  });

  it('returns 400 when grantedOptional contains an empty entry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: {
        bundleBase64: Buffer.from('test').toString('base64'),
        grantedOptional: [''],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when bundleBase64 decodes to empty bytes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: {
        bundleBase64: '====',
        grantedOptional: [],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toMatchObject({ error: 'empty_bundle' });
  });

  it('returns 413 when decoded bundle exceeds 32 MiB cap', async () => {
    // 33 MiB of zeros is well over the 32 MiB ceiling.
    const oversized = Buffer.alloc(33 * 1024 * 1024).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: {
        bundleBase64: oversized,
        grantedOptional: [],
      },
    });
    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('bundle_too_large');
    expect(body.limit).toBe(32 * 1024 * 1024);
    expect(body.actual).toBeGreaterThan(body.limit);
  });

  it('returns 501 with pending: i7.10_plx_extractor on valid request', async () => {
    const bytes = Buffer.from('fake-plx-bytes', 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: {
        bundleBase64: bytes.toString('base64'),
        grantedOptional: ['network.fetch', 'fs.read'],
      },
    });
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.payload);
    expect(body).toMatchObject({
      error: 'not_implemented',
      pending: 'i7.10_plx_extractor',
      accepted: {
        bytes: bytes.length,
        grantedOptional: ['network.fetch', 'fs.read'],
      },
    });
  });

  it('defaults grantedOptional to empty array when omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      payload: {
        bundleBase64: Buffer.from('x').toString('base64'),
      },
    });
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.payload);
    expect(body.accepted.grantedOptional).toEqual([]);
  });
});
