import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { pingRoute } from './routes/ping.js';
import { connectRoute } from './routes/connect.js';
import { executeRoute } from './routes/execute.js';
import { profilesRoute } from './routes/profiles.js';
import { ProfileStore } from './profiles/store.js';
import type { Env } from './env.js';

// `Fastify(...)` returns a richer generic than the bare `FastifyInstance`
// alias; letting TS infer the return type from the body avoids a
// Http2SecureServer / RawServerDefault mismatch under `exactOptionalPropertyTypes`.
export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(env: Env) {
  const logger:
    | {
        level: typeof env.LOG_LEVEL;
        transport?: { target: string; options: { translateTime: string } };
      } = { level: env.LOG_LEVEL };
  if (env.NODE_ENV === 'development') {
    logger.transport = { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } };
  }

  const app = Fastify({ logger, disableRequestLogging: false });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.NODE_ENV === 'development' ? true : false });
  await app.register(sensible);

  const profileStore = new ProfileStore(env.PROFILES_PATH);

  await app.register(pingRoute);
  await app.register(connectRoute);
  await app.register(executeRoute);
  await app.register(profilesRoute(profileStore));

  return app;
}
