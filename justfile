default:
    @just --list

setup:
    pnpm install
    cd packages/fbclient-node && cargo fetch

dev:
    pnpm dev

build:
    pnpm build
    just napi-build

# Native build for the current platform; CI builds for every target.
napi-build:
    cd packages/fbclient-node && pnpm build

typecheck:
    pnpm typecheck

lint:
    cd packages/fbclient-node && cargo clippy --all-targets --all-features -- -D warnings
    pnpm lint

fmt:
    cd packages/fbclient-node && cargo fmt --all
    pnpm format

test:
    cd packages/fbclient-node && cargo test --all-features
    pnpm test
