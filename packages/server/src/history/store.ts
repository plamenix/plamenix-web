/**
 * Per-profile SQL query history, in Plamenix's own Firebird database.
 *
 * This was a SQLite file, and the identical schema existed again in
 * Rust in the desktop shell — so a change to it meant two edits in two
 * languages. Both editions now go through `plamenix-meta`, reached from
 * here via `@plamenix/native`. One implementation, in the engine this
 * IDE is for, exercised through the driver the product ships.
 *
 * Manual / profile-less sessions are intentionally not persisted: a
 * profile id is required, matching the desktop semantics.
 *
 * The methods are `async` because the driver is. The store holds no
 * state — the metadata database is opened once per process by
 * `initMeta`, since Firebird's embedded engine takes the file
 * exclusively and a second open would fail rather than merely be slow.
 */

import * as native from '@plamenix/native';

/** Camel-case shape matching the `HistoryEntry` type emitted by Specta
 *  from `plamenix-types::HistoryEntry`. Kept in sync manually since the
 *  server does not consume the generated TS file. */
export interface HistoryEntry {
  id: number;
  profileId: string;
  sql: string;
  executedAt: number;
  durationMs: number;
  status: 'ok' | 'err';
  error: string | null;
  rowCount: number | null;
  label: string | null;
}

export class HistoryStore {
  /** Deletes a single history row. Returns `true` when a row was
   *  removed, `false` when `id` is unknown. */
  async delete(id: number): Promise<boolean> {
    return native.historyDelete(id);
  }

  /** Deletes every history row whose id is in `ids`. Returns the
   *  number of rows actually removed. One statement, so a partial
   *  failure cannot leave half the batch gone. */
  async deleteMany(ids: readonly number[]): Promise<number> {
    if (ids.length === 0) return 0;
    return Number(await native.historyDeleteMany([...ids]));
  }

  /** Sets or clears the free-form label on a single history row.
   *  Returns `true` when a row was updated, `false` when `id` is
   *  unknown. An empty (or whitespace-only) `label` clears the field —
   *  the host wires this as the "delete the label" affordance. */
  async setLabel(id: number, label: string | null): Promise<boolean> {
    const trimmed = typeof label === 'string' ? label.trim() : null;
    const stored = trimmed && trimmed.length > 0 ? trimmed : null;
    return native.historySetLabel(id, stored);
  }

  async record(args: {
    profileId: string;
    sql: string;
    durationMs: number;
    status: 'ok' | 'err';
    error: string | null;
    rowCount: number | null;
    /** Per-profile retention cap. `null` or `undefined` means no trim
     *  runs after the insert. Positive integers cause the store to
     *  drop entries older than the most recent `N`. */
    limit?: number | null;
  }): Promise<void> {
    await native.historyRecord(
      args.profileId,
      args.sql,
      Date.now(),
      args.durationMs,
      args.status,
      args.error,
      args.rowCount,
      null,
      args.limit ?? null,
    );
  }

  async list(profileId: string, limit: number): Promise<HistoryEntry[]> {
    const rows = (await native.historyList(profileId, limit)) as HistoryEntry[];
    // `status` is a free-form column in the database and a union here;
    // anything that is not an explicit failure reads as success, which
    // is how the old row mapper treated it too.
    return rows.map((row) => ({ ...row, status: row.status === 'err' ? 'err' : 'ok' }));
  }

  async clear(profileId: string): Promise<number> {
    return Number(await native.historyClear(profileId));
  }
}
