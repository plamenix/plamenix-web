import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { pingRoute } from './routes/ping.js';
import { connectRoute } from './routes/connect.js';
import { executeRoute } from './routes/execute.js';
import { exportRoute } from './routes/export.js';
import { historyRoute } from './routes/history.js';
import { profilesRoute } from './routes/profiles.js';
import { pluginsRoute } from './routes/plugins.js';
import { HistoryStore } from './history/store.js';
import { ProfileStore } from './profiles/store.js';
import { bootstrapPlugins } from './plugins/host.js';
import { PluginGrantStore } from './plugins/grants.js';
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
  const historyStore = new HistoryStore(env.HISTORY_PATH);
  const pluginGrantStore = new PluginGrantStore(env.PLUGIN_GRANTS_PATH);

  await app.register(pingRoute);
  await app.register(connectRoute);
  await app.register(executeRoute(historyStore));
  await app.register(exportRoute);
  await app.register(profilesRoute(profileStore));
  await app.register(historyRoute(historyStore));
  await app.register(
    pluginsRoute({
      grantStore: pluginGrantStore,
      pluginDataRoot: env.PLUGIN_DATA_ROOT,
    }),
  );

  await bootstrapPlugins({
    pluginsDir: env.PLUGINS_PATH,
    pluginDataRoot: env.PLUGIN_DATA_ROOT,
    grantStore: pluginGrantStore,
    log: {
      info: (msg, meta) => app.log.info(meta ?? {}, msg),
      warn: (msg, meta) => app.log.warn(meta ?? {}, msg),
      error: (msg, meta) => app.log.error(meta ?? {}, msg),
    },
  });

  return app;
}
