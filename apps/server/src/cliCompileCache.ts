// @effect-diagnostics nodeBuiltinImport:off -- Runs before loading the Effect CLI or server graph.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Source dev stays uncached; bundled and SEA dependencies persist under the
 * selected T3 home, in one directory per version.
 */
export function enableCliCompileCache(input: {
  readonly bundled: boolean;
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly version: string;
}) {
  if (
    !input.bundled ||
    // AppImage mounts the app at a new /tmp/.mount_* path every launch and Node
    // keys entries by path, so they would never hit, only pile up (the desktop's
    // compileCache.ts skips it for the same reason).
    input.environment.APPIMAGE ||
    input.environment.NODE_DISABLE_COMPILE_CACHE === "1" ||
    input.environment.NODE_COMPILE_CACHE
  )
    return;
  const index = input.argv.indexOf("--base-dir");
  const configured =
    (index >= 0 ? input.argv[index + 1] : undefined) ??
    input.argv
      .find((argument) => argument.startsWith("--base-dir="))
      ?.slice("--base-dir=".length) ??
    input.environment.T3CODE_HOME;
  const home = NodeOS.homedir();
  const base = configured?.trim();
  const directory = !base
    ? NodePath.join(home, ".t3")
    : base === "~"
      ? home
      : base.startsWith("~/") || base.startsWith("~\\")
        ? NodePath.join(home, base.slice(2))
        : NodePath.resolve(base);
  const root = NodePath.join(directory, "compile-cache");
  // Cache failures never prevent CLI or server startup, including a read-only home.
  try {
    const { status } = NodeModule.enableCompileCache(NodePath.join(root, input.version));
    if (status !== NodeModule.constants.compileCacheStatus.ENABLED) return;
    // Bundle chunk names change with their contents, so other versions' entries
    // never hit again. Only the running version's directory stays.
    NodeFS.readdir(root, (error, entries) => {
      if (error) return;
      for (const entry of entries) {
        if (entry === input.version) continue;
        NodeFS.rm(NodePath.join(root, entry), { recursive: true, force: true }, () => {});
      }
    });
  } catch {}
}
