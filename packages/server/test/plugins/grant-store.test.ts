/**
 * The grant store, against the real metadata database.
 *
 * These used to run on a throwaway SQLite file per test. The store is
 * Firebird Embedded now, whose engine takes the file exclusively and
 * whose handle is one per process — so there is one database for the
 * whole file and tests are isolated by plugin id instead. Each test
 * purges what it wrote.
 *
 * Needs the bundled Firebird; skipped without it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as native from '@plamenix/native';
import { PluginGrantStore } from '../../src/plugins/grants.js';

/** The full Firebird install both editions ship. */
const FBCLIENT = resolve(
  import.meta.dirname,
  '../../../../../plamenix-desktop/resources/fbclient/v50/Resources/lib/libfbclient.dylib',
);

describe.skipIf(!existsSync(FBCLIENT))('PluginGrantStore', () => {
  let workDir: string;
  let store: PluginGrantStore;
  const written = new Set<string>();

  /** Registers a plugin id for cleanup and returns it. */
  function plugin(id: string): string {
    written.add(id);
    return id;
  }

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'plugin-grant-store-'));
    native.initMeta(join(workDir, 'meta.fdb'), FBCLIENT);
    store = new PluginGrantStore();
  });

  afterEach(async () => {
    for (const id of written) await store.purgePlugin(id);
    written.clear();
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reads empty for a plugin that was never granted anything', async () => {
    expect(await store.list('any.plugin')).toEqual([]);
  });

  it('persists grants idempotently', async () => {
    // Install dialogs may re-prompt across updates, so a second grant of
    // the same capability has to be a no-op and not a primary-key
    // violation surfaced to the user as a failed approval.
    const id = plugin('idempotent.hello');
    await store.add(id, 'db.schema.list', ['db.schema.list']);
    await store.add(id, 'db.schema.list', ['db.schema.list']);

    expect(await store.list(id)).toEqual(['db.schema.list']);
  });

  it('removes grants without surfacing errors for absent rows', async () => {
    const id = plugin('removes.plg');
    await store.add(id, 'db.schema.list', ['db.schema.list']);
    await store.remove(id, 'db.schema.list');
    expect(await store.list(id)).toEqual([]);
    // A revoke of something never granted satisfies the caller's intent.
    await expect(store.remove(id, 'never.granted')).resolves.toBeUndefined();
  });

  it('groups all grants by plugin id for bulk replay', async () => {
    const one = plugin('grouping.one');
    const two = plugin('grouping.two');
    await store.add(one, 'db.schema.list', ['db.schema.list']);
    await store.add(one, 'clipboard.read', ['clipboard.read']);
    await store.add(two, 'net.https', ['net.https']);

    const all = await store.listAll();
    expect(all.get(one)).toEqual(expect.arrayContaining(['db.schema.list', 'clipboard.read']));
    expect(all.get(two)).toEqual(['net.https']);
  });

  it('purges every grant for one plugin without touching others', async () => {
    const keep = plugin('purge.keep');
    const purge = plugin('purge.target');
    await store.add(keep, 'db.schema.list', ['db.schema.list']);
    await store.add(purge, 'clipboard.read', ['clipboard.read']);
    await store.add(purge, 'net.https', ['net.https']);

    await store.purgePlugin(purge);

    expect(await store.list(purge)).toEqual([]);
    expect(await store.list(keep)).toHaveLength(1);
  });

  it('holds no per-instance state, so the boot replay reads what routes wrote', async () => {
    // What `bootstrapPlugins` depends on: a `PluginGrantStore` built at
    // startup sees grants a request-time instance persisted. It proves
    // the class is a handle on shared storage and not a cache.
    //
    // It does not prove durability across a process restart — the
    // engine handle is per-process and cannot be reopened here. The
    // durability claim rests on the store being a database file, which
    // `plamenix-meta`'s own tests exercise directly.
    const id = plugin('replay.hello');
    await new PluginGrantStore().add(id, 'db.schema.list', ['db.schema.list']);
    await new PluginGrantStore().add(id, 'clipboard.read', ['clipboard.read']);

    const grants = await new PluginGrantStore().list(id);
    expect(grants).toEqual(expect.arrayContaining(['db.schema.list', 'clipboard.read']));
    expect(grants).toHaveLength(2);
  });

  it('refuses a capability the manifest never declared', async () => {
    // The store validates scope, not grammar: a well-formed capability
    // the plugin never asked for must not become a grant, because the
    // user was never shown it to approve.
    const id = plugin('undeclared.plg');
    await expect(store.add(id, 'db.write.any', ['db.read.any'])).rejects.toThrow(
      /does not declare/,
    );
    expect(await store.list(id)).toHaveLength(0);
  });

  it('rejects nothing about permission shape — grammar validation is the napi binding job', async () => {
    // Documenting the boundary: this store treats permission strings
    // as opaque keys. Capability-grammar validation happens at the
    // route layer (via the napi binding's `grant_permission` which
    // calls `Permission::parse`) before any call into this store.
    const id = plugin('opaque.plg');
    const odd = 'this.is.not.valid.but.store.does.not.know';
    await expect(store.add(id, odd, [odd])).resolves.toBeUndefined();
  });
});
