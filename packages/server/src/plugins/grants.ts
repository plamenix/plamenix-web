/**
 * Per-plugin capability grants, in Plamenix's own Firebird database.
 *
 * The napi binding (`@plamenix/native`) holds the **runtime** grant set
 * in memory — capability checks at the host-import layer read from
 * there. This store is the **authority**: grants persist across
 * restarts, the bootstrap replays them into the runtime at boot, and
 * the grant/revoke routes write here first then push to the binding.
 *
 * This was a SQLite file, and the same table existed again in Rust in
 * the desktop shell. Both editions now go through `plamenix-meta`, in
 * the engine this IDE is for. Schema:
 *
 * ```sql
 * CREATE TABLE PLUGIN_GRANTS (
 *   PLUGIN_ID  VARCHAR(255) NOT NULL,
 *   PERMISSION VARCHAR(512) NOT NULL,
 *   GRANTED_AT BIGINT NOT NULL,           -- epoch ms
 *   PRIMARY KEY (PLUGIN_ID, PERMISSION)
 * );
 * ```
 *
 * The methods are `async` because the driver is. The store holds no
 * state: the metadata database is opened once per process by
 * `initMeta`.
 */

import * as native from '@plamenix/native';

export class PluginGrantStore {
  /**
   * Persist a grant. Idempotent — re-granting is a no-op rather than a
   * primary-key violation.
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
  async add(pluginId: string, permission: string, declared: readonly string[]): Promise<void> {
    if (!declared.includes(permission)) {
      throw new Error(
        `plugin \`${pluginId}\` does not declare \`${permission}\`; ` +
          'a capability can only be granted when its manifest asks for it',
      );
    }
    await native.grantAdd(pluginId, permission);
  }

  /** Remove a single grant. No-op when the row is absent. */
  async remove(pluginId: string, permission: string): Promise<void> {
    await native.grantRemove(pluginId, permission);
  }

  /** Capabilities granted to one plugin. */
  async list(pluginId: string): Promise<string[]> {
    return native.grantList(pluginId);
  }

  /** Every grant, by plugin, for the boot-time replay. */
  async listAll(): Promise<Map<string, string[]>> {
    const grouped = (await native.grantListAll()) as Record<string, string[]>;
    return new Map(Object.entries(grouped));
  }

  /**
   * Remove every grant for a plugin. Used on uninstall (Section I7)
   * so re-installing the same plugin starts from a clean grant set.
   */
  async purgePlugin(pluginId: string): Promise<void> {
    await native.grantPurgePlugin(pluginId);
  }
}
