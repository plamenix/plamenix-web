// In-memory session store. Each entry remembers a Firebird attachment
// held inside `@plamenix/native`. The native binding owns the actual
// connection; this store tracks bookkeeping so idle attachments can be
// closed.
//
// Reaping is the point of the `lastUsedAt` field. Without it a session
// lived until the process did: a browser tab closed, a laptop slept, a
// client crashed — and the Firebird attachment stayed open, holding its
// transaction and its share of the server's connection limit. Nothing
// ever closed one except an explicit call the client had to survive
// long enough to make.

/** One tracked attachment. */
export interface Session {
  id: string;
  createdAt: number;
  /** Touched on every request that names this session. Idle time is
   *  measured from here, not from `createdAt` — a session in constant
   *  use is not stale however old it is. */
  lastUsedAt: number;
}

/** How a reap decided to close something, for the caller to log. */
export interface ReapResult {
  /** Sessions whose idle time exceeded the limit. */
  expired: string[];
}

class SessionStore {
  private readonly sessions = new Map<string, Session>();

  register(id: string): Session {
    const now = Date.now();
    const session: Session = { id, createdAt: now, lastUsedAt: now };
    this.sessions.set(id, session);
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Records activity. Call on every request that uses a session. */
  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastUsedAt = Date.now();
  }

  drop(id: string): boolean {
    return this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }

  /** Ids idle for longer than `idleMs`, without removing them. */
  idleFor(idleMs: number, now: number = Date.now()): string[] {
    const stale: string[] = [];
    for (const session of this.sessions.values()) {
      if (now - session.lastUsedAt >= idleMs) stale.push(session.id);
    }
    return stale;
  }

  /** Test seam: force a session's idle clock backwards. */
  setLastUsedForTest(id: string, lastUsedAt: number): void {
    const session = this.sessions.get(id);
    if (session) session.lastUsedAt = lastUsedAt;
  }

  clearForTest(): void {
    this.sessions.clear();
  }
}

export const sessionStore = new SessionStore();

/** What a reaper needs, kept narrow so tests supply their own. */
export interface ReaperDeps {
  /** Closes the underlying attachment. */
  close(sessionId: string): Promise<void>;
  /** Reports a close that failed. */
  onError(sessionId: string, err: unknown): void;
}

/**
 * Closes sessions idle longer than `idleMs`.
 *
 * A close that fails still drops the bookkeeping entry. The attachment
 * is already unreachable — the client that owned it is gone — and
 * keeping the record would mean retrying the same failing close on
 * every sweep forever.
 */
export async function reapIdleSessions(
  idleMs: number,
  deps: ReaperDeps,
  store: SessionStore = sessionStore,
): Promise<ReapResult> {
  const expired = store.idleFor(idleMs);
  for (const id of expired) {
    store.drop(id);
    try {
      await deps.close(id);
    } catch (err) {
      deps.onError(id, err);
    }
  }
  return { expired };
}
