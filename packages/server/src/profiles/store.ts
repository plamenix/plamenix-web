// JSON-file backed connection profile store for the web edition.
//
// The web edition never stores secrets server-side: a profile holds
// host/port/database/user plus a couple of behaviour flags, and the
// caller supplies the password (and optional encryption key) afresh on
// every `/api/profiles/:id/connect` request. This keeps the server
// stateless from a credential standpoint and dodges the keyring
// availability problem in headless / containerised deployments.

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  encryptionRequired: boolean;
  pureRust: boolean;
  /** Optional accent-palette id used by the UI to tint this profile's
   *  tabs and status dot. */
  color?: string | null;
  /** Epoch milliseconds (UTC) when this profile was first saved.
   *  Stable across edits. Older profiles without the field
   *  deserialise as `0`. */
  createdAt?: number;
  /** Epoch milliseconds (UTC) of the most recent successful connect.
   *  `null` until the user has connected at least once. */
  lastUsedAt?: number | null;
  /** Epoch milliseconds (UTC) of the most recent explicit Disconnect
   *  against a session opened from this profile. `null` until the user
   *  has actively disconnected at least once. */
  lastDisconnectedAt?: number | null;
  /** Optional absolute path to the Firebird native client library
   *  (`libfbclient.so` / `.dylib` / `fbclient.dll`). When set, the
   *  connect call hands it to rsfbclient's `with_dyn_load`. Ignored
   *  when `pureRust` is true. */
  fbclientPath?: string | null;
  /** Wire charset for the session. `null` (or missing) falls back to
   *  `UTF8`. Accepted values match `rsfbclient_core::Charset::from_str`. */
  charset?: string | null;
}

export type ProfileDraft = Omit<Profile, 'id'> & { id?: string };

interface ProfilesFile {
  profiles: Profile[];
}

export class ProfileStore {
  constructor(private readonly path: string) {}

  async list(): Promise<Profile[]> {
    try {
      const text = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as ProfilesFile;
      return parsed.profiles ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async get(id: string): Promise<Profile | null> {
    const all = await this.list();
    return all.find((p) => p.id === id) ?? null;
  }

  async save(input: ProfileDraft): Promise<Profile> {
    const all = await this.list();
    const now = Date.now();
    const existing = input.id ? all.find((p) => p.id === input.id) : undefined;
    const profile: Profile = {
      id: input.id ?? randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port,
      database: input.database,
      user: input.user,
      encryptionRequired: input.encryptionRequired,
      pureRust: input.pureRust,
      color: input.color ?? null,
      createdAt: existing?.createdAt && existing.createdAt > 0 ? existing.createdAt : now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      lastDisconnectedAt: existing?.lastDisconnectedAt ?? null,
      fbclientPath:
        typeof input.fbclientPath === 'string' && input.fbclientPath.length > 0
          ? input.fbclientPath
          : null,
      charset:
        typeof input.charset === 'string' && input.charset.length > 0
          ? input.charset
          : null,
    };
    const idx = all.findIndex((p) => p.id === profile.id);
    if (idx >= 0) all[idx] = profile;
    else all.push(profile);
    await this.writeAtomic({ profiles: all });
    return profile;
  }

  /** Stamps `lastUsedAt` on the profile with the supplied id. Called
   *  after a successful connect-by-profile. No-op when the id is
   *  unknown. */
  async touch(id: string): Promise<void> {
    const all = await this.list();
    const profile = all.find((p) => p.id === id);
    if (!profile) return;
    profile.lastUsedAt = Date.now();
    await this.writeAtomic({ profiles: all });
  }

  /** Stamps `lastDisconnectedAt` on the profile with the supplied id.
   *  Called after an explicit Disconnect. No-op when the id is
   *  unknown. */
  async touchDisconnected(id: string): Promise<void> {
    const all = await this.list();
    const profile = all.find((p) => p.id === id);
    if (!profile) return;
    profile.lastDisconnectedAt = Date.now();
    await this.writeAtomic({ profiles: all });
  }

  async delete(id: string): Promise<void> {
    const all = await this.list();
    const filtered = all.filter((p) => p.id !== id);
    if (filtered.length !== all.length) {
      await this.writeAtomic({ profiles: filtered });
    }
  }

  private async writeAtomic(payload: ProfilesFile): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, this.path);
  }
}
