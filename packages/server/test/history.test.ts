/**
 * Query history, end to end through the routes.
 *
 * The store moved from a SQLite file to Plamenix's own Firebird
 * database, and the routes went from synchronous calls to awaited ones.
 * Nothing here had a test before that move, which meant the whole panel
 * — list, label, delete, delete-many, clear, and the retention cap —
 * rested on the migration being right by inspection.
 *
 * These go through the real store rather than a fake: what is being
 * checked is that entries survive a write and come back in the shape the
 * `HistoryPanel` reads, and a fake would only prove the routes call a
 * function.
 *
 * Needs the bundled Firebird; skipped without it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HistoryStore, type HistoryEntry } from '../src/history/store.js';
import { buildAuthedApp, HAS_FIREBIRD } from './helpers/authed.js';
import type { App } from '../src/app.js';

/** Isolation is by profile id: the metadata database is one file per
 *  test process, so a shared profile would leak between tests. */
let seq = 0;
function profile(): string {
  seq += 1;
  return `history-test-${seq}`;
}

async function record(
  store: HistoryStore,
  profileId: string,
  sql: string,
  overrides: Partial<{ status: 'ok' | 'err'; error: string | null; rowCount: number | null; limit: number | null }> = {},
): Promise<void> {
  await store.record({
    profileId,
    sql,
    durationMs: 12,
    status: overrides.status ?? 'ok',
    error: overrides.error ?? null,
    rowCount: overrides.rowCount ?? null,
    limit: overrides.limit ?? null,
  });
}

describe.skipIf(!HAS_FIREBIRD)('query history', () => {
  let app: App;
  let store: HistoryStore;

  async function list(profileId: string, limit = 200): Promise<HistoryEntry[]> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/history-list',
      payload: { profileId, limit },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload) as HistoryEntry[];
  }

  beforeAll(async () => {
    app = await buildAuthedApp({ LOG_LEVEL: 'fatal' });
    await app.ready();
    store = new HistoryStore();
  });

  afterAll(async () => {
    await app.close();
  });

  it('round-trips an entry with every field the panel renders', async () => {
    const id = profile();
    await record(store, id, 'SELECT * FROM RDB$DATABASE', { rowCount: 1 });

    const [entry] = await list(id);
    expect(entry).toMatchObject({
      profileId: id,
      sql: 'SELECT * FROM RDB$DATABASE',
      durationMs: 12,
      status: 'ok',
      error: null,
      rowCount: 1,
      label: null,
    });
    // The identity column is what every mutating route addresses rows
    // by; a zero or missing id would make label/delete unaddressable.
    expect(entry?.id).toBeGreaterThan(0);
    expect(entry?.executedAt).toBeGreaterThan(0);
  });

  it('keeps a failure and its message', async () => {
    const id = profile();
    await record(store, id, 'SELECT * FROM NOPE', {
      status: 'err',
      error: 'Table unknown NOPE',
    });

    const [entry] = await list(id);
    expect(entry?.status).toBe('err');
    expect(entry?.error).toBe('Table unknown NOPE');
  });

  it('returns newest first', async () => {
    const id = profile();
    await record(store, id, 'SELECT 1 FROM RDB$DATABASE');
    await record(store, id, 'SELECT 2 FROM RDB$DATABASE');
    await record(store, id, 'SELECT 3 FROM RDB$DATABASE');

    const sqls = (await list(id)).map((e) => e.sql);
    expect(sqls[0]).toBe('SELECT 3 FROM RDB$DATABASE');
    expect(sqls).toHaveLength(3);
  });

  it('never returns another profile’s entries', async () => {
    const mine = profile();
    const theirs = profile();
    await record(store, mine, 'SELECT 1 FROM RDB$DATABASE');
    await record(store, theirs, 'SELECT 2 FROM RDB$DATABASE');

    expect(await list(mine)).toHaveLength(1);
  });

  it('honours the retention cap, keeping the newest', async () => {
    // Without this the table grows one row per statement forever. The
    // desktop shell and the server pass the same `limit`, so the cap is
    // the only thing standing between a long session and an unbounded
    // history.
    const id = profile();
    for (const n of [1, 2, 3, 4, 5]) {
      await record(store, id, `SELECT ${n} FROM RDB$DATABASE`, { limit: 3 });
    }

    const sqls = (await list(id)).map((e) => e.sql);
    expect(sqls).toEqual([
      'SELECT 5 FROM RDB$DATABASE',
      'SELECT 4 FROM RDB$DATABASE',
      'SELECT 3 FROM RDB$DATABASE',
    ]);
  });

  it('caps the returned rows at the requested limit', async () => {
    const id = profile();
    for (const n of [1, 2, 3]) await record(store, id, `SELECT ${n} FROM RDB$DATABASE`);

    expect(await list(id, 2)).toHaveLength(2);
  });

  it('sets and clears a label', async () => {
    const id = profile();
    await record(store, id, 'SELECT 1 FROM RDB$DATABASE');
    const entryId = (await list(id))[0]?.id ?? 0;

    const set = await app.inject({
      method: 'POST',
      url: '/api/history-set-label',
      payload: { id: entryId, label: '  nightly report  ' },
    });
    expect(JSON.parse(set.payload)).toEqual({ updated: true });
    // Trimmed on the way in, or the chip renders with the user's stray
    // spaces baked into it.
    expect((await list(id))[0]?.label).toBe('nightly report');

    // Whitespace-only is the "delete the label" affordance, not a label
    // made of spaces.
    await app.inject({
      method: 'POST',
      url: '/api/history-set-label',
      payload: { id: entryId, label: '   ' },
    });
    expect((await list(id))[0]?.label).toBeNull();
  });

  it('reports an unknown id rather than claiming an update', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/history-set-label',
      payload: { id: 987_654_321, label: 'ghost' },
    });
    expect(JSON.parse(res.payload)).toEqual({ updated: false });
  });

  it('deletes one entry and leaves the rest', async () => {
    const id = profile();
    await record(store, id, 'SELECT 1 FROM RDB$DATABASE');
    await record(store, id, 'SELECT 2 FROM RDB$DATABASE');
    const target = (await list(id)).find((e) => e.sql === 'SELECT 1 FROM RDB$DATABASE');

    const res = await app.inject({
      method: 'POST',
      url: '/api/history-delete',
      payload: { id: target?.id ?? 0 },
    });
    expect(JSON.parse(res.payload)).toEqual({ removed: true });

    const remaining = await list(id);
    expect(remaining.map((e) => e.sql)).toEqual(['SELECT 2 FROM RDB$DATABASE']);
  });

  it('deletes a batch and counts what actually went', async () => {
    const id = profile();
    for (const n of [1, 2, 3]) await record(store, id, `SELECT ${n} FROM RDB$DATABASE`);
    const ids = (await list(id)).map((e) => e.id).slice(0, 2);

    const res = await app.inject({
      method: 'POST',
      url: '/api/history-delete-many',
      payload: { ids: [...ids, 987_654_322] },
    });
    // The unknown id contributes nothing rather than failing the batch.
    expect(JSON.parse(res.payload)).toEqual({ removed: 2 });
    expect(await list(id)).toHaveLength(1);
  });

  it('clears one profile and reports the count', async () => {
    const mine = profile();
    const theirs = profile();
    for (const n of [1, 2]) await record(store, mine, `SELECT ${n} FROM RDB$DATABASE`);
    await record(store, theirs, 'SELECT 9 FROM RDB$DATABASE');

    const res = await app.inject({
      method: 'POST',
      url: '/api/history-clear',
      payload: { profileId: mine },
    });
    expect(JSON.parse(res.payload)).toEqual({ cleared: 2 });
    expect(await list(mine)).toHaveLength(0);
    expect(await list(theirs)).toHaveLength(1);
  });

  it('rejects a list with no profile id', async () => {
    // History is bound to a profile on both editions; a profile-less
    // request would otherwise be a way to read every session's entries.
    const res = await app.inject({
      method: 'POST',
      url: '/api/history-list',
      payload: { limit: 10 },
    });
    expect(res.statusCode).toBe(400);
  });
});
