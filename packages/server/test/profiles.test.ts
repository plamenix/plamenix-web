import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuthedApp } from './helpers/authed.js';
import { type App } from '../src/app.js';
import { loadEnv } from '../src/env.js';

describe('profile routes', () => {
  let app: App;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plamenix-profiles-'));
    app = await buildAuthedApp({
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        PROFILES_PATH: join(tmpDir, 'profiles.json'),
      });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Each test starts with an empty profile list; the route DELETE
    // path is idempotent so listing + deleting is enough.
    const existing = await app.inject({ method: 'GET', url: '/api/profiles' });
    const body = existing.json() as { profiles: { id: string }[] };
    for (const profile of body.profiles) {
      await app.inject({ method: 'DELETE', url: `/api/profiles/${profile.id}` });
    }
  });

  it('lists empty on a fresh store', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profiles: [] });
  });

  it('saves a profile and surfaces it on list', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        name: 'Local Dev',
        host: '127.0.0.1',
        port: 3050,
        database: '/var/lib/firebird/data/test.fdb',
        user: 'SYSDBA',
      },
    });
    expect(saved.statusCode).toBe(200);
    const { profile } = saved.json() as { profile: { id: string; name: string } };
    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(profile.name).toBe('Local Dev');

    const listed = await app.inject({ method: 'GET', url: '/api/profiles' });
    const body = listed.json() as { profiles: { id: string }[] };
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]?.id).toBe(profile.id);
  });

  it('updates an existing profile when id is supplied', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        name: 'First',
        host: '127.0.0.1',
        port: 3050,
        database: '/data/a.fdb',
        user: 'SYSDBA',
      },
    });
    const { profile } = created.json() as { profile: { id: string } };

    const updated = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        id: profile.id,
        name: 'Renamed',
        host: '127.0.0.1',
        port: 3050,
        database: '/data/a.fdb',
        user: 'SYSDBA',
      },
    });
    expect(updated.statusCode).toBe(200);
    const { profile: after } = updated.json() as { profile: { id: string; name: string } };
    expect(after.id).toBe(profile.id);
    expect(after.name).toBe('Renamed');

    const listed = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect((listed.json() as { profiles: unknown[] }).profiles).toHaveLength(1);
  });

  it('rejects malformed POST /api/profiles bodies', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/profiles', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when connecting via an unknown profile id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profiles/00000000-0000-0000-0000-000000000000/connect',
      payload: { password: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes idempotently', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        name: 'Doomed',
        host: '127.0.0.1',
        port: 3050,
        database: '/data/z.fdb',
        user: 'SYSDBA',
      },
    });
    const { profile } = created.json() as { profile: { id: string } };

    const first = await app.inject({ method: 'DELETE', url: `/api/profiles/${profile.id}` });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({ method: 'DELETE', url: `/api/profiles/${profile.id}` });
    expect(second.statusCode).toBe(204);
  });
});
