/**
 * Boot-time plugin orchestrator.
 *
 * Walks `env.PLUGINS_PATH` for every direct subdirectory containing
 * `manifest.toml` and loads + activates each as a Plamenix plugin via
 * `@plamenix/native`. Surfaces the active list for the
 * Fastify route layer.
 *
 * Mirrors the responsibilities of `plamenix-desktop/src-tauri/src/plugins.rs`
 * adapted for a multi-tenant server context. Grant persistence lands
 * in Section I1.6 (SQLite-backed); for now grants live in-memory in
 * the napi binding's registry.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as pluginHost from '@plamenix/native';
import type {
  ActivatedPluginInfo,
  StagedPluginInfo,
} from '@plamenix/native';
import { ensurePluginDataDir } from './storage.js';
import type { PluginGrantStore } from './grants.js';

export interface BootstrapResult {
  /** Plugins that loaded and activated successfully. */
  active: ActivatedPluginInfo[];
  /** Per-bundle failures, keyed by bundle directory name. */
  failures: Array<{ bundleDir: string; error: string }>;
}

export interface BootstrapOptions {
  /** Plugins directory to scan. Resolved to an absolute path. */
  pluginsDir: string;
  /** Root for per-plugin writable storage; `<root>/<plugin-id>/data/`
   *  is created at activation time. */
  pluginDataRoot: string;
  /** SQLite-backed persistent grant store. Replayed into the napi
   *  binding's in-memory set after each plugin activates. */
  grantStore: PluginGrantStore;
  /** Logger to surface progress + per-plugin failures. */
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Initialises the plugin host's tracing and walks the plugins
 * directory. Each subdir containing `manifest.toml` is loaded then
 * activated. Failures are recorded but do not abort the bootstrap —
 * a single bad plugin should not block the server from coming up.
 */
export async function bootstrapPlugins(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  pluginHost.initTracing();

  const pluginsDir = path.resolve(options.pluginsDir);
  const failures: Array<{ bundleDir: string; error: string }> = [];
  const active: ActivatedPluginInfo[] = [];

  const entries = await readPluginDirs(pluginsDir, options.log);

  for (const bundleDir of entries) {
    let staged: StagedPluginInfo;
    try {
      staged = await pluginHost.loadPlugin(bundleDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ bundleDir, error: message });
      options.log.warn('plugin load failed', { bundleDir, error: message });
      continue;
    }

    if (!staged.targets.includes('web')) {
      // Plugin declared `targets` excluding the web edition; honour
      // it by deactivating immediately and recording a failure.
      // Section I7's install-time enforcement will refuse such
      // plugins before this point lands in production.
      await safelyDeactivate(staged.id, options.log);
      const reason = `plugin targets ${JSON.stringify(staged.targets)} but this edition is "web"`;
      failures.push({ bundleDir, error: reason });
      options.log.warn('plugin skipped (edition mismatch)', { bundleDir, reason });
      continue;
    }

    try {
      // Allocate the per-plugin writable storage dir before
      // activation so any future host import wired to WASI preopens
      // (Section I6 `fs:*` capabilities) hits a guaranteed-existing
      // path. Failure to create the dir is a hard fail for the
      // plugin — it can't be expected to operate without storage.
      const dataDir = await ensurePluginDataDir(options.pluginDataRoot, staged.id);
      options.log.info('plugin data dir ready', { id: staged.id, dataDir });

      const activated = await pluginHost.activatePlugin(staged.id);
      if (activated.activation.status !== 'ok') {
        await safelyDeactivate(staged.id, options.log);
        const reason = activated.activation.message ?? 'unknown';
        failures.push({ bundleDir, error: `activation failed: ${reason}` });
        options.log.warn('plugin activation failed', { bundleDir, reason });
        continue;
      }
      // Replay persisted grants from the SQLite authority into the
      // napi binding's in-memory cache so the activated plugin sees
      // its previously-granted capabilities without re-prompting the
      // user. Per-grant failures are non-fatal — they suggest a
      // capability grammar drift (e.g. plugin updated its required
      // set) and the operator should reconcile via the Permissions
      // panel (Section I7).
      const persisted = options.grantStore.list(activated.id);
      for (const { permission } of persisted) {
        try {
          await pluginHost.grantPermission(activated.id, permission);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          options.log.warn('grant replay failed', {
            id: activated.id,
            permission,
            error: message,
          });
        }
      }
      // Re-fetch the activated view so the bootstrap result reflects
      // the replayed grants (granted vs pending booleans).
      const refreshed = (await pluginHost.listActive()).find((p) => p.id === activated.id);
      active.push(refreshed ?? activated);
      options.log.info('plugin activated', {
        id: activated.id,
        version: activated.version,
        sidebarPanels: activated.sidebarPanels.length,
        replayedGrants: persisted.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await safelyDeactivate(staged.id, options.log);
      failures.push({ bundleDir, error: message });
      options.log.warn('plugin activate threw', { bundleDir, error: message });
    }
  }

  options.log.info('plugin bootstrap complete', {
    activated: active.length,
    failed: failures.length,
  });

  return { active, failures };
}

async function readPluginDirs(
  pluginsDir: string,
  log: BootstrapOptions['log'],
): Promise<string[]> {
  let dirents;
  try {
    dirents = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      log.info('plugin scan skipped (directory missing)', { pluginsDir });
      return [];
    }
    throw err;
  }

  const candidates: string[] = [];
  for (const entry of dirents) {
    if (!entry.isDirectory()) continue;
    const bundleDir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(bundleDir, 'manifest.toml');
    try {
      await fs.access(manifestPath);
      candidates.push(bundleDir);
    } catch {
      log.info('plugin scan skipped (no manifest.toml)', { bundleDir });
    }
  }
  return candidates;
}

async function safelyDeactivate(
  pluginId: string,
  log: BootstrapOptions['log'],
): Promise<void> {
  try {
    await pluginHost.deactivatePlugin(pluginId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('plugin cleanup deactivate failed', { pluginId, error: message });
  }
}

/** Convenience re-export — routes consume this to issue lifecycle calls. */
export { pluginHost };
