import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/native';
import * as pluginHost from '@plamenix/native';
import { sessionStore } from '../sessions/store.js';
import type { HistoryStore } from '../history/store.js';
import type { PushEvent } from '../events/channel.js';

const executeBody = z.object({
  sessionId: z.string().uuid(),
  sql: z.string().min(1),
  /** Optional. When provided, the batch is recorded to the
   *  per-profile history store. Internal queries (DDL viewer source,
   *  table-fetch-for-export, COUNT(*) helpers) omit this so they do
   *  not pollute the user-facing history. */
  profileId: z.string().min(1).optional(),
  /** Per-profile retention cap. Positive integers trim the history to
   *  the most recent `N` rows after the insert; `null` or omitted means
   *  unlimited (no trim). Ignored when `profileId` is absent. */
  historyLimit: z.number().int().positive().nullable().optional(),
});

export function executeRoute(history: HistoryStore, push?: (event: PushEvent) => void) {
  return async function (app: FastifyInstance): Promise<void> {
    app.post('/api/execute', async (request, reply) => {
      const parsed = executeBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      if (!sessionStore.has(parsed.data.sessionId)) {
        return reply.code(404).send({ error: 'unknown_session' });
      }

      const profileId = parsed.data.profileId;
      const historyLimit = parsed.data.historyLimit ?? null;
      const startedAt = Date.now();
      try {
        const outcomes = await fbclient.executeBatch(
          parsed.data.sessionId,
          parsed.data.sql,
        );
        if (profileId) {
          recordOutcomeBatch(
            history,
            app.log,
            profileId,
            parsed.data.sql,
            startedAt,
            outcomes,
            historyLimit,
          );
        }
        // Mirrors the desktop shell's first producer. Dispatch failures
        // are reported by the host rather than thrown, so a plugin
        // trapping on this event cannot fail the user's query.
        const executed = {
          statements: Array.isArray(outcomes) ? outcomes.length : 0,
          sessionId: parsed.data.sessionId,
        };
        try {
          await pluginHost.emitEvent('db/query/executed', JSON.stringify(executed));
        } catch (err) {
          app.log.warn({ err }, 'failed to dispatch db/query/executed');
        }
        // Same event, out to any attached browser. The desktop shell
        // gets this through Tauri events; without this the web edition
        // would dispatch to plugins and tell its own UI nothing.
        push?.({ topic: 'db/query/executed', payload: executed });

        return outcomes;
      } catch (err) {
        if (profileId) {
          fireAndForget(
            history.record({
              profileId,
              sql: parsed.data.sql,
              durationMs: Date.now() - startedAt,
              status: 'err',
              error: err instanceof Error ? err.message : String(err),
              rowCount: null,
              limit: historyLimit,
            }),
            app.log,
          );
        }
        app.log.warn({ err }, 'execute failed');
        return reply.code(502).send({
          error: 'execute_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

  app.post('/api/test-connection', async (request, reply) => {
    try {
      const result = await fbclient.testConnection(request.body as fbclient.ConnectionConfig);
      return result;
    } catch (err) {
      app.log.warn({ err }, 'test-connection failed');
      return reply.code(400).send({
        error: 'test_connection_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/list-aliases', async () => {
    return fbclient.listAliases();
  });

  app.post('/api/close', async (request, reply) => {
    const sessionId = (request.body as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== 'string') {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    try {
      await fbclient.close(sessionId);
      sessionStore.drop(sessionId);
      return { closed: true };
    } catch (err) {
      app.log.warn({ err }, 'close failed');
      return reply.code(502).send({
        error: 'close_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/crypt-state', async (request, reply) => {
    const sessionId = (request.body as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== 'string' || !sessionStore.has(sessionId)) {
      return reply.code(400).send({ error: 'invalid_session' });
    }
    try {
      const state = await fbclient.cryptState(sessionId);
      return { state };
    } catch (err) {
      app.log.warn({ err }, 'crypt-state failed');
      return reply.code(502).send({
        error: 'crypt_state_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/describe-schema', async (request, reply) => {
    const sessionId = (request.body as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== 'string' || !sessionStore.has(sessionId)) {
      return reply.code(400).send({ error: 'invalid_session' });
    }
    try {
      const schema = await fbclient.describeSchema(sessionId);
      return schema;
    } catch (err) {
      app.log.warn({ err }, 'describe-schema failed');
      return reply.code(502).send({
        error: 'describe_schema_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/ping-session', async (request, reply) => {
    const sessionId = (request.body as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== 'string' || !sessionStore.has(sessionId)) {
      return reply.code(400).send({ error: 'invalid_session' });
    }
    try {
      const { engineVersion } = await fbclient.pingSession(sessionId);
      return { engineVersion };
    } catch (err) {
      app.log.warn({ err }, 'ping-session failed');
      return reply.code(502).send({
        error: 'ping_session_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/fetch-blob', async (request, reply) => {
    const body = request.body as { sessionId?: unknown; blobId?: unknown } | null;
    const sessionId = body?.sessionId;
    const blobId = body?.blobId;
    if (typeof sessionId !== 'string' || !sessionStore.has(sessionId)) {
      return reply.code(400).send({ error: 'invalid_session' });
    }
    if (typeof blobId !== 'string' || blobId.length === 0) {
      return reply.code(400).send({ error: 'invalid_blob_id' });
    }
    try {
      const hex = await fbclient.fetchBlob(sessionId, blobId);
      return { hex };
    } catch (err) {
      app.log.warn({ err }, 'fetch-blob failed');
      return reply.code(502).send({
        error: 'fetch_blob_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

    app.post('/api/database-stats', async (request, reply) => {
      const sessionId = (request.body as { sessionId?: unknown })?.sessionId;
      if (typeof sessionId !== 'string' || !sessionStore.has(sessionId)) {
        return reply.code(400).send({ error: 'invalid_session' });
      }
      try {
        const stats = await fbclient.databaseStats(sessionId);
        return stats;
      } catch (err) {
        app.log.warn({ err }, 'database-stats failed');
        return reply.code(502).send({
          error: 'database_stats_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };
}

interface StatementOutcomeShape {
  status?: string;
  error?: string;
  result?: {
    Rows?: { rows?: unknown[] };
    Affected?: { rows?: number };
  };
}

/** Distills the trailing outcome of a multi-statement batch into a
 *  single history row. Matches the desktop behavior where each
 *  user-initiated execute produces exactly one history entry regardless
 *  of how many statements the batch contained. */
function recordOutcomeBatch(
  history: HistoryStore,
  log: FastifyBaseLogger,
  profileId: string,
  sql: string,
  startedAt: number,
  outcomes: unknown,
  limit: number | null,
): void {
  const durationMs = Date.now() - startedAt;
  const base = { profileId, sql, durationMs, limit };

  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    fireAndForget(
      history.record({ ...base, status: 'ok', error: null, rowCount: null }),
      log,
    );
    return;
  }

  const failed = (outcomes as StatementOutcomeShape[]).find((o) => o?.status === 'err');
  if (failed) {
    fireAndForget(
      history.record({
        ...base,
        status: 'err',
        error: failed.error ?? 'execution failed',
        rowCount: null,
      }),
      log,
    );
    return;
  }

  const last = outcomes[outcomes.length - 1] as StatementOutcomeShape;
  let rowCount: number | null = null;
  if (last?.result?.Rows) {
    rowCount = last.result.Rows.rows?.length ?? null;
  } else if (last?.result?.Affected) {
    rowCount = last.result.Affected.rows ?? null;
  }
  fireAndForget(history.record({ ...base, status: 'ok', error: null, rowCount }), log);
}

/** Lets a history write finish on its own.
 *
 *  History is a convenience. The statement already ran and the user
 *  already has their rows, so a failed history write is worth a log line
 *  and is not worth turning a successful query into an error — nor worth
 *  making the response wait on a second database round trip. The audit
 *  log is fire-and-forget for the same reason and the opposite stakes.
 */
function fireAndForget(write: Promise<void>, log: FastifyBaseLogger): void {
  void write.catch((err: unknown) => {
    log.warn({ err }, 'could not record query history');
  });
}
