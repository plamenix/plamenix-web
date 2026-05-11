import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { pingRoute } from './routes/ping.js';
import { connectRoute } from './routes/connect.js';
import type { Env } from './env.js';

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } }
          : undefined,
    },
    disableRequestLogging: false,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.NODE_ENV === 'development' ? true : false });
  await app.register(sensible);

  await app.register(pingRoute);
  await app.register(connectRoute);

  return app;
}
