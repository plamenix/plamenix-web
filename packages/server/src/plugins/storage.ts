/**
 * Per-plugin writable storage scope.
 *
 * Layout under the configured `PLUGIN_DATA_ROOT`:
 *
 * ```
 * <PLUGIN_DATA_ROOT>/
 *   <plugin-id>/
 *     data/          plugin's writable space (WASI preopen target in I6)
 *     grants.json    optional sidecar; superseded by the metadata database
 * ```
 *
 * Rules enforced here:
 *
 * - Plugin id is treated as an opaque key. The grammar in
 *   `plamenix/docs/plugin-manifest.md` already limits ids to reverse-
 *   DNS-safe characters, but this module rejects any id containing
 *   `..`, `/`, `\`, or NULs to defend in depth against a malformed
 *   manifest sneaking past validation.
 * - Directories are created with `recursive: true` and mode `0o700`.
 *   The web edition's single-machine M1 assumption keeps all plugin
 *   data scoped to the server's own user; multi-tenant per-OS-user
 *   layouts are a 1.x concern once that demand surfaces.
 * - The path is resolved relative to `process.cwd()` when the root
 *   itself is relative; absolute roots are honoured as-is. Production
 *   deployments should pass an absolute path (`/var/lib/plamenix/plugins`).
 *
 * Capability gating at the host-import layer is *not* enforced here;
 * this module only allocates the path. WASI preopen wiring (I6) is
 * what stops a plugin without `fs:read:plugin-data` from reading the
 * dir. The path exists either way so the server's own bookkeeping can
 * use it.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Reject plugin ids that could escape their own scope or write to
 * unexpected places. Called before any filesystem operation.
 */
export function assertSafePluginId(pluginId: string): void {
  if (pluginId.length === 0) {
    throw new Error('plugin id must be non-empty');
  }
  if (pluginId.includes('..') || pluginId.includes('/') || pluginId.includes('\\') || pluginId.includes('\0')) {
    throw new Error(`unsafe plugin id: ${JSON.stringify(pluginId)}`);
  }
}

/** Resolves the absolute root for a plugin's data directory. */
export function pluginRootDir(root: string, pluginId: string): string {
  assertSafePluginId(pluginId);
  return path.resolve(root, pluginId);
}

/** Resolves the plugin's writable `data/` subdirectory. */
export function pluginDataDir(root: string, pluginId: string): string {
  return path.join(pluginRootDir(root, pluginId), 'data');
}

/**
 * Creates `<root>/<plugin-id>/data/` (idempotently) and returns the
 * absolute path. Use this at plugin-activation time so the WASI
 * preopen in I6 can hand the plugin a guaranteed-existing handle.
 */
export async function ensurePluginDataDir(root: string, pluginId: string): Promise<string> {
  const dir = pluginDataDir(root, pluginId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
