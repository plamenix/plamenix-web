// Generated entry point. Loads the platform-specific native binary built
// by `napi build`. In CI we publish per-platform optional dependencies;
// for local dev `napi build` writes a `.node` file alongside this file.
//
// This file is hand-maintained as a stub until the first `napi build`
// runs and overwrites it with the canonical loader. Until then it just
// throws a useful error.

module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `@plamenix/fbclient-node: native binary not built. Run \`pnpm --filter @plamenix/fbclient-node build\` ` +
          `to generate the platform binary, then re-import. (Accessed '${String(prop)}'.)`,
      );
    },
  },
);
