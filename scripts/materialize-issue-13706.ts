// @effect-diagnostics nodeBuiltinImport:off - standalone fixture materializer.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

// Run from either revision: node /path/to/fixed/scripts/materialize-issue-13706.ts /path/to/worktree
const root = process.argv[2];
if (!root) throw new Error("Pass the destination worktree; this script never starts a server.");
NodeFS.copyFileSync(
  NodeURL.fileURLToPath(new URL("./fixtures/issue-13706/repro.tsx", import.meta.url)),
  `${root}/apps/web/src/issue-13706-repro.tsx`,
);
NodeFS.writeFileSync(
  `${root}/apps/web/issue-13706.html`,
  '<!doctype html><html><head><meta charset="utf-8"><title>Issue 13706 dependency harness</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/src/issue-13706-repro.tsx"></script></body></html>\n',
);
console.log(
  "Materialized synthetic dependency harness at /issue-13706.html; no database accessed.",
);
