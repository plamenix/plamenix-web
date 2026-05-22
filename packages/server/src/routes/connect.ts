import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/fbclient-node';
import type { ConnectionConfig } from '@plamenix/fbclient-node';
import { sessionStore } from '../sessions/store.js';

const connectBody = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(3050),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  encryptionKey: z.string().optional(),
  fbclientPath: z.string().optional(),
  charset: z.string().optional(),
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
      const config: ConnectionConfig = {
        host: parsed.data.host,
        port: parsed.data.port,
        database: parsed.data.database,
        user: parsed.data.user,
        password: parsed.data.password,
        encryptionRequired: parsed.data.encryptionRequired,
      };
      if (parsed.data.encryptionKey !== undefined) {
        config.encryptionKey = parsed.data.encryptionKey;
      }
      if (parsed.data.fbclientPath !== undefined) {
        config.fbclientPath = parsed.data.fbclientPath;
      }
      if (parsed.data.charset !== undefined && parsed.data.charset !== '') {
        config.charset = parsed.data.charset;
      }
      if (parsed.data.pureRust) {
        config.pureRust = true;
      }
      const handle = await fbclient.connect(config);
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
