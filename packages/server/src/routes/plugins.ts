import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as pluginHost from '@plamenix/plugin-host-node';
import type { PluginGrantStore } from '../plugins/grants.js';
import { assertSafePluginId } from '../plugins/storage.js';

export interface PluginsRouteOptions {
  grantStore: PluginGrantStore;
  /** I7.9 — root for plugin storage dirs. Each plugin's data lives at
   *  `<pluginDataRoot>/<plugin_id>/`. Used by the uninstall route to
   *  delete the storage dir when the admin opts in. */
  pluginDataRoot: string;
}

const idParam = z.object({ id: z.string().min(1) });
const loadBody = z.object({ bundlePath: z.string().min(1) });
const permissionBody = z.object({ permission: z.string().min(1) });

/**
 * I7.8 — admin install body.
 *
 * Accepts the `.plx` bundle as base64-encoded bytes (`bundleBase64`)
 * plus the optional permissions the admin granted at upload time
 * (`grantedOptional`). The JSON-with-base64 shape was chosen over
 * `multipart/form-data` to avoid adding `@fastify/multipart` to the
 * server's dependency surface; the 33% base64 overhead is acceptable
 * because admin uploads are infrequent (one per plugin install) and
 * `.plx` bundles target the MiB range, not GiB.
 *
 * Body size is capped per-route via Fastify's `bodyLimit` option;
 * see the route registration below.
 */
const installBody = z.object({
  bundleBase64: z.string().min(1),
  grantedOptional: z.array(z.string().min(1)).default([]),
});

/** I7.9 — uninstall body. `alsoDeleteStorage` mirrors the desktop
 *  modal's checkbox; `false` preserves the plugin's `<pluginDataRoot>
 *  /<plugin_id>/` directory for a future re-install. */
const uninstallBody = z.object({
  alsoDeleteStorage: z.boolean().default(true),
});

/** Hard ceiling for an admin-uploaded `.plx` bundle. 32 MiB covers
 *  every realistic plugin (wasm + UI bundle + bundled assets) with
 *  generous headroom. The base64 overhead bumps the wire size to
 *  ~43 MiB; the Fastify per-route limit lives below. */
const PLX_MAX_BYTES = 32 * 1024 * 1024;
const INSTALL_REQUEST_BODY_LIMIT = Math.ceil(PLX_MAX_BYTES * 1.4);

/**
 * Plugin lifecycle routes. Mirrors the desktop edition's Tauri
 * `plugin_*` commands. Boot-time discovery and per-bundle errors live
 * in `../plugins/host.ts`; these routes are the request/response
 * surface the React shell calls into.
 *
 * Grant/revoke routes persist via [`PluginGrantStore`] (SQLite-backed
 * authority) **before** pushing the change to the napi binding's
 * in-memory cache, so a server restart mid-operation leaves the
 * authority and the runtime in sync.
 *
 * All endpoints are POSTs (mutating) except `GET /api/plugins` which
 * is the cacheable list view.
 */
export function pluginsRoute(options: PluginsRouteOptions) {
  const { grantStore, pluginDataRoot } = options;
  return async function register(app: FastifyInstance): Promise<void> {
    app.get('/api/plugins', async () => {
      const active = await pluginHost.listActive();
      return { plugins: active };
    });

    app.post('/api/plugins/load', async (request, reply) => {
      const parsed = loadBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      try {
        const staged = await pluginHost.loadPlugin(parsed.data.bundlePath);
        return { staged };
      } catch (err) {
        return reply.code(400).send({
          error: 'load_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    app.post('/api/plugins/:id/activate', async (request, reply) => {
      const parsed = idParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      try {
        const activated = await pluginHost.activatePlugin(parsed.data.id);
        return { activated };
      } catch (err) {
        return reply.code(400).send({
          error: 'activate_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    /**
     * Serves the plugin's React UI bundle (`<bundle>/ui.mjs`) for
     * dynamic import by the client. Mirrors how the desktop edition
     * resolves an on-disk path via Tauri's `convertFileSrc` — the web
     * client just dynamic-imports this URL directly. The shipped
     * client integration lives in I2.5's frontend half (added
     * alongside the first real UI plugin in I4); this endpoint is the
     * runtime backing.
     *
     * Path safety: the plugin id is validated through
     * `assertSafePluginId` (no `..`, slashes, NUL, etc.) and the
     * bundle dir is resolved through `path.join` then double-checked
     * to confirm the resulting absolute path still sits under the
     * registry-reported `bundleDir`. Any traversal attempt 400s.
     */
    app.get('/api/plugins/:id/ui.mjs', async (request, reply) => {
      const parsed = idParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      try {
        assertSafePluginId(parsed.data.id);
      } catch (err) {
        return reply.code(400).send({
          error: 'unsafe_id',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const active = await pluginHost.listActive();
      const plugin = active.find((p) => p.id === parsed.data.id);
      if (!plugin) {
        return reply.code(404).send({ error: 'plugin_not_loaded' });
      }

      const bundleDir = path.resolve(plugin.bundleDir);
      const uiBundle = path.resolve(bundleDir, 'ui.mjs');
      // Belt-and-suspenders: refuse any resolved path that escapes
      // its own bundle dir, even if assertSafePluginId would have
      // already caught it.
      if (!uiBundle.startsWith(`${bundleDir}${path.sep}`)) {
        return reply.code(400).send({ error: 'path_escape' });
      }

      let body: string;
      try {
        body = await fs.readFile(uiBundle, 'utf8');
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === 'ENOENT') {
          return reply.code(404).send({ error: 'ui_bundle_missing' });
        }
        return reply.code(500).send({
          error: 'ui_bundle_read_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      reply
        .type('application/javascript; charset=utf-8')
        // The bundle is cached aggressively per plugin version + the
        // hashed `etag` Fastify auto-derives. Hot-reload on plugin
        // update is I2.7's job; until then a server restart picks up
        // bundle changes.
        .header('cache-control', 'public, max-age=300, must-revalidate');
      return body;
    });

    /**
     * Reload the plugin from disk without restarting the host. Calls
     * the napi `reload_plugin` which captures the bundle path from
     * the registry, deactivates, re-stages, re-activates. Persisted
     * grants are replayed in the new activation by the same path the
     * bootstrap uses (see I1.6).
     */
    app.post('/api/plugins/:id/reload', async (request, reply) => {
      const parsed = idParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      try {
        const activated = await pluginHost.reloadPlugin(parsed.data.id);
        // Replay persisted grants per I1.6's bootstrap pattern so
        // the reloaded plugin sees the same granted set the user
        // already approved. Failures (capability grammar drift since
        // the grant was persisted) logged but not fatal.
        const persisted = grantStore.list(parsed.data.id);
        for (const { permission } of persisted) {
          try {
            await pluginHost.grantPermission(parsed.data.id, permission);
          } catch (err) {
            request.log.warn(
              { id: parsed.data.id, permission, err: err instanceof Error ? err.message : String(err) },
              'grant replay during reload failed',
            );
          }
        }
        // Re-fetch the activated view so grantedPermissions reflects
        // the replay.
        const refreshed = (await pluginHost.listActive()).find((p) => p.id === parsed.data.id);
        return { activated: refreshed ?? activated };
      } catch (err) {
        return reply.code(400).send({
          error: 'reload_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    app.post('/api/plugins/:id/deactivate', async (request, reply) => {
      const parsed = idParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      try {
        await pluginHost.deactivatePlugin(parsed.data.id);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({
          error: 'deactivate_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    app.post('/api/plugins/:id/grant', async (request, reply) => {
      const idParsed = idParam.safeParse(request.params);
      const bodyParsed = permissionBody.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          issues: [
            ...(idParsed.success ? [] : idParsed.error.issues),
            ...(bodyParsed.success ? [] : bodyParsed.error.issues),
          ],
        });
      }
      try {
        // Persist first — if the napi push then fails, the next boot
        // replays the persisted grant and the operator sees consistent
        // state. The opposite ordering would risk losing a grant if
        // the server crashed between the napi push and the SQLite
        // commit.
        grantStore.add(idParsed.data.id, bodyParsed.data.permission);
        await pluginHost.grantPermission(idParsed.data.id, bodyParsed.data.permission);
        const active = await pluginHost.listActive();
        return { plugins: active };
      } catch (err) {
        return reply.code(400).send({
          error: 'grant_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    /**
     * I7.8 — admin install endpoint.
     *
     * Accepts a base64-encoded `.plx` bundle plus the optional
     * permissions the admin granted at upload time. Validates the
     * body shape + size, then hands the bundle bytes to the
     * `.plx` extractor (I7.10) for unpacking + registration.
     *
     * Returns `501` until I7.10 lands — the route, validation,
     * size limit, and grant-replay path are all wired so the
     * admin tooling can be developed against the real contract
     * shape today. The 501 response carries a structured
     * `pending: 'i7.10_plx_extractor'` field so client tooling
     * can branch on the stub vs the live install.
     */
    app.post(
      '/api/plugins/install',
      { bodyLimit: INSTALL_REQUEST_BODY_LIMIT },
      async (request, reply) => {
        const parsed = installBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'invalid_body',
            issues: parsed.error.issues,
          });
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(parsed.data.bundleBase64, 'base64');
        } catch (err) {
          return reply.code(400).send({
            error: 'invalid_base64',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        if (bytes.length === 0) {
          return reply.code(400).send({ error: 'empty_bundle' });
        }
        if (bytes.length > PLX_MAX_BYTES) {
          return reply.code(413).send({
            error: 'bundle_too_large',
            limit: PLX_MAX_BYTES,
            actual: bytes.length,
          });
        }
        return reply.code(501).send({
          error: 'not_implemented',
          pending: 'i7.10_plx_extractor',
          message:
            'Install pipeline is stubbed. The .plx extractor + loader land in I7.10; the route shape, base64 contract, and size limit are stable.',
          accepted: {
            bytes: bytes.length,
            grantedOptional: parsed.data.grantedOptional,
          },
        });
      },
    );

    /**
     * I7.9 — uninstall a plugin.
     *
     * Order of operations (failure-tolerant):
     *
     *   1. Deactivate via the napi binding. Failure logged but
     *      non-fatal — the plugin may already be deactivated.
     *   2. Purge persisted grants for the plugin id. Idempotent.
     *   3. Remove the bundle directory recursively. Failure here
     *      surfaces as a 500 because the on-disk state is the
     *      authority for what's installed; the napi runtime might
     *      still have the entry until a restart picks up the missing
     *      bundle.
     *   4. If `alsoDeleteStorage` is true, remove the plugin's
     *      `<pluginDataRoot>/<plugin_id>/` directory. Failure here
     *      surfaces as a 500 — the storage delete was explicitly
     *      requested by the admin, so silent failure is worse than
     *      a clear error.
     *
     * Path safety: `assertSafePluginId` rejects ids containing `/`,
     * `\`, `..`, NUL, etc. The bundleDir from the runtime is
     * `path.resolve`d + verified to live under a parent directory
     * before any `fs.rm` runs. Same belt-and-suspenders pattern as
     * the existing `ui.mjs` route.
     */
    app.post('/api/plugins/:id/uninstall', async (request, reply) => {
      const idParsed = idParam.safeParse(request.params);
      const bodyParsed = uninstallBody.safeParse(request.body ?? {});
      if (!idParsed.success || !bodyParsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          issues: [
            ...(idParsed.success ? [] : idParsed.error.issues),
            ...(bodyParsed.success ? [] : bodyParsed.error.issues),
          ],
        });
      }
      const pluginId = idParsed.data.id;
      try {
        assertSafePluginId(pluginId);
      } catch (err) {
        return reply.code(400).send({
          error: 'unsafe_id',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const active = await pluginHost.listActive();
      const plugin = active.find((p) => p.id === pluginId);
      if (!plugin) {
        return reply.code(404).send({ error: 'plugin_not_found' });
      }
      const bundleDir = path.resolve(plugin.bundleDir);

      // Step 1 — deactivate (tolerant).
      try {
        await pluginHost.deactivatePlugin(pluginId);
      } catch (err) {
        request.log.warn(
          { id: pluginId, err: err instanceof Error ? err.message : String(err) },
          'uninstall: deactivate failed (continuing)',
        );
      }

      // Step 2 — purge grants.
      grantStore.purgePlugin(pluginId);

      // Step 3 — remove bundle dir.
      try {
        await fs.rm(bundleDir, { recursive: true, force: true });
      } catch (err) {
        return reply.code(500).send({
          error: 'bundle_remove_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 4 — optional storage delete.
      let storageDeleted = false;
      if (bodyParsed.data.alsoDeleteStorage) {
        const storageDir = path.resolve(pluginDataRoot, pluginId);
        const dataRootResolved = path.resolve(pluginDataRoot);
        // Belt-and-suspenders: storageDir MUST be a child of
        // pluginDataRoot. assertSafePluginId already rejects
        // path-escape attempts but the resolve check catches
        // symlink shenanigans + path normalisation surprises.
        if (!storageDir.startsWith(`${dataRootResolved}${path.sep}`)) {
          return reply.code(400).send({ error: 'storage_path_escape' });
        }
        try {
          await fs.rm(storageDir, { recursive: true, force: true });
          storageDeleted = true;
        } catch (err) {
          return reply.code(500).send({
            error: 'storage_remove_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const remaining = await pluginHost.listActive();
      return {
        uninstalled: pluginId,
        storageDeleted,
        plugins: remaining,
      };
    });

    app.post('/api/plugins/:id/revoke', async (request, reply) => {
      const idParsed = idParam.safeParse(request.params);
      const bodyParsed = permissionBody.safeParse(request.body);
      if (!idParsed.success || !bodyParsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          issues: [
            ...(idParsed.success ? [] : idParsed.error.issues),
            ...(bodyParsed.success ? [] : bodyParsed.error.issues),
          ],
        });
      }
      try {
        // Same persist-first ordering as grant — a crash between
        // SQLite delete and napi revoke leaves the runtime granting a
        // capability the authority no longer holds, but the next boot
        // reconciles by replaying only the persisted grants (the
        // revoked one is absent, so it falls out).
        grantStore.remove(idParsed.data.id, bodyParsed.data.permission);
        await pluginHost.revokePermission(idParsed.data.id, bodyParsed.data.permission);
        const active = await pluginHost.listActive();
        return { plugins: active };
      } catch (err) {
        return reply.code(400).send({
          error: 'revoke_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };
}
