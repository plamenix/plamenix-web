// In-memory session store for M1. Each session owns one Firebird
// attachment plus its per-tab metadata. Swap for Redis or a similar
// shared store in M2 when multi-instance deployment is in scope.

export interface Session {
  id: string;
  createdAt: number;
  // database handle lands here once @plamenix/fbclient-node exposes it
}

class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(id: string): Session {
    const session: Session = { id, createdAt: Date.now() };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  drop(id: string): boolean {
    return this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }
}

export const sessionStore = new SessionStore();
