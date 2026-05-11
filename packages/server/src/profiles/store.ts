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
    const profile: Profile = {
      id: input.id ?? randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port,
      database: input.database,
      user: input.user,
      encryptionRequired: input.encryptionRequired,
      pureRust: input.pureRust,
    };
    const idx = all.findIndex((p) => p.id === profile.id);
    if (idx >= 0) all[idx] = profile;
    else all.push(profile);
    await this.writeAtomic({ profiles: all });
    return profile;
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
