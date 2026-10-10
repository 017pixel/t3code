// @effect-diagnostics nodeBuiltinImport:off - the test kills a real Node process to prove the cache is on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

it.each([false, true])(
  "persists an enabled cache before forced exit (disabled: %s)",
  async (disabled) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-compile-cache-"));
    try {
      const cacheDirectory = NodePath.join(directory, "cache");
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
const { flushCompileCache } = await import(${JSON.stringify(new URL("./compileCache.ts", import.meta.url).href)});
await Effect.runPromise(flushCompileCache);
process.kill(process.pid, "SIGKILL");`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_COMPILE_CACHE: cacheDirectory,
            NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
          },
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.stderr, "");
      assert.notEqual(child.status, 0);
      const entries = await NodeFSP.readdir(cacheDirectory, { recursive: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      const files = await Promise.all(
        entries.map((entry) => NodeFSP.stat(NodePath.join(cacheDirectory, entry))),
      );
      assert.equal(
        files.some((entry) => entry.isFile()),
        !disabled,
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "selects the CLI cache under the explicit T3 home (disabled: %s)",
  async (disabled) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-cache-"));
    try {
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
const { enableCliCompileCache } = await import(${JSON.stringify(new URL("./cliCompileCache.ts", import.meta.url).href)});
enableCliCompileCache({ bundled: true, argv: ["serve", "--base-dir", ${JSON.stringify(directory)}], environment: process.env });
await import(${JSON.stringify(import.meta.resolve("effect/Effect"))});
const { flushCompileCache } = await import(${JSON.stringify(new URL("./compileCache.ts", import.meta.url).href)});
const Effect = await import(${JSON.stringify(import.meta.resolve("effect/Effect"))});
await Effect.runPromise(flushCompileCache);
process.kill(process.pid, "SIGKILL");`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_COMPILE_CACHE: undefined,
            NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
          },
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.stderr, "");
      const entries = await NodeFSP.readdir(NodePath.join(directory, "compile-cache"), {
        recursive: true,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const files = await Promise.all(
        entries.map((entry) => NodeFSP.stat(NodePath.join(directory, "compile-cache", entry))),
      );
      assert.equal(
        files.some((entry) => entry.isFile()),
        !disabled,
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves the version output through the thin CLI entry", async () => {
  const packageJson = JSON.parse(
    await NodeFSP.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(import.meta.dirname, "bin.ts"), "--version"],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout, `t3 v${packageJson.version}\n`);
  assert.equal(child.stderr, "");
});
