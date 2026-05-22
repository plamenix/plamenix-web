/**
 * Per-profile SQL query history backed by a single SQLite file.
 *
 * Mirrors the desktop edition's `HistoryStore` (see
 * `plamenix-desktop/src-tauri/src/history.rs`) so both editions can use
 * the shared `@plamenix/ui` `HistoryPanel` with identical entry shape.
 * Manual / profile-less sessions are intentionally not persisted: a
 * profile id is required, matching the desktop semantics.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';

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

interface HistoryRow {
  id: number;
  profile_id: string;
  sql: string;
  executed_at: number;
  duration_ms: number;
  status: string;
  error: string | null;
  row_count: number | null;
  label: string | null;
}

export class HistoryStore {
  private readonly db: DatabaseType;
  private readonly insertStmt: Statement;
  private readonly listStmt: Statement;
  private readonly clearStmt: Statement;
  private readonly trimStmt: Statement;
  private readonly setLabelStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS query_history (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         profile_id TEXT NOT NULL,
         sql TEXT NOT NULL,
         executed_at INTEGER NOT NULL,
         duration_ms INTEGER NOT NULL,
         status TEXT NOT NULL,
         error TEXT,
         row_count INTEGER,
         label TEXT
       );
       CREATE INDEX IF NOT EXISTS idx_profile_executed
         ON query_history(profile_id, executed_at DESC);`,
    );
    // Pre-H4 databases were created without the `label` column. Add it
    // lazily so an existing user does not need to clear their history.
    const columns = this.db
      .prepare(`PRAGMA table_info(query_history)`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'label')) {
      this.db.exec(`ALTER TABLE query_history ADD COLUMN label TEXT`);
    }
    this.insertStmt = this.db.prepare(
      `INSERT INTO query_history (profile_id, sql, executed_at, duration_ms, status, error, row_count)
       VALUES (@profile_id, @sql, @executed_at, @duration_ms, @status, @error, @row_count)`,
    );
    this.listStmt = this.db.prepare(
      `SELECT id, profile_id, sql, executed_at, duration_ms, status, error, row_count, label
       FROM query_history
       WHERE profile_id = ?
       ORDER BY executed_at DESC
       LIMIT ?`,
    );
    this.clearStmt = this.db.prepare(
      `DELETE FROM query_history WHERE profile_id = ?`,
    );
    this.trimStmt = this.db.prepare(
      `DELETE FROM query_history
       WHERE profile_id = ?
         AND id NOT IN (
           SELECT id FROM query_history
           WHERE profile_id = ?
           ORDER BY executed_at DESC, id DESC
           LIMIT ?
         )`,
    );
    this.setLabelStmt = this.db.prepare(
      `UPDATE query_history SET label = ? WHERE id = ?`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM query_history WHERE id = ?`,
    );
  }

  /** Deletes a single history row. Returns `true` when a row was
   *  removed, `false` when `id` is unknown. */
  delete(id: number): boolean {
    const info = this.deleteStmt.run(id);
    return Number(info.changes) > 0;
  }

  /** Deletes every history row whose id is in `ids`. Returns the
   *  number of rows actually removed. Runs inside a transaction so a
   *  partial failure rolls back the entire batch. */
  deleteMany(ids: ReadonlyArray<number>): number {
    if (ids.length === 0) return 0;
    const run = this.db.transaction((batch: ReadonlyArray<number>) => {
      let total = 0;
      for (const id of batch) {
        const info = this.deleteStmt.run(id);
        total += Number(info.changes);
      }
      return total;
    });
    return run(ids);
  }

  /** Sets or clears the free-form label on a single history row.
   *  Returns `true` when a row was updated, `false` when `id` is
   *  unknown. An empty (or whitespace-only) `label` clears the field —
   *  the host wires this as the "delete the label" affordance. */
  setLabel(id: number, label: string | null): boolean {
    const trimmed = typeof label === 'string' ? label.trim() : null;
    const stored = trimmed && trimmed.length > 0 ? trimmed : null;
    const info = this.setLabelStmt.run(stored, id);
    return Number(info.changes) > 0;
  }

  record(args: {
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
  }): void {
    this.insertStmt.run({
      profile_id: args.profileId,
      sql: args.sql,
      executed_at: Date.now(),
      duration_ms: args.durationMs,
      status: args.status,
      error: args.error,
      row_count: args.rowCount,
    });
    if (typeof args.limit === 'number' && args.limit > 0) {
      this.trimStmt.run(args.profileId, args.profileId, args.limit);
    }
  }

  list(profileId: string, limit: number): HistoryEntry[] {
    const rows = this.listStmt.all(profileId, limit) as HistoryRow[];
    return rows.map(toEntry);
  }

  clear(profileId: string): number {
    const result = this.clearStmt.run(profileId);
    return Number(result.changes);
  }
}

function toEntry(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    sql: row.sql,
    executedAt: row.executed_at,
    durationMs: row.duration_ms,
    status: row.status === 'err' ? 'err' : 'ok',
    error: row.error,
    rowCount: row.row_count,
    label: row.label,
  };
}
