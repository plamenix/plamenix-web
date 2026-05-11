import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const connectBody = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(3050),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  encryptionKey: z.string().optional(),
  fbclientPath: z.string().optional(),
  encryptionRequired: z.boolean().default(false),
});

export async function connectRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/connect', async (request, reply) => {
    const parsed = connectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    // TODO: call into @plamenix/fbclient-node once the native binary is built.
    // The stub binding currently throws, so connect() is parked behind a
    // feature flag in M1 until plamenix-db lands.
    return reply.code(501).send({
      error: 'not_implemented',
      message: 'connect lands after plamenix-db crate ships',
    });
  });
}
