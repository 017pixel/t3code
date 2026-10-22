#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// Transparent CLI observer: retain only user text blocks, never env, auth, or control frames.
const executable = process.env.T3_CLAUDE_OBSERVER_EXECUTABLE;
const output = process.env.T3_CLAUDE_OBSERVER_OUTPUT;
if (!executable || !output?.startsWith("/tmp/")) {
  throw new Error("Set T3_CLAUDE_OBSERVER_EXECUTABLE and /tmp T3_CLAUDE_OBSERVER_OUTPUT");
}
const child = NodeChildProcess.spawn(executable, process.argv.slice(2), {
  stdio: ["pipe", "inherit", "inherit"],
});
let pending = "";
process.stdin.on("data", (chunk) => {
  child.stdin.write(chunk);
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value.type !== "user") continue;
      const blocks = value.message?.content;
      const texts =
        typeof blocks === "string"
          ? [blocks]
          : blocks?.filter((b) => b.type === "text").map((b) => b.text);
      NodeFS.appendFileSync(
        output,
        JSON.stringify({ at: new Date().toISOString(), pid: process.pid, texts }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      /* Non-JSON CLI input is forwarded without recording. */
    }
  }
});
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
