// @effect-diagnostics nodeBuiltinImport:off - runs from bin.ts before any Effect runtime.
/**
 * `t3 __load-bundle`: evaluates every chunk the bundle's entry reaches, lazily
 * imported ones included, then reports how many loaded. The desktop build
 * runs it from an isolated copy of the packaged server, so a chunk or a
 * dependency missing from that tree fails the build instead of a user's first
 * session. `--version` cannot do this: it returns before the server graph loads.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** A static or dynamic import of a sibling chunk, as the bundler emits it. */
const CHUNK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']\.\/([^"'/]+\.mjs)["']/g;

export async function loadBundle(entryUrl: string): Promise<number> {
  if (!entryUrl.endsWith(".mjs")) {
    throw new Error("t3 __load-bundle checks the built bundle; run it from dist/bin.mjs.");
  }
  const entryPath = NodeURL.fileURLToPath(entryUrl);
  const directory = NodePath.dirname(entryPath);
  const entry = NodePath.basename(entryPath);
  const files = [entry];
  const seen = new Set(files);
  for (const file of files) {
    // The entry is still in its top-level await, so importing it again would wait on itself.
    // A chunk that is referenced but missing fails here.
    if (file !== entry) await import(NodeURL.pathToFileURL(NodePath.join(directory, file)).href);
    const source = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
    for (const [, chunk] of source.matchAll(CHUNK_IMPORT)) {
      if (chunk && !seen.has(chunk)) {
        seen.add(chunk);
        files.push(chunk);
      }
    }
  }
  // Externals required on first call sit outside the module graph. The Cursor
  // SDK's disk-backed closure is the largest, and the server loaded it at
  // startup before its adapter became lazy, so load it as well.
  const { loadCursorSdk } = await import("@t3tools/provider-cursor/server/sdk");
  loadCursorSdk();
  return files.length - 1;
}
