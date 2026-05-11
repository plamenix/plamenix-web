# Contributing to plamenix-web

Thanks for your interest. This repo holds the Fastify backend, React
frontend, and NAPI bindings for the Plamenix web edition. Cross-cutting
guidance lives in the
[meta-workspace `CONTRIBUTING.md`](../plamenix/CONTRIBUTING.md). This
file covers web-specific bits.

## Prerequisites

- Rust 1.95 (`rustup default 1.95`)
- Node 24 + pnpm via Corepack (`corepack enable`)
- A C toolchain for napi-rs builds (Xcode CLT on macOS, build-essentials
  on Linux, MSVC Build Tools on Windows)

## Local development

```bash
pnpm install
pnpm --filter @plamenix/fbclient-node build   # produces the native .node
pnpm dev
```

`pnpm dev` runs the Fastify server (port 3000) and the Vite dev server
(port 5173) in parallel. Vite proxies `/api/*` to the Fastify server.

## Code style

- Rust (NAPI binding): `cargo fmt`, `cargo clippy --all-targets -- -D warnings`.
- TypeScript: `pnpm prettier --write .`, `pnpm eslint .`. No `any`.
- Functions over classes. Small modules. See `../plamenix/docs/principles.md`.

## Commits

Conventional Commits: `feat(web): …`, `fix(napi): …`, `docs:`, `chore:`.
See `../plamenix/docs/git-workflow.md`.

## Tests

```bash
cd packages/fbclient-node && cargo test --all-features
pnpm test
```

## Licence of contributions

By submitting a PR you agree your contribution is dual-licensed under
MIT OR Apache-2.0.
