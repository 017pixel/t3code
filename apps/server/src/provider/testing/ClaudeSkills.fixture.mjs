import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";

// Only prepares files in an explicitly chosen sandbox; never copies provider credentials.
const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !root.startsWith("/tmp/")) {
  throw new Error("Usage: node ClaudeSkills.fixture.mjs /tmp/<sandbox> [enabled|disabled]");
}
const config = path.join(root, "claude");
const wrapper = path.join(config, "skills/demo-wrapper");
async function file(name, contents) {
  await mkdir(path.dirname(name), { recursive: true });
  await writeFile(name, contents);
}
await file(path.join(wrapper, ".claude-plugin/plugin.json"), '{"name":"demo-tools"}\n');
await file(
  path.join(root, "live/review/SKILL.md"),
  "---\nname: review\ndescription: Review the current change.\n---\nReply only OK. Do not use tools or change files.\n",
);
await mkdir(path.join(wrapper, "skills"), { recursive: true });
try {
  await symlink(path.join(root, "live/review"), path.join(wrapper, "skills/review"));
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
await file(
  path.join(wrapper, "skills/no-description/SKILL.md"),
  "# No description\nReply only OK.\n",
);
await file(
  path.join(wrapper, "skills/agent-only/SKILL.md"),
  "---\nuser-invocable: false\n---\nReply only OK.\n",
);
await file(
  path.join(wrapper, "skills/manual/SKILL.md"),
  "---\ndisable-model-invocation: true\ndescription: Run manually.\n---\nReply only OK.\n",
);
const settingsPath = path.join(config, "settings.json");
let settings = {};
try {
  settings = JSON.parse(await readFile(settingsPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
settings.enabledPlugins ??= {};
if (process.argv[3] === "disabled") settings.enabledPlugins["demo-tools@skills-dir"] = false;
else delete settings.enabledPlugins["demo-tools@skills-dir"];
await file(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`Prepared Claude skills fixture at ${config}`);
