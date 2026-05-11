# plamenix-web

Fastify + React web edition of Plamenix. Talks to Firebird via NAPI
bindings to rsfbclient (`@plamenix/fbclient-node`) so the same driver
powers desktop and web.

This repo is one of five in the Plamenix polyrepo. For project-wide
context, see the [meta-workspace](https://github.com/zlatan/plamenix).

## Status

`1.0.0-beta` is in development. Mid-June 2026 ETA.

## Stack

- **Fastify 5** (Node 24 LTS) — backend.
- **napi-rs 3** — Rust ↔ Node FFI for the driver.
- **React 19 + Vite 8 + Tailwind 4** — frontend.
- **rsfbclient** — Firebird driver (via the NAPI binding).
- **TanStack Query** + **Zustand** — frontend state.

Three packages in a pnpm workspace under `packages/`.

## Quick start

```bash
corepack enable
pnpm install
pnpm --filter @plamenix/fbclient-node build   # build native binary first
pnpm dev                                       # server + client in parallel
```

Requires `plamenix-core/` and `plamenix-ui/` checked out as siblings.

## Licence

Dual licensed under [MIT](./LICENSE-MIT) OR [Apache-2.0](./LICENSE-APACHE).
