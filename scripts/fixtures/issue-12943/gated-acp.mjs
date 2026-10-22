import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const responseText = Array.from(
  { length: 16 },
  (_, i) => `Selection fixture line ${i + 1}: alpha bravo charlie delta echo foxtrot.`,
).join("\n");

const gateDir = NodePath.resolve(process.argv[2] ?? process.env.T3_SELECTION_GATE_DIR ?? "");
if (!process.argv[2] && !process.env.T3_SELECTION_GATE_DIR) {
  throw new Error("Provide a fresh gate directory as argv[2] or T3_SELECTION_GATE_DIR");
}
NodeFS.mkdirSync(gateDir, { recursive: true });
for (const name of ["append", "grow", "complete", "chunk-buffered", "response-buffered"]) {
  if (NodeFS.existsSync(NodePath.resolve(gateDir, name)))
    throw new Error(`Gate directory is not fresh: ${name}`);
}
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodeURL.fileURLToPath(
      new URL("../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
    ),
  ],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, T3_ACP_PROMPT_RESPONSE_TEXT: responseText },
  },
);
let prompt;
let chunk;
let response;
const terminalUpdates = [];
let stage = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const mark = (name) => NodeFS.writeFileSync(NodePath.resolve(gateDir, name), "ready\n");
function release() {
  if (chunk && stage === 0 && NodeFS.existsSync(NodePath.resolve(gateDir, "append"))) {
    const text = chunk.params.update.content.text;
    const split = Math.ceil(text.length / 2);
    send({
      ...chunk,
      params: {
        ...chunk.params,
        update: { ...chunk.params.update, content: { type: "text", text: text.slice(0, split) } },
      },
    });
    stage = 1;
    mark("append-released");
  }
  if (chunk && stage === 1 && NodeFS.existsSync(NodePath.resolve(gateDir, "grow"))) {
    const text = chunk.params.update.content.text;
    send({
      ...chunk,
      params: {
        ...chunk.params,
        update: {
          ...chunk.params.update,
          content: { type: "text", text: text.slice(Math.ceil(text.length / 2)) },
        },
      },
    });
    stage = 2;
    mark("grow-released");
  }
  if (response && stage === 2 && NodeFS.existsSync(NodePath.resolve(gateDir, "complete"))) {
    for (const update of terminalUpdates) send(update);
    send(response);
    response = undefined;
    stage = 3;
    mark("complete-released");
  }
}
// Watch before checking so a remotely created gate cannot fall between subscription and check.
const watcher = NodeFS.watch(gateDir, release);
readMessages(process.stdin, (message) => {
  if (message.method === "session/prompt") {
    if (prompt) throw new Error("Use a fresh fixture process for each prompt");
    prompt = { id: message.id, sessionId: message.params.sessionId };
  }
  if (!child.stdin.write(`${JSON.stringify(message)}\n`)) process.stdin.pause();
});
readMessages(child.stdout, (message) => {
  if (
    prompt &&
    message.method === "session/update" &&
    message.params?.sessionId === prompt.sessionId &&
    message.params.update?.sessionUpdate === "agent_message_chunk"
  ) {
    if (chunk) throw new Error("Expected one mock assistant chunk");
    chunk = message;
    mark("chunk-buffered");
  } else if (
    prompt &&
    message.method === "session/update" &&
    message.params?.sessionId === prompt.sessionId &&
    message.params.update?.sessionUpdate === "state_update" &&
    message.params.update.state === "idle"
  ) {
    // ACP v2 ends the turn with idle before returning the prompt response.
    terminalUpdates.push(message);
  } else if (prompt && message.id === prompt.id && !message.method) {
    response = message;
    mark("response-buffered");
  } else {
    send(message);
  }
  release();
});
child.stdin.on("drain", () => process.stdin.resume());
process.stdin.on("end", () => child.stdin.end());
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  watcher.close();
});
child.on("exit", (code) => {
  watcher.close();
  process.exit(process.exitCode || code || 0);
});

// Bound partial lines without repeatedly copying their accumulated prefix.
function readMessages(stream, consume) {
  let fragments = [];
  let size = 0;
  const limit = 64 * 1024;
  function fail(message) {
    console.error(`Selection fixture: ${message}; payload omitted`);
    child.kill("SIGTERM");
    process.exitCode = 1;
    stream.destroy();
  }
  stream.on("data", (data) => {
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(10, offset);
      const end = newline === -1 ? data.length : newline;
      const fragment = data.subarray(offset, end);
      size += fragment.length;
      if (size > limit) {
        fail("JSON-RPC line exceeds 64 KiB");
        return;
      }
      fragments.push(fragment);
      if (newline === -1) return;
      let message;
      try {
        message = JSON.parse(Buffer.concat(fragments, size).toString("utf8"));
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("Expected object");
        }
      } catch {
        fail("malformed JSON-RPC line");
        return;
      }
      fragments = [];
      size = 0;
      consume(message);
      offset = end + 1;
    }
  });
  stream.on("end", () => {
    if (size !== 0) fail("unterminated JSON-RPC line");
  });
}
