#!/usr/bin/env node
// ACP transport fixture for real-client lifecycle verification. No credentials or prompt text are logged.
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scenarioPath = process.env.T3_LIFECYCLE_SCENARIO_PATH;
const transcriptPath = process.env.T3_LIFECYCLE_TRANSCRIPT_PATH;
if (!scenarioPath)
  throw new Error(
    "Set T3_LIFECYCLE_SCENARIO_PATH to a file containing pending, completed, failed, passthrough, or ordinary",
  );
const initialScenario = readFileSync(scenarioPath, "utf8").trim();
const running = ["completed", "failed", "passthrough"].includes(initialScenario);
const mockEnv = { ...process.env };
delete mockEnv.T3_ACP_RUNNING_COMMAND_FINISH;
if (["completed", "failed"].includes(initialScenario)) {
  mockEnv.T3_ACP_RUNNING_COMMAND_FINISH = initialScenario;
}
const mock = spawn(
  process.execPath,
  [fileURLToPath(new URL("../acp-mock-agent.ts", import.meta.url))],
  {
    env: {
      ...mockEnv,
      T3_ACP_ANTIGRAVITY: "1",
      T3_ACP_EMIT_RUNNING_COMMAND_THEN_HANG: running ? "1" : "0",
      T3_ACP_RUNNING_COMMAND_END_TURN: running ? "1" : "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);
const log = (event) => {
  if (transcriptPath)
    appendFileSync(
      transcriptPath,
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
    );
};
const write = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
createInterface({ input: mock.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  const update = message.method === "session/update" ? message.params?.update : undefined;
  if (update?.toolCallId) update.toolCallId += `:proof:${process.pid}`;
  if (update)
    log({
      scenario: initialScenario,
      sessionUpdate: update.sessionUpdate,
      toolCallId: update.toolCallId,
      status: update.status,
      state: update.state,
      stopReason: update.stopReason,
    });
  write(message);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const scenario = readFileSync(scenarioPath, "utf8").trim();
  if (request.method !== "session/prompt" || scenario !== "pending") {
    mock.stdin.write(line + "\n");
    return;
  }
  const sessionId = request.params.sessionId;
  const update = (value) => {
    write({ method: "session/update", params: { sessionId, update: value } });
    log({ scenario, update: value });
  };
  log({ scenario, event: "prompt accepted" });
  if (scenario === "pending") {
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: `pending-command:proof:${process.pid}`,
      title: "Terminal",
      kind: "execute",
      status: "pending",
      rawInput: { command: ["npm", "run", "dev"] },
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: `trajectory:${process.pid}`,
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      rawOutput: "Started two agents.",
    });
  }
  setTimeout(() => {
    update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Pending command and subagent batch may settle with the parent turn.",
      },
    });
    update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    write({ id: request.id, result: {} });
    log({ scenario, event: "end_turn" });
  }, 3500);
});
mock.on("exit", (code) => process.exit(code ?? 0));
process.stdin.on("end", () => mock.stdin.end());
