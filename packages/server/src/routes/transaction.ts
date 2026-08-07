import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/native';
import { sessionStore } from '../sessions/store.js';

/** Mirrors `TxIsolation`. `consistency` is deliberately not offered: it
 *  takes table-level locks and is too easy to fire at a shared server. */
const isolation = z.enum(['readCommitted', 'snapshot']);

/** Mirrors `TxLocking`. `wait` carries an optional timeout in seconds;
 *  omitting it means an unbounded wait. */
const locking = z.union([
  z.object({ kind: z.literal('noWait') }),
  z.object({ kind: z.literal('wait'), timeoutSecs: z.number().int().positive().nullable() }),
]);

const sessionBody = z.object({ sessionId: z.string().uuid() });

const modeBody = sessionBody.extend({
  mode: z.enum(['autocommit', 'manual']),
  /** Omit to keep the session's current settings. */
  config: z.object({ isolation, locking }).optional(),
});

/**
 * Transaction control for the web edition.
 *
 * Every route resolves to the session's `TxStatus`, so a client can
 * drive its indicator from the response rather than following up with a
 * status call.
 */
export async function transactionRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/transaction/mode', async (request, reply) => {
    const parsed = modeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (!sessionStore.has(parsed.data.sessionId)) {
      return reply.code(404).send({ error: 'unknown_session' });
    }
    try {
      return await fbclient.setTransactionMode(
        parsed.data.sessionId,
        parsed.data.mode,
        parsed.data.config,
      );
    } catch (err) {
      // A refused mode change is the caller's mistake, not a server
      // fault: the driver rejects it while a transaction is open so no
      // work is silently committed or discarded.
      return reply.code(409).send({ error: 'transaction_conflict', message: String(err) });
    }
  });

  for (const [path, call] of [
    ['begin', fbclient.beginTransaction],
    ['commit', fbclient.commitTransaction],
    ['rollback', fbclient.rollbackTransaction],
  ] as const) {
    app.post(`/api/transaction/${path}`, async (request, reply) => {
      const parsed = sessionBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      if (!sessionStore.has(parsed.data.sessionId)) {
        return reply.code(404).send({ error: 'unknown_session' });
      }
      try {
        return await call(parsed.data.sessionId);
      } catch (err) {
        return reply.code(409).send({ error: 'transaction_conflict', message: String(err) });
      }
    });
  }

  app.post('/api/transaction/status', async (request, reply) => {
    const parsed = sessionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (!sessionStore.has(parsed.data.sessionId)) {
      return reply.code(404).send({ error: 'unknown_session' });
    }
    return await fbclient.transactionStatus(parsed.data.sessionId);
  });
}
