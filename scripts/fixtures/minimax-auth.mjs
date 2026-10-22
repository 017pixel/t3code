import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const base = process.argv[2];
if (!base) throw new Error("Usage: node scripts/fixtures/minimax-auth.mjs <isolated-t3-home>");
await mkdir(base, { recursive: true });
const resolved = await realpath(base);
if (resolved === path.join(homedir(), ".t3")) throw new Error("Refusing the live T3 home");
const userdata = path.join(resolved, "userdata");
const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};
const runtime = await readJson(path.join(userdata, "server-runtime.json"));
if (runtime.pid) {
  let running = true;
  try {
    process.kill(runtime.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") running = false;
    else throw error;
  }
  if (running) throw new Error("Stop the isolated server before seeding settings");
}
const file = path.join(userdata, "settings.json");
const settings = await readJson(file);
settings.providerInstances ??= {};
settings.providerInstances.acpRegistry_minimax_code = {
  driver: "acpRegistry",
  displayName: "MiniMax Code",
  enabled: true,
  config: { agentId: "minimax-code", distribution: "auto" },
};
await mkdir(userdata, { recursive: true });
await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
console.log(
  "Seeded unauthenticated MiniMax configuration; install mcode 0.2.7 in this isolated home before capture. No credentials are seeded.",
);
