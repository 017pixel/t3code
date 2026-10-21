// oxlint-disable t3code/no-global-process-runtime -- pnpm loads this file before any Effect runtime exists.
module.exports = {
  hooks: {
    // Many React libraries ship types that import "react" without declaring
    // @types/react. TypeScript then finds @types/react only by walking up
    // node_modules from the library's real path. The global virtual store
    // has no hoisted copy on that path, so the types become `any`. An
    // optional peer links the consumer's @types/react next to the library.
    // Our own packages are private (npm never publishes those) and are left
    // alone: pnpm checks local `file:` packages against the lockfile without
    // this hook.
    readPackage(manifest) {
      if (manifest.private) return manifest;
      const declaresReact =
        manifest.peerDependencies?.react !== undefined ||
        manifest.dependencies?.react !== undefined;
      if (!declaresReact || manifest.name === "@types/react") return manifest;
      if (
        manifest.dependencies?.["@types/react"] !== undefined ||
        manifest.peerDependencies?.["@types/react"] !== undefined
      ) {
        return manifest;
      }
      return {
        ...manifest,
        peerDependencies: { ...manifest.peerDependencies, "@types/react": "*" },
        peerDependenciesMeta: {
          ...manifest.peerDependenciesMeta,
          "@types/react": { optional: true },
        },
      };
    },
    updateConfig(config) {
      const next = { ...config };
      // T3CODE_PNPM_GLOBAL_VIRTUAL_STORE=1 links packages from one shared copy
      // in <storeDir>/links, so a worktree install takes seconds and a
      // worktree delete is instant. It is opt-in: types that import packages
      // they never declare only resolve through pnpm's hoisted copies, which
      // TypeScript cannot reach from the shared store. CI never uses it, since
      // pnpm 12 honors an explicit setting there too. Windows is left out: WSL
      // dev runs the server from the same node_modules, and store links across
      // that boundary are untested.
      if (
        process.env.T3CODE_PNPM_GLOBAL_VIRTUAL_STORE === "1" &&
        !process.env.CI &&
        process.platform !== "win32"
      ) {
        next.virtualStoreType = "global";
      }
      // Windows WSL dev mode runs the server under Linux from the same
      // node_modules as the Windows client, so Windows installs also need
      // Linux x64 glibc native modules. Other platforms install only their own
      // binaries; setting this everywhere added ~2.2 GB of foreign binaries to
      // every macOS install. Release scripts stage their own installs with
      // explicit architectures.
      if (process.platform === "win32") {
        next.supportedArchitectures = {
          os: ["current", "linux"],
          cpu: ["current", "x64"],
          libc: ["current", "glibc"],
        };
      }
      return next;
    },
  },
};
