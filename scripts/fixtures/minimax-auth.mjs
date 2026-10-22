import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const base = process.argv[2];
if (!base) throw new Error("Usage: node scripts/fixtures/minimax-auth.mjs <isolated-t3-home>");
// Resolve symlinks through the deepest existing ancestor so neither a linked
// live home nor a not-yet-created path can alias ~/.t3 before anything is written.
const canonical = async (path) => {
  const absolute = NodePath.resolve(path);
  try {
    return await NodeFSP.realpath(absolute);
  } catch (error) {
    const parent = NodePath.dirname(absolute);
    if (error.code !== "ENOENT" || parent === absolute) throw error;
    return NodePath.join(await canonical(parent), NodePath.basename(absolute));
  }
};
const resolved = await canonical(base);
const live = NodePath.join(NodeOS.homedir(), ".t3");
if (resolved === (await canonical(live))) throw new Error("Refusing the live T3 home");
const userdata = NodePath.join(resolved, "userdata");
const file = NodePath.join(userdata, "settings.json");
// A linked userdata directory or settings file can still alias the live settings.
if ((await canonical(file)) === (await canonical(NodePath.join(live, "userdata", "settings.json"))))
  throw new Error("Refusing the live T3 settings");
await NodeFSP.mkdir(resolved, { recursive: true });
const readJson = async (file) => {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
};
const runtime = await readJson(NodePath.join(userdata, "server-runtime.json"));
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
const settings = await readJson(file);
settings.providerInstances ??= {};
settings.providerInstances.acpRegistry_minimax_code = {
  driver: "acpRegistry",
  displayName: "MiniMax Code",
  enabled: true,
  config: { agentId: "minimax-code", distribution: "auto" },
};
await NodeFSP.mkdir(userdata, { recursive: true });
await NodeFSP.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
console.log(
  "Seeded unauthenticated MiniMax configuration; install mcode 0.2.7 in this isolated home before capture. No credentials are seeded.",
);
