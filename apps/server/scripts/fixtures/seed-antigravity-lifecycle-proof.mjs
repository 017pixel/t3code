#!/usr/bin/env node
// Usage: node apps/server/scripts/fixtures/seed-antigravity-lifecycle-proof.mjs /absolute/scratch-dir
// Stop the isolated dev server before running this. Create/send threads through the real client.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeFS.realpathSync(
  NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../.."),
);
const canonicalPath = (path) => {
  const absolute = NodePath.resolve(path);
  let parent = absolute;
  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync(parent), NodePath.relative(parent, absolute));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (NodeFS.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new Error("Fixture paths must not contain dangling symlinks", { cause: error });
      parent = NodePath.dirname(parent);
    }
  }
};
const tmp = NodeFS.realpathSync("/tmp");
const scratch = process.argv[2] && canonicalPath(process.argv[2]);
if (!scratch || !scratch.startsWith(tmp + NodePath.sep))
  throw new Error("Supply a scratch directory below /tmp");
for (const name of [
  "scenario",
  "agy_acp_server.par",
  "localharness_external",
  "lifecycle.jsonl",
  "command-pids",
]) {
  if (!canonicalPath(NodePath.join(scratch, name)).startsWith(tmp + NodePath.sep))
    throw new Error("Fixture files must stay below /tmp");
}
const settingsPath = NodePath.join(root, ".t3/userdata/settings.json");
if (!NodeFS.realpathSync(settingsPath).startsWith(NodePath.join(root, ".t3/")))
  throw new Error("Isolated settings must not be symlinked outside this checkout");
NodeFS.mkdirSync(scratch, { recursive: true });
const scenario = NodePath.join(scratch, "scenario");
const wrapper = NodePath.join(scratch, "agy_acp_server.par");
const fixture = NodePath.join(root, "apps/server/scripts/fixtures/antigravity-lifecycle-proof.mjs");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
NodeFS.writeFileSync(scenario, "pending\n");
NodeFS.writeFileSync(
  wrapper,
  [
    "#!/bin/sh",
    `export T3_LIFECYCLE_SCENARIO_PATH=${quote(scenario)}`,
    `export T3_LIFECYCLE_TRANSCRIPT_PATH=${quote(NodePath.join(scratch, "lifecycle.jsonl"))}`,
    `export T3_ACP_RUNNING_COMMAND_PID_PATH=${quote(NodePath.join(scratch, "command-pids"))}`,
    `exec ${quote(process.execPath)} ${quote(fixture)}`,
    "",
  ].join("\n"),
);
NodeFS.chmodSync(wrapper, 0o700);
const localHarness = NodePath.join(scratch, "localharness_external");
NodeFS.writeFileSync(localHarness, "#!/bin/sh\nexit 0\n");
NodeFS.chmodSync(localHarness, 0o700);
const settings = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
settings.providerInstances ??= {};
settings.providerInstances.antigravity = {
  ...settings.providerInstances.antigravity,
  driver: "antigravity",
  enabled: true,
  config: { ...settings.providerInstances.antigravity?.config, binaryPath: wrapper },
};
NodeFS.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`Configured isolated Antigravity fixture. Scenario file: ${scenario}`);
console.log("Use pending for D; completed/failed for C. Start a new thread for each C/D scenario.");
console.log(
  "For C, wait for completed assistant message + running command, then SIGTERM only the SECOND PID published in command-pids. The mock emits the terminal tool update on process exit.",
);
console.log(
  "For E, set passthrough BEFORE creating the thread, then Stop, then set ordinary before submitting the follow-up in the SAME thread. New runtime launches with running-command flags disabled.",
);
