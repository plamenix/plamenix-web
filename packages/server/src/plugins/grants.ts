/**
 * Per-plugin grant store backed by a single SQLite file.
 *
 * The napi binding (`@plamenix/plugin-host-node`) holds the
 * **runtime** grant set in memory — capability checks at the host-
 * import layer read from there. The server's SQLite store is the
 * **authority**: grants persist across restarts, the bootstrap
 * replays them into the napi binding at boot, and the grant/revoke
 * routes write here first then push to the binding.
 *
 * Mirrors the desktop edition's `~/.config/Plamenix/plugin_grants.json`
 * with a SQLite schema instead of a flat file — multi-tenant servers
 * need transactional updates + concurrent read safety, which the JSON
 * file pattern does not provide.
 *
 * Schema:
 *
 * ```sql
 * CREATE TABLE plugin_grants (
 *   plugin_id  TEXT NOT NULL,
 *   permission TEXT NOT NULL,
 *   granted_at INTEGER NOT NULL,           -- epoch ms
 *   PRIMARY KEY (plugin_id, permission)
 * );
 * ```
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';

export interface PluginGrant {
  pluginId: string;
  permission: string;
  grantedAt: number;
}

interface GrantRow {
  plugin_id: string;
  permission: string;
  granted_at: number;
}

export class PluginGrantStore {
  private readonly db: DatabaseType;
  private readonly insertStmt: Statement;
  private readonly deleteStmt: Statement;
  private readonly listForPluginStmt: Statement;
  private readonly listAllStmt: Statement;
  private readonly purgePluginStmt: Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS plugin_grants (
         plugin_id  TEXT NOT NULL,
         permission TEXT NOT NULL,
         granted_at INTEGER NOT NULL,
         PRIMARY KEY (plugin_id, permission)
       );
       CREATE INDEX IF NOT EXISTS idx_plugin_grants_plugin
         ON plugin_grants(plugin_id);`,
    );
    // `INSERT OR REPLACE` so re-granting bumps the timestamp without
    // surfacing a unique-constraint violation. Idempotent grants are
    // a feature: install dialogs may re-prompt across updates.
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO plugin_grants (plugin_id, permission, granted_at)
       VALUES (?, ?, ?)`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM plugin_grants WHERE plugin_id = ? AND permission = ?`,
    );
    this.listForPluginStmt = this.db.prepare(
      `SELECT plugin_id, permission, granted_at FROM plugin_grants
        WHERE plugin_id = ? ORDER BY granted_at ASC`,
    );
    this.listAllStmt = this.db.prepare(
      `SELECT plugin_id, permission, granted_at FROM plugin_grants
        ORDER BY plugin_id, granted_at ASC`,
    );
    this.purgePluginStmt = this.db.prepare(
      `DELETE FROM plugin_grants WHERE plugin_id = ?`,
    );
  }

  /**
   * Persist a grant. Idempotent — re-granting refreshes `grantedAt`.
   *
   * `declared` is the plugin manifest's required and optional
   * capabilities. It is required rather than optional so the check
   * cannot be forgotten: a grant is only meaningful for something the
   * manifest asked for, and a capability the user was never shown
   * cannot have been approved by them. The desktop edition enforces
   * the same rule in `PluginsState::grant_declared`.
   *
   * @throws When `permission` is outside `declared`.
   */
  add(pluginId: string, permission: string, declared: readonly string[]): void {
    if (!declared.includes(permission)) {
      throw new Error(
        `plugin \`${pluginId}\` does not declare \`${permission}\`; ` +
          'a capability can only be granted when its manifest asks for it',
      );
    }
    this.insertStmt.run(pluginId, permission, Date.now());
  }

  /** Remove a single grant. No-op when the row is absent. */
  remove(pluginId: string, permission: string): void {
    this.deleteStmt.run(pluginId, permission);
  }

  /** All grants for one plugin, ordered oldest-first. */
  list(pluginId: string): PluginGrant[] {
    return (this.listForPluginStmt.all(pluginId) as GrantRow[]).map(rowToGrant);
  }

  /** All grants across all plugins, grouped for fast bulk replay. */
  listAll(): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const row of this.listAllStmt.all() as GrantRow[]) {
      const existing = grouped.get(row.plugin_id);
      if (existing) {
        existing.push(row.permission);
      } else {
        grouped.set(row.plugin_id, [row.permission]);
      }
    }
    return grouped;
  }

  /**
   * Remove every grant for a plugin. Used on uninstall (Section I7)
   * so re-installing the same plugin starts from a clean grant set.
   */
  purgePlugin(pluginId: string): void {
    this.purgePluginStmt.run(pluginId);
  }
}

function rowToGrant(row: GrantRow): PluginGrant {
  return {
    pluginId: row.plugin_id,
    permission: row.permission,
    grantedAt: row.granted_at,
  };
}
