// @effect-diagnostics nodeBuiltinImport:off -- Runs before loading the Effect CLI or server graph.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Source dev stays uncached; bundled and SEA dependencies persist under the selected T3 home. */
export function enableCliCompileCache(input: {
  readonly bundled: boolean;
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}) {
  if (
    !input.bundled ||
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
  // Cache failures never prevent CLI or server startup, including a read-only home.
  try {
    NodeModule.enableCompileCache(NodePath.join(directory, "compile-cache"));
  } catch {}
}
