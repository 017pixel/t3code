#!/usr/bin/env node
// Usage: node apps/server/scripts/fixtures/seed-antigravity-lifecycle-proof.mjs /absolute/scratch-dir
// Stop the isolated dev server before running this. Create/send threads through the real client.
import { mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."));
const scratch = process.argv[2];
if (!scratch || !scratch.startsWith("/tmp/"))
  throw new Error("Supply a scratch directory below /tmp");
const settingsPath = join(root, ".t3/userdata/settings.json");
if (!realpathSync(settingsPath).startsWith(join(root, ".t3/")))
  throw new Error("Isolated settings must not be symlinked outside this checkout");
mkdirSync(scratch, { recursive: true });
const scenario = join(scratch, "scenario");
const wrapper = join(scratch, "agy_acp_server.par");
const fixture = join(root, "apps/server/scripts/fixtures/antigravity-lifecycle-proof.mjs");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(scenario, "pending\n");
writeFileSync(
  wrapper,
  [
    "#!/bin/sh",
    `export T3_LIFECYCLE_SCENARIO_PATH=${quote(scenario)}`,
    `export T3_LIFECYCLE_TRANSCRIPT_PATH=${quote(join(scratch, "lifecycle.jsonl"))}`,
    `export T3_ACP_RUNNING_COMMAND_PID_PATH=${quote(join(scratch, "command-pids"))}`,
    `exec ${quote(process.execPath)} ${quote(fixture)}`,
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o700);
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
settings.providerInstances ??= {};
settings.providerInstances.antigravity = {
  driver: "antigravity",
  enabled: true,
  config: { binaryPath: wrapper },
};
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`Configured isolated Antigravity fixture. Scenario file: ${scenario}`);
console.log(
  "Use pending for D; completed/failed for C; passthrough then Stop and ordinary for E. Start a new thread for each C/D scenario.",
);
console.log(
  "For C, wait for completed assistant message + running command, then SIGTERM only the SECOND PID published in command-pids. The mock emits the terminal tool update on process exit.",
);
console.log(
  "For E, set ordinary after Stop before submitting the follow-up in the same thread. New runtime launches with running-command flags disabled.",
);
