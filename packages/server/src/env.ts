import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PROFILES_PATH: z.string().default('./profiles.json'),
  HISTORY_PATH: z.string().default('./history.sqlite'),
  // Directory the boot-time plugin scanner walks. Each direct
  // subdirectory containing `manifest.toml` is loaded + activated.
  // Read-only as far as the host is concerned — plugin bundles live
  // here, plugin DATA lives under `PLUGIN_DATA_ROOT`.
  PLUGINS_PATH: z.string().default('./plugins'),
  // Root for per-plugin writable storage. Each loaded plugin gets a
  // dedicated `<PLUGIN_DATA_ROOT>/<plugin-id>/data/` directory created
  // by the bootstrap; the WASI `fs` capability (wired in I6) preopens
  // this path so plugins cannot reach outside their own scope.
  PLUGIN_DATA_ROOT: z.string().default('./plugin-data'),
  // SQLite file backing persistent plugin capability grants. The
  // bootstrap replays this into the napi binding at boot; grant/revoke
  // routes write here first, then push to the runtime.
  PLUGIN_GRANTS_PATH: z.string().default('./plugin-grants.sqlite'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
