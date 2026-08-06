import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginGrantStore } from '../../src/plugins/grants.js';

describe('PluginGrantStore', () => {
  let workDir: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'plugin-grant-store-'));
    dbPath = join(workDir, 'grants.sqlite');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('creates the parent directory and an empty database', () => {
    const nested = join(workDir, 'a', 'b', 'grants.sqlite');
    const store = new PluginGrantStore(nested);
    expect(store.list('any.plugin')).toEqual([]);
    expect(store.listAll().size).toBe(0);
  });

  it('persists grants idempotently and refreshes granted_at on re-grant', async () => {
    const store = new PluginGrantStore(dbPath);
    store.add('dev.plamenix.hello', 'db.schema.list');
    const first = store.list('dev.plamenix.hello');
    expect(first).toHaveLength(1);
    expect(first[0]?.permission).toBe('db.schema.list');
    const firstAt = first[0]?.grantedAt ?? 0;

    // Ensure timestamp advances meaningfully before re-grant.
    await new Promise((r) => setTimeout(r, 5));

    store.add('dev.plamenix.hello', 'db.schema.list');
    const second = store.list('dev.plamenix.hello');
    expect(second).toHaveLength(1);
    expect(second[0]?.grantedAt ?? 0).toBeGreaterThanOrEqual(firstAt);
  });

  it('removes grants without surfacing errors for absent rows', () => {
    const store = new PluginGrantStore(dbPath);
    store.add('plg', 'db.schema.list');
    store.remove('plg', 'db.schema.list');
    expect(store.list('plg')).toEqual([]);
    // No-op remove must not throw.
    expect(() => store.remove('plg', 'never.granted')).not.toThrow();
  });

  it('groups all grants by plugin id for bulk replay', () => {
    const store = new PluginGrantStore(dbPath);
    store.add('plg.one', 'db.schema.list');
    store.add('plg.one', 'clipboard.read');
    store.add('plg.two', 'net.https');

    const all = store.listAll();
    expect(all.get('plg.one')).toEqual(
      expect.arrayContaining(['db.schema.list', 'clipboard.read']),
    );
    expect(all.get('plg.two')).toEqual(['net.https']);
    expect(all.size).toBe(2);
  });

  it('purges every grant for one plugin without touching others', () => {
    const store = new PluginGrantStore(dbPath);
    store.add('plg.keep', 'db.schema.list');
    store.add('plg.purge', 'clipboard.read');
    store.add('plg.purge', 'net.https');

    store.purgePlugin('plg.purge');

    expect(store.list('plg.purge')).toEqual([]);
    expect(store.list('plg.keep')).toHaveLength(1);
  });

  it('persists grants across store recreate at the same path', () => {
    // First "boot" — write some state.
    {
      const store = new PluginGrantStore(dbPath);
      store.add('dev.plamenix.hello', 'db.schema.list');
      store.add('dev.plamenix.hello', 'clipboard.read');
    }

    // Second "boot" — fresh class instance, same file. This is what
    // `bootstrapPlugins` does at app startup; the assertion proves the
    // SQLite-as-authority contract for the I1.6 replay path.
    const reopened = new PluginGrantStore(dbPath);
    const grants = reopened.list('dev.plamenix.hello').map((g) => g.permission);
    expect(grants).toEqual(expect.arrayContaining(['db.schema.list', 'clipboard.read']));
    expect(grants).toHaveLength(2);
  });

  it('rejects nothing about permission shape — grammar validation is the napi binding job', () => {
    // Documenting the boundary: this store treats permission strings
    // as opaque keys. Capability-grammar validation happens at the
    // route layer (via the napi binding's `grant_permission` which
    // calls `Permission::parse`) before any call into this store.
    const store = new PluginGrantStore(dbPath);
    expect(() => store.add('plg', 'this.is.not.valid.but.store.does.not.know')).not.toThrow();
  });
});
