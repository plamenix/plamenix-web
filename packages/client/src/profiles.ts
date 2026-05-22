// Profile-REST helpers for the web client.
//
// The shared `fetchTransport` is a thin JSON-RPC-shaped wrapper over
// `POST /api/<command>`; profile endpoints use plain REST (path params,
// DELETE). Rather than bloat `Transport` with HTTP-method/path concepts,
// we drop down to raw `fetch` here. Desktop never exercises these
// helpers — it goes through Tauri commands instead.

import type { Profile } from '@plamenix/ui';

export interface ProfileDraft {
  id?: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  encryptionRequired: boolean;
  pureRust: boolean;
  color?: string | null;
  /** Absolute path to a native Firebird client library. Omit / empty
   *  for auto-detect. */
  fbclientPath?: string;
  /** Wire charset (`UTF8`, `WIN1250`, …). Omit / empty falls back to
   *  `UTF8`. */
  charset?: string;
}

export interface ProfileConnectArgs {
  password: string;
  encryptionKey?: string;
  pureRust?: boolean;
  encryptionRequired?: boolean;
  fbclientPath?: string;
  charset?: string;
}

async function expectOk(response: Response, label: string): Promise<void> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${label} failed (${response.status}): ${text}`);
  }
}

export async function listProfiles(): Promise<Profile[]> {
  const res = await fetch('/api/profiles');
  await expectOk(res, 'list profiles');
  const body = (await res.json()) as { profiles: Profile[] };
  return body.profiles;
}

export async function saveProfile(draft: ProfileDraft): Promise<Profile> {
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  await expectOk(res, 'save profile');
  const body = (await res.json()) as { profile: Profile };
  return body.profile;
}

export async function deleteProfile(id: string): Promise<void> {
  const res = await fetch(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await expectOk(res, 'delete profile');
}

export async function touchProfileDisconnected(id: string): Promise<void> {
  const res = await fetch(
    `/api/profiles/${encodeURIComponent(id)}/touch-disconnected`,
    { method: 'POST' },
  );
  await expectOk(res, 'touch profile disconnected');
}

export async function connectByProfile(
  id: string,
  args: ProfileConnectArgs,
): Promise<{ sessionId: string }> {
  const res = await fetch(`/api/profiles/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  await expectOk(res, 'profile connect');
  return (await res.json()) as { sessionId: string };
}
