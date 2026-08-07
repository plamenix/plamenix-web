import * as fbclient from '@plamenix/native';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // Bootstrap the Rust-side tracing subscriber before any driver call so
  // the very first `connect`/`execute` produces structured spans. The
  // OTLP exporter only attaches when `OTEL_EXPORTER_OTLP_ENDPOINT` is
  // set in the environment.
  try {
    const status = fbclient.initTracing();
    process.stderr.write(`fbclient-node tracing: ${status}\n`);
  } catch (err) {
    process.stderr.write(`fbclient-node tracing init failed: ${String(err)}\n`);
  }

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
