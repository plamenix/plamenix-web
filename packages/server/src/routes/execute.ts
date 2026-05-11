import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/fbclient-node';
import { sessionStore } from '../sessions/store.js';

const executeBody = z.object({
  sessionId: z.string().uuid(),
  sql: z.string().min(1),
});

export async function executeRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/execute', async (request, reply) => {
    const parsed = executeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    if (!sessionStore.has(parsed.data.sessionId)) {
      return reply.code(404).send({ error: 'unknown_session' });
    }

    try {
      const result = await fbclient.execute(parsed.data.sessionId, parsed.data.sql);
      return result;
    } catch (err) {
      app.log.warn({ err }, 'execute failed');
      return reply.code(502).send({
        error: 'execute_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
}
