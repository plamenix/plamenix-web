/**
 * Idle sessions get closed.
 *
 * Before this, a session lived until the process did. A closed tab, a
 * slept laptop, a crashed client — the Firebird attachment stayed open,
 * holding its transaction and its share of the server's connection
 * limit, and nothing closed it except an explicit call the client had
 * to survive long enough to make.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reapIdleSessions, sessionStore } from '../src/sessions/store.js';

const IDLE_MS = 30 * 60 * 1000;

function deps() {
  return {
    close: vi.fn(async () => {}),
    onError: vi.fn(),
  };
}

describe('idle session reaping', () => {
  beforeEach(() => {
    sessionStore.clearForTest();
  });

  it('closes a session idle past the limit', async () => {
    sessionStore.register('stale');
    sessionStore.setLastUsedForTest('stale', Date.now() - IDLE_MS - 1);

    const d = deps();
    const result = await reapIdleSessions(IDLE_MS, d);

    expect(result.expired).toEqual(['stale']);
    expect(d.close).toHaveBeenCalledWith('stale');
    expect(sessionStore.has('stale')).toBe(false);
  });

  it('leaves a session that is still being used', async () => {
    sessionStore.register('busy');

    const d = deps();
    const result = await reapIdleSessions(IDLE_MS, d);

    expect(result.expired).toEqual([]);
    expect(d.close).not.toHaveBeenCalled();
    expect(sessionStore.has('busy')).toBe(true);
  });

  it('measures idleness from last use, not from creation', async () => {
    // A session in constant use is not stale however old it is.
    // Reaping on age would disconnect someone mid-session.
    sessionStore.register('long-lived');
    sessionStore.setLastUsedForTest('long-lived', Date.now() - IDLE_MS - 1);
    sessionStore.touch('long-lived');

    const result = await reapIdleSessions(IDLE_MS, deps());
    expect(result.expired).toEqual([]);
  });

  it('drops the record even when the close fails', async () => {
    // The attachment is already unreachable — the client that owned it
    // is gone. Keeping the record would retry the same failing close on
    // every sweep, forever.
    sessionStore.register('doomed');
    sessionStore.setLastUsedForTest('doomed', Date.now() - IDLE_MS - 1);

    const d = {
      close: vi.fn(async () => {
        throw new Error('attachment already gone');
      }),
      onError: vi.fn(),
    };
    await reapIdleSessions(IDLE_MS, d);

    expect(sessionStore.has('doomed')).toBe(false);
    expect(d.onError).toHaveBeenCalled();
  });

  it('sweeps several at once and leaves the rest', async () => {
    sessionStore.register('a');
    sessionStore.register('b');
    sessionStore.register('c');
    sessionStore.setLastUsedForTest('a', Date.now() - IDLE_MS - 1);
    sessionStore.setLastUsedForTest('c', Date.now() - IDLE_MS - 1);

    const result = await reapIdleSessions(IDLE_MS, deps());

    expect(result.expired.sort()).toEqual(['a', 'c']);
    expect(sessionStore.has('b')).toBe(true);
    expect(sessionStore.size()).toBe(1);
  });
});
