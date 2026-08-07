import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fbclient from '@plamenix/native';
import type { ConnectionConfig } from '@plamenix/native';
import { sessionStore } from '../sessions/store.js';
import type { Env } from '../env.js';

const connectBody = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(3050),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  encryptionKey: z.string().optional(),
  charset: z.string().optional(),
  encryptionRequired: z.boolean().default(false),
  pureRust: z.boolean().default(false),
});

/**
 * `POST /api/connect`.
 *
 * Takes the `fbclient` library path from server configuration, never
 * from the request. The body used to carry `fbclientPath`, and
 * `resolve_fbclient_path` gives an explicit config value precedence
 * over the server's own environment variable — so anyone who could
 * reach this endpoint could name any file on the server's filesystem
 * and have the process dlopen it. There is no authentication on this
 * route, and until recently the server bound to 0.0.0.0.
 *
 * Which library a server loads is the operator's decision. A client
 * asking for one is never a question worth honouring.
 */
export function connectRoute(env: Env) {
  return async function register(app: FastifyInstance): Promise<void> {
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
      if (env.FBCLIENT_PATH !== undefined) {
        config.fbclientPath = env.FBCLIENT_PATH;
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
  };
}
