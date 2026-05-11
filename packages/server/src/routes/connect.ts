import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/fbclient-node';
import { sessionStore } from '../sessions/store.js';

const connectBody = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(3050),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  encryptionKey: z.string().optional(),
  fbclientPath: z.string().optional(),
  encryptionRequired: z.boolean().default(false),
  pureRust: z.boolean().default(false),
});

export async function connectRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/connect', async (request, reply) => {
    const parsed = connectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    try {
      const handle = await fbclient.connect(parsed.data);
      sessionStore.register(handle.sessionId);
      return { sessionId: handle.sessionId };
    } catch (err) {
      app.log.warn({ err }, 'connect failed');
      return reply.code(502).send({
        error: 'connect_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
