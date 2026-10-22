import { mkdir, readFile, writeFile, symlink, chmod } from "node:fs/promises";
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
  try {
    await chmod(name, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
const phase = process.argv[3] ?? "enabled";
const inventory = JSON.parse(
  await readFile(new URL("./ClaudeSkills.fixture.json", import.meta.url), "utf8"),
);
if (["inventory", "registry", "invalid-registry"].includes(phase)) {
  await file(path.join(root, "outside/SKILL.md"), "# Escaped target must not be adopted\n");
  for (const fixture of inventory) {
    const plugin = path.join(config, "skills", fixture.folder);
    if (fixture.marker !== false)
      await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
    if (fixture.manifest !== null)
      await file(
        path.join(plugin, ".claude-plugin/plugin.json"),
        typeof fixture.manifest === "string" ? fixture.manifest : JSON.stringify(fixture.manifest),
      );
    for (const [relative, contents] of Object.entries(fixture.files))
      await file(path.join(plugin, relative), contents);
    for (const [relative, target] of Object.entries(fixture.links ?? {})) {
      try {
        await symlink(
          target.replace("{root}", root).replace("{plugin}", plugin),
          path.join(plugin, relative),
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    for (const relative of fixture.unreadable ?? []) await chmod(path.join(plugin, relative), 0);
  }
}
const settingsPath = path.join(config, "settings.json");
let settings = {};
try {
  settings = JSON.parse(await readFile(settingsPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
settings.enabledPlugins ??= {};
if (phase === "disabled") settings.enabledPlugins["demo-tools@skills-dir"] = false;
else delete settings.enabledPlugins["demo-tools@skills-dir"];
if (phase === "disabled") delete settings.enabledPlugins["opt-in@skills-dir"];
else settings.enabledPlugins["opt-in@skills-dir"] = true;
if (phase === "registry" || phase === "invalid-registry") {
  const plugins = {};
  for (const scope of ["user", "managed", "project", "local"]) {
    const install = path.join(root, "registry", scope);
    await file(
      path.join(install, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: `registered-${scope}` }),
    );
    await file(path.join(install, "skills/review/SKILL.md"), `# Registered ${scope}\n`);
    const key = `registry-${scope}@fixture`;
    settings.enabledPlugins[key] = true;
    plugins[key] = [
      { scope, installPath: install, projectPath: process.argv[4] ?? path.join(root, "workspace") },
    ];
  }
  const fallback = path.join(root, "registry/fallback");
  await file(
    path.join(fallback, "SKILL.md"),
    "---\nname: registry-fallback:root\n---\nReply only OK.\n",
  );
  plugins["registry-fallback@fixture"] = [{ scope: "user", installPath: fallback }];
  plugins["disabled@fixture"] = plugins["registry-user@fixture"];
  plugins["invalid@fixture"] = [{ scope: "unknown", installPath: fallback }];
  plugins["unmatched@fixture"] = [
    { scope: "project", installPath: fallback, projectPath: path.join(root, "unmatched") },
  ];
  Object.assign(settings.enabledPlugins, {
    "registry-fallback@fixture": true,
    "disabled@fixture": false,
    "invalid@fixture": true,
    "unmatched@fixture": true,
  });
  await file(
    path.join(config, "plugins/installed_plugins.json"),
    phase === "invalid-registry" ? "{broken" : JSON.stringify({ plugins }),
  );
}
await file(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`Prepared Claude skills fixture at ${config}`);
