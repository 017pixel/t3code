import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = process.argv.slice(2);
if (!targets.length) {
  throw new Error("Usage: node scripts/seed-markdown-scroll-fixtures.mjs <sandbox-worktree> [...]");
}
for (const target of targets) {
  const destination = resolve(target, ".t3/markdown-scroll-fixtures");
  mkdirSync(destination, { recursive: true });
  for (const name of ["alpha.md", "beta.md", "delayed.md", "height.svg", "tasks.md", "links.md"]) {
    copyFileSync(
      resolve(root, `scripts/fixtures/markdown-scroll/${name}`),
      resolve(destination, name),
    );
  }
  const secondary = resolve(target, "apps/server/.t3/markdown-scroll-fixtures");
  mkdirSync(secondary, { recursive: true });
  writeFileSync(
    resolve(secondary, "alpha.md"),
    readFileSync(resolve(destination, "alpha.md"), "utf8").replace(
      "fixture alpha",
      "fixture workspace B alpha",
    ),
  );
}
