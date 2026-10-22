#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "node:crypto";

const manifest = JSON.parse(NodeFS.readFileSync(new URL("./scenarios.json", import.meta.url)));
if (process.argv.includes("--version")) {
  console.log("grok 1.0.13");
  process.exit(0);
}
if (process.argv.includes("inspect")) {
  console.log(JSON.stringify({ skills: [] }));
  process.exit(0);
}
if (process.argv.includes("models")) {
  console.log(
    "You are logged in with grok.com.\nDefault model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)",
  );
  process.exit(0);
}
const root = NodeFS.realpathSync(process.env.T3_DIFF_FIXTURE_ROOT ?? ".");
const marker = NodePath.join(root, ".checkpoint-diff-fixture");
if (!NodeFS.existsSync(marker))
  throw new Error("Run seed.mjs in an empty isolated directory first");
const out = (body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
let cwd;
let sessionRoot;
let sessionId = "checkpoint-diff-session";
const pending = new Set();

async function handle(request) {
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") {
    result = {
      protocolVersion: 1,
      agentInfo: { name: "grok", version: "fixture" },
      agentCapabilities: {},
    };
  } else if (request.method === "session/new" || request.method === "session/load") {
    cwd = NodeFS.realpathSync(request.params.cwd);
    sessionRoot = NodePath.dirname(cwd);
    const relative = NodePath.relative(root, sessionRoot);
    if (
      NodePath.basename(cwd) !== "project" ||
      relative.startsWith("..") ||
      NodePath.isAbsolute(relative) ||
      !NodeFS.existsSync(NodePath.join(sessionRoot, ".checkpoint-diff-fixture"))
    ) {
      throw new Error("Fixture only accepts marked projects inside its isolated root");
    }
    sessionId =
      request.params.sessionId ??
      `checkpoint-diff-${NodeCrypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`;
    result = {
      sessionId,
      models: {
        currentModelId: "grok-4.6",
        availableModels: [{ modelId: "grok-4.6", name: "Grok fixture" }],
      },
    };
  } else if (request.method === "session/prompt") {
    const prompt = (request.params.prompt ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const turn = [...prompt.matchAll(/\bFIXTURE:(FIRST|A|B|Q|F|C)\b/g)].at(-1)?.[1];
    if (!cwd || !turn) throw new Error("Prompt must contain FIXTURE:<turn>");
    if (pending.has(turn)) throw new Error("Turn already waiting for release");
    pending.add(turn);
    const scenario = manifest.turns[turn];
    for (const [name, newText] of Object.entries(scenario.files)) {
      const filename = NodePath.join(cwd, name);
      const oldText = NodeFS.readFileSync(filename, "utf8");
      NodeFS.writeFileSync(filename, newText);
      out({
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `edit-${turn}-${name}`,
            title: `Edit ${name}`,
            kind: "edit",
            status: scenario.fail ? "failed" : "completed",
            locations: [{ path: filename }],
            content: [{ type: "diff", path: filename, oldText, newText }],
          },
        },
      });
    }
    const release = NodePath.join(sessionRoot, "gates", `${turn}.release`);
    NodeFS.writeFileSync(NodePath.join(sessionRoot, "gates", `${turn}.ready`), `${turn}\n`);
    // Watch only the sanitized control directory; never log provider protocol or auth.
    await new Promise((resolve) => {
      const watcher = NodeFS.watch(NodePath.dirname(release), () => {
        if (NodeFS.existsSync(release)) {
          watcher.close();
          resolve();
        }
      });
      if (NodeFS.existsSync(release)) {
        watcher.close();
        resolve();
      }
    });
    NodeFS.unlinkSync(release);
    pending.delete(turn);
    if (scenario.fail) {
      out({ id: request.id, error: { code: -32603, message: "Synthetic failure after edit" } });
      return;
    }
    result = { stopReason: "end_turn" };
  }
  out({ id: request.id, result });
}
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  handle(request).catch(() => {
    out({
      id: request.id,
      error: { code: -32603, message: "Checkpoint diff fixture rejected request" },
    });
  });
});
