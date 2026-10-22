import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const gates = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "selection-fixture-"));
const child = NodeChildProcess.spawn(
  process.execPath,
  [NodeURL.fileURLToPath(new URL("gated-acp.mjs", import.meta.url)), gates],
  {
    stdio: ["pipe", "pipe", "inherit"],
  },
);
const messages = [];
const waiters = new Set();
const lines = NodeReadline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  messages.push(JSON.parse(line));
  for (const waiter of waiters) waiter();
});
const exited = new Promise((resolve) => child.once("exit", resolve));
const deadline = setTimeout(() => {
  console.error("Fixture self-check timed out");
  child.kill();
}, 30_000);
function until(predicate) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const result = predicate();
      if (result) {
        waiters.delete(check);
        resolve(result);
      }
    };
    waiters.add(check);
    check();
    exited.then(() => reject(new Error("Fixture exited before expected message")));
  });
}
function marker(name) {
  return new Promise((resolve) => {
    const watcher = NodeFS.watch(gates, () => {
      if (NodeFS.existsSync(NodePath.join(gates, name))) {
        watcher.close();
        resolve();
      }
    });
    if (NodeFS.existsSync(NodePath.join(gates, name))) {
      watcher.close();
      resolve();
    }
  });
}
function request(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return until(() => messages.find((message) => message.id === id));
}
function gate(action) {
  return new Promise((done, reject) => {
    const controller = NodeChildProcess.spawn(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("gate.mjs", import.meta.url)), gates, action],
      { stdio: "inherit" },
    );
    controller.once("error", reject);
    controller.once("exit", (code) =>
      code === 0 ? done() : reject(new Error(`Gate exited ${code}`)),
    );
  });
}
const chunks = () =>
  messages.filter((message) => message.params?.update?.sessionUpdate === "agent_message_chunk");
try {
  const initialized = await request(1, "initialize", {
    protocolVersion: 2,
    capabilities: {},
    info: { name: "selection-fixture-check", version: "1" },
  });
  NodeAssert.ok(initialized.result, JSON.stringify(initialized));
  const created = await request(2, "session/new", { cwd: NodeOS.tmpdir(), mcpServers: [] });
  NodeAssert.ok(created.result?.sessionId, JSON.stringify(created));
  const completed = request(3, "session/prompt", {
    sessionId: created.result.sessionId,
    prompt: [{ type: "text", text: "Synthetic fixture" }],
  });
  await Promise.all([marker("chunk-buffered"), marker("response-buffered")]);
  await gate("ready");
  NodeAssert.equal(chunks().length, 0);
  NodeAssert.equal(
    messages.some((message) => message.params?.update?.state === "idle"),
    false,
  );
  NodeAssert.equal(
    messages.some((message) => message.id === 3),
    false,
  );
  await gate("append");
  await until(() => chunks().length === 1);
  NodeAssert.equal(
    messages.some((message) => message.id === 3),
    false,
  );
  await gate("grow");
  await until(() => chunks().length === 2);
  NodeAssert.equal(chunks()[0].params.update.messageId, chunks()[1].params.update.messageId);
  NodeAssert.equal(chunks()[0].params.sessionId, created.result.sessionId);
  const text = chunks()
    .map((message) => message.params.update.content.text)
    .join("");
  NodeAssert.equal(
    text,
    Array.from(
      { length: 16 },
      (_, i) => `Selection fixture line ${i + 1}: alpha bravo charlie delta echo foxtrot.`,
    ).join("\n"),
  );
  NodeAssert.equal(
    messages.some((message) => message.id === 3),
    false,
  );
  NodeAssert.equal(
    messages.some((message) => message.params?.update?.state === "idle"),
    false,
  );
  await gate("complete");
  NodeAssert.deepEqual((await completed).result, {});
  NodeAssert.ok(
    messages.some(
      (message) =>
        message.params?.update?.state === "idle" && message.params.update.stopReason === "end_turn",
    ),
  );
  const malformed = NodeChildProcess.spawn(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("gated-acp.mjs", import.meta.url)),
      NodePath.join(gates, "malformed"),
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let diagnostic = "";
  malformed.stderr.on("data", (data) => {
    diagnostic += data.toString();
  });
  const malformedExit = new Promise((done) => malformed.once("exit", done));
  malformed.stdin.end("malformed ".repeat(3000) + "\n");
  NodeAssert.equal(await malformedExit, 1);
  NodeAssert.match(diagnostic, /malformed JSON-RPC line; payload omitted/);
  NodeAssert.ok(diagnostic.length < 3000);
  NodeAssert.ok(!diagnostic.includes("malformed malformed"));
  console.log(
    "Passed: initialization, session creation, blocked chunks, same-message growth, gated completion.",
  );
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  await exited;
  lines.close();
  NodeFS.rmSync(gates, { recursive: true, force: true });
}
