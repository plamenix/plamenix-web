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
    // Said out loud at boot. There is no authentication on any route,
    // so a non-loopback bind means anyone who can reach the port gets
    // whatever the configured Firebird user has. That should be a
    // decision an operator took, not one they discover later.
    if (env.HOST !== '127.0.0.1' && env.HOST !== 'localhost' && env.HOST !== '::1') {
      app.log.warn(
        { host: env.HOST, port: env.PORT },
        'listening on a non-loopback address with no authentication; put an authenticating proxy in front of this',
      );
    }
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
