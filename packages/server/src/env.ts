import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Loopback by default. The server has no authentication of any kind:
  // every route is reachable by anyone who can open the port, and they
  // can read, write, and drop whatever the configured Firebird user
  // can. Binding to 0.0.0.0 was making that reachable from the network
  // by default rather than by decision. Set HOST explicitly to expose
  // it, and put authentication in front of it when you do.
  HOST: z.string().default('127.0.0.1'),
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
  // Absolute path to the `fbclient` shared library the driver loads in
  // native mode.
  //
  // Server configuration, never a request field. It was previously
  // accepted in the body of `POST /api/connect` and in the profile
  // routes, and `resolve_fbclient_path` gives an explicit config value
  // precedence over this variable — so an unauthenticated request could
  // name any path on the server's filesystem and have it dlopen'd.
  //
  // Unset means native mode is unavailable and connections must use
  // pure-Rust, which is the safe default for a server that ships no
  // fbclient of its own.
  FBCLIENT_PATH: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
