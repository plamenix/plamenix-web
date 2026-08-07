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
import { spaRoute } from './routes/spa.js';
import { transactionRoute } from './routes/transaction.js';
import { HistoryStore } from './history/store.js';
import { ProfileStore } from './profiles/store.js';
import { bootstrapPlugins } from './plugins/host.js';
import { PluginGrantStore } from './plugins/grants.js';
import type { Env } from './env.js';
import * as fbclient from '@plamenix/native';
import { installSecurityGate } from './security/gate.js';
import { resolveToken } from './security/token.js';
import { reapIdleSessions, sessionStore } from './sessions/store.js';

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

  // Before any route. Host allowlist closes DNS rebinding, which
  // loopback binding does not; the bearer token closes other processes
  // on the same machine, which loopback also does not.
  const auth = resolveToken(env.AUTH_TOKEN);
  installSecurityGate(app, { token: auth.token, allowedHosts: env.ALLOWED_HOSTS });
  app.decorate('authToken', auth.token);
  app.decorate('authTokenSource', auth.source);

  // Keeps a session alive for as long as it is being used. Done once
  // here rather than at each of the six routes that name a session: a
  // route added later would otherwise be reaped mid-use, and nothing
  // about that failure would point at the missing line.
  app.addHook('preHandler', async (request) => {
    const body: unknown = request.body;
    if (body !== null && typeof body === 'object' && 'sessionId' in body) {
      const id = (body as { sessionId?: unknown }).sessionId;
      if (typeof id === 'string') sessionStore.touch(id);
    }
  });

  const profileStore = new ProfileStore(env.PROFILES_PATH);
  const historyStore = new HistoryStore(env.HISTORY_PATH);
  const pluginGrantStore = new PluginGrantStore(env.PLUGIN_GRANTS_PATH);

  await app.register(pingRoute);
  await app.register(connectRoute(env));
  await app.register(executeRoute(historyStore));
  await app.register(exportRoute(env));
  await app.register(transactionRoute);
  await app.register(profilesRoute(profileStore, env));
  await app.register(historyRoute(historyStore));
  await app.register(
    pluginsRoute({
      grantStore: pluginGrantStore,
      pluginDataRoot: env.PLUGIN_DATA_ROOT,
    }),
  );

  // Idle attachments are closed rather than held until the process
  // exits. `unref` so the timer never keeps Node alive on shutdown.
  const sweep = setInterval(() => {
    void reapIdleSessions(env.SESSION_IDLE_MS, {
      close: async (id) => {
        await fbclient.close(id);
      },
      onError: (id, err) => {
        app.log.warn({ sessionId: id, err }, 'closing an idle session failed');
      },
    }).then((result) => {
      if (result.expired.length > 0) {
        app.log.info({ count: result.expired.length }, 'closed idle sessions');
      }
    });
  }, env.SESSION_SWEEP_MS);
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
  });

  // Last, so its catch-all not-found handler does not shadow the API.
  if (env.CLIENT_DIST !== undefined && env.CLIENT_DIST !== '') {
    await app.register(spaRoute({ clientDist: env.CLIENT_DIST, token: auth.token }));
  }

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
