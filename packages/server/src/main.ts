import { buildApp } from './app.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start plamenix-web server');
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }
}

await main();
