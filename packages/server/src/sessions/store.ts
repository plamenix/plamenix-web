// In-memory session store for M1. Each entry remembers a Firebird
// attachment held inside `@plamenix/native`. The native binding
// owns the actual connection; this store tracks bookkeeping (creation
// time, optional metadata) so we can expire stale sessions or report
// active count from the server side.

export interface Session {
  id: string;
  createdAt: number;
}

class SessionStore {
  private readonly sessions = new Map<string, Session>();

  register(id: string): Session {
    const session: Session = { id, createdAt: Date.now() };
    this.sessions.set(id, session);
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  drop(id: string): boolean {
    return this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }
}

export const sessionStore = new SessionStore();
