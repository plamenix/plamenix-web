import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadEnv } from '../src/env.js';

describe('plamenix-web server', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildApp(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'error' } as NodeJS.ProcessEnv));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds on /api/ping', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pong: string };
    expect(body.pong).toBe('plamenix-web alive');
  });

  it('rejects malformed /api/connect bodies', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/connect', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
