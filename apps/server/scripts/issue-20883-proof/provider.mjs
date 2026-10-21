#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

// Public wire shapes come from the existing Codex protocol fixture. A file gate
// lets the real browser observe running state before a notification is emitted.
const wire = JSON.parse(fs.readFileSync(new URL("./wire.json", import.meta.url)));
const gate = process.env.T3_PROOF_GATE ?? "/tmp/issue-20883-gate";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
  process.exit();
}
let counter = 0;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  const { id, method } = msg;
  if (method === "initialize")
    return send({
      id,
      result: {
        userAgent: "public-proof/1",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
  if (method === "account/read")
    return send({ id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: false } });
  if (method === "model/list")
    return send({
      id,
      result: {
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "Public proof fixture",
            description: "Deterministic local fixture",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            supportsPersonality: false,
          },
        ],
      },
    });
  if (method === "skills/list") return send({ id, result: { data: [] } });
  if (method === "thread/start" || method === "thread/resume") {
    const nativeId = msg.params?.threadId ?? randomUUID();
    const result = structuredClone(wire.threadStart);
    result.thread.id = nativeId;
    result.thread.sessionId = nativeId;
    result.thread.cwd = process.cwd();
    result.cwd = process.cwd();
    return send({ id, result });
  }
  if (method === "turn/start") {
    const nativeId = msg.params.threadId;
    const turn = { ...wire.turnStart.turn, id: `proof-turn-${++counter}` };
    send({ id, result: { turn } });
    notify("turn/started", { threadId: nativeId, turn });
    const text = JSON.stringify(msg.params.input ?? []);
    const kind =
      ["input", "approval", "failed", "limited"].find((k) => text.includes(`PROOF:${k}`)) ??
      "complete";
    fs.writeFileSync(`${gate}.ready`, kind);
    const timer = setInterval(() => {
      if (!fs.existsSync(gate)) return;
      fs.unlinkSync(gate);
      clearInterval(timer);
      const common = { threadId: nativeId, turnId: turn.id };
      if (kind === "input")
        return send({
          id: 9000 + counter,
          method: "item/tool/requestUserInput",
          params: {
            ...common,
            itemId: `question-${counter}`,
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "public-question",
                isOther: true,
                isSecret: false,
                header: "Fixture",
                question: "Which public fixture choice?",
                options: [
                  { label: "Alpha", description: "Public fixture alpha" },
                  { label: "Beta", description: "Public fixture beta" },
                ],
              },
            ],
          },
        });
      if (kind === "approval")
        return send({
          id: 9000 + counter,
          method: "item/commandExecution/requestApproval",
          params: {
            ...common,
            itemId: `approval-${counter}`,
            kind: "command",
            startedAtMs: Date.now(),
            environmentId: "local",
            commandActions: [{ type: "unknown", command: "printf public-proof" }],
            proposedExecpolicyAmendment: null,
            availableDecisions: ["accept", "cancel"],
            command: "printf public-proof",
            cwd: process.cwd(),
            reason: "Public no-op fixture approval",
          },
        });
      if (kind === "failed" || kind === "limited") {
        const error = {
          message:
            kind === "limited"
              ? "Usage limit reached for public fixture"
              : "Public fixture runtime failure",
          codexErrorInfo: kind === "limited" ? "usageLimitExceeded" : "other",
          additionalDetails: null,
        };
        notify("error", { ...common, error, willRetry: false });
        return notify("turn/completed", {
          threadId: nativeId,
          turn: { ...turn, status: "failed", error },
        });
      }
      notify("item/completed", {
        ...common,
        item: {
          id: `answer-${counter}`,
          type: "agentMessage",
          text: "DONE",
          phase: "final_answer",
        },
      });
      notify("turn/completed", { threadId: nativeId, turn: { ...turn, status: "completed" } });
    }, 50);
    return;
  }
  if (id !== undefined && method) send({ id, result: {} });
});
