import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// Usage: node scripts/seed-issue-23245.mjs <worktree>/.t3 R1|R2|R3|R4|empty
// Reset preferences only; create the project/thread and provider setup in the app.
const [directory, row] = process.argv.slice(2);
const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/issue-23245.json", import.meta.url)),
);
if (!directory || !Object.hasOwn(fixtures, row))
  throw new Error("Expected isolated .t3 path and fixture row");
const base = await realpath(resolve(directory));
if (basename(base) !== ".t3" || base === join(homedir(), ".t3")) {
  throw new Error("Use a worktree's isolated .t3 directory");
}
const path = join(base, "userdata/settings.json");
const settings = JSON.parse(
  await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  }),
);
settings.favorites = fixtures[row];
settings.providerInstances = {
  ...settings.providerInstances,
  opencode: {
    ...settings.providerInstances?.opencode,
    driver: "opencode",
    displayName: "OpenCode",
    enabled: false,
  },
};
const temporary = `${path}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, path);
console.log(`Seeded ${row}: ${settings.favorites.length} favorites in ${base}`);
