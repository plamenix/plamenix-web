# plamenix-web

Web edition of Plamenix. Three packages in a pnpm workspace:

- `@plamenix/fbclient-node` — NAPI bindings to `plamenix-db` (which
  itself wraps rsfbclient). Native npm module published per platform.
  See `../plamenix/docs/napi-rsfbclient.md` and ADR
  `0014-napi-rsfbclient-bindings.md`.
- `@plamenix/web-server` — Fastify backend. Owns sessions, talks to
  Firebird through the NAPI binding.
- `@plamenix/web-client` — React SPA. Consumes `@plamenix/ui` and the
  shared `Transport` interface (implemented over `fetch`).

For cross-repo architectural context (driver, plugin system, transport,
state, encryption), read `../plamenix/docs/` and `../plamenix/docs/adr/`.

## Layout

```
packages/
  fbclient-node/      NAPI module
    Cargo.toml        crate `plamenix-fbclient-node`, deps napi-rs + plamenix-db + plamenix-types
    build.rs          napi_build::setup()
    src/lib.rs        #[napi] ping / connect / execute / pingSession / close
    package.json      @napi-rs/cli scripts
    index.js          loader stub (overwritten by `napi build`)
    index.d.ts        hand-maintained until first build
  server/             Fastify backend
    src/main.ts       bootstrap
    src/app.ts        buildApp() — registers helmet, cors, sensible, routes
    src/env.ts        zod-validated env loader (incl. PROFILES_PATH)
    src/routes/       per-endpoint route files (ping, connect, execute, close, profiles)
    src/sessions/     in-memory session store (Redis later)
    src/profiles/     JSON-file connection profile store (no secrets server-side)
    test/             vitest + Fastify inject
  client/             React SPA
    src/main.tsx      root + QueryClientProvider
    src/App.tsx       shell stub
    src/transport/fetch.ts  Transport impl over fetch → /api/*
```

Top-level config:

- `pnpm-workspace.yaml` — three packages.
- `tsconfig.base.json` — strict baseline; each package extends and overrides.
- `eslint.config.js` — shared flat config.
- `justfile` — common recipes.

## Build / dev

```
just setup     # pnpm install + cargo fetch
just dev       # `pnpm dev` — runs server (tsx watch) + client (vite) in parallel
just build     # tsc + vite build for each package
just napi-build  # build native binary for the host platform
just test      # cargo test + vitest across packages
just lint      # cargo clippy + eslint
```

Local dev wiring:

- `@plamenix/ui` is consumed by `client/` via `file:../../../plamenix-ui`.
- `plamenix-types` is consumed by `fbclient-node/Cargo.toml` via
  `path = "../../../plamenix-core/crates/plamenix-types"`.
- `@plamenix/fbclient-node` is consumed by `server/` via
  `workspace:*` (pnpm workspace protocol).

## Code rules (repo-specific)

- Routes are thin: parse with zod, call a service module, return a
  typed JSON envelope. No business logic in route handlers.
- All env vars go through `loadEnv()` in `env.ts`. No `process.env` reads
  scattered through the codebase.
- The NAPI surface returns plain data types only. No Buffer/stream
  trickery in the first cut; revisit when streaming BLOBs.
- Both server and client are ESM (`"type": "module"`). No CJS shims.
- `index.js` / `index.d.ts` in `fbclient-node` are hand-maintained stubs
  until `napi build` runs. After the first build, they get regenerated.
  Either keep stubs in sync or run the build before review.

## What does not live here

- Tauri shell — `plamenix-desktop`.
- Shared React components — `plamenix-ui`.
- Plugin host runtime, shared Rust types and traits — `plamenix-core`.

If a rule is missing from this file, the parent workspace `CLAUDE.md`
applies. Cross-repo architectural specs live in `../plamenix/docs/`.
