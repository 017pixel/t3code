// @effect-diagnostics nodeBuiltinImport:off - root `prepare` hook, runs before any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

// `effect-tsgo patch` swaps the native TypeScript binary in place so editors
// show Effect diagnostics. With pnpm's global virtual store that binary is
// shared by every project on the machine, so we only patch a copy that lives
// in this checkout's node_modules. `vp run typecheck` uses tsc-rs, which
// reports Effect diagnostics either way.
const root = NodeFS.realpathSync(NodePath.dirname(import.meta.dirname));
const rootRequire = NodeModule.createRequire(NodePath.join(root, "noop.js"));
const typescriptRequire = NodeModule.createRequire(rootRequire.resolve("typescript/package.json"));
// oxlint-disable-next-line t3code/no-global-process-runtime -- runs from the root prepare hook, outside any Effect runtime.
const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
const platformDir = NodeFS.realpathSync(
  NodePath.dirname(typescriptRequire.resolve(`${platformPackage}/package.json`)),
);

if (!platformDir.startsWith(NodePath.join(root, "node_modules") + NodePath.sep)) {
  process.stdout.write(
    `Skipping effect-tsgo patch: TypeScript is shared from ${platformDir}. Editors using the workspace TypeScript will not show Effect diagnostics.\n`,
  );
  process.exit(0);
}

const effectTsgoDir = NodePath.dirname(rootRequire.resolve("@effect/tsgo/package.json"));
const result = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(effectTsgoDir, "dist", "effect-tsgo.cjs"), "patch"],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
