/**
 * The session an event is delivered under.
 *
 * A plugin granted `db.read.any` that subscribes to `query/executed`
 * needs a session to act on — the host answers "the session I called
 * you for", and without one every `db` import refuses. The desktop
 * shell has always set this; this edition did not, so the install
 * dialog promised database access the plugin was then denied exactly
 * when it tried to use it.
 *
 * The value reaches plugins as the session their queries run against,
 * which is why it is checked against the live session store rather than
 * trusted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuthedApp } from '../helpers/authed.js';
import type { App } from '../../src/app.js';

describe('POST /api/plugins/events', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildAuthedApp({ LOG_LEVEL: 'fatal' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function emit(body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/plugins/events', payload: body });
  }

  it('accepts an event with no session', async () => {
    // Plenty of topics are not about one — a theme change, a tab
    // opening. They still reach subscribers.
    const res = await emit({ topic: 'theme/changed', payload: '{"mode":"dark"}' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a session that is not even a session id', async () => {
    const res = await emit({
      topic: 'query/executed',
      payload: '{}',
      sessionId: 'not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });

  it('delivers the event anyway when the session is unknown', async () => {
    // Dropped rather than refused: the event is still worth delivering
    // and the plugin simply gets no db access for it. Refusing would
    // let a stale tab silence its own events.
    const res = await emit({
      topic: 'query/executed',
      payload: '{}',
      sessionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a payload past the cap', async () => {
    // The host refuses an oversized payload too; refusing here saves
    // the work and keeps the reason legible.
    const res = await emit({
      topic: 'query/executed',
      payload: 'x'.repeat(64 * 1024 + 1),
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an empty topic', async () => {
    const res = await emit({ topic: '', payload: '{}' });
    expect(res.statusCode).toBe(400);
  });
});
