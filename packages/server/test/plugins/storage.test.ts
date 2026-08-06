import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafePluginId,
  ensurePluginDataDir,
  pluginDataDir,
  pluginRootDir,
} from '../../src/plugins/storage.js';

describe('plugin storage helpers', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'plugin-storage-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('assertSafePluginId', () => {
    it.each([
      ['empty', ''],
      ['parent traversal', '..'],
      ['forward slash', 'a/b'],
      ['backslash', 'a\\b'],
      ['null byte', 'has\0null'],
    ])('rejects %s', (_label, bad) => {
      expect(() => assertSafePluginId(bad)).toThrow();
    });

    it.each([
      ['reverse-DNS', 'dev.plamenix.hello'],
      ['short namespace', 'plg'],
      ['dashed segment', 'com.example.csv-export'],
      ['digits', 'org.example.plg123'],
    ])('accepts %s', (_label, ok) => {
      expect(() => assertSafePluginId(ok)).not.toThrow();
    });
  });

  describe('path resolution', () => {
    it('joins root + id for the plugin root dir', () => {
      const root = pluginRootDir(workDir, 'dev.plamenix.hello');
      expect(root).toBe(join(workDir, 'dev.plamenix.hello'));
    });

    it('appends data/ for the writable subdirectory', () => {
      const dir = pluginDataDir(workDir, 'dev.plamenix.hello');
      expect(dir).toBe(join(workDir, 'dev.plamenix.hello', 'data'));
    });

    it('propagates the safe-id check', () => {
      expect(() => pluginRootDir(workDir, '..')).toThrow();
      expect(() => pluginDataDir(workDir, 'a/b')).toThrow();
    });
  });

  describe('ensurePluginDataDir', () => {
    it('creates the directory with mode 0o700', async () => {
      const dir = await ensurePluginDataDir(workDir, 'dev.plamenix.hello');
      const stat = statSync(dir);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it('is idempotent — second call returns the same path without erroring', async () => {
      const first = await ensurePluginDataDir(workDir, 'dev.plamenix.hello');
      const second = await ensurePluginDataDir(workDir, 'dev.plamenix.hello');
      expect(second).toBe(first);
    });

    it('creates per-plugin isolation (siblings cannot reach each other via this API)', async () => {
      const dirA = await ensurePluginDataDir(workDir, 'plg.one');
      const dirB = await ensurePluginDataDir(workDir, 'plg.two');
      expect(dirA).not.toBe(dirB);
    });
  });
});
