/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `t3 acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads; everything else defers to
 * the real CLI in ./binCli.ts. The server's spawn host (`t3 __spawn-host`)
 * starts here for the same reason, and to stay small.
 */
import packageJson from "../package.json" with { type: "json" };
import * as NodeSea from "node:sea";
import { enableCliCompileCache } from "./cliCompileCache.ts";
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (!(process.argv.length === 3 && command === "--version")) {
    enableCliCompileCache({
      bundled: NodeSea.isSea() || import.meta.url.endsWith(".mjs"),
      argv: process.argv.slice(2),
      environment: process.env,
    });
  }
  if (process.argv.length === 3 && command === "--version") {
    process.stdout.write(`t3 v${packageJson.version}\n`);
  } else if (
    command === "pair" ||
    command === "auth" ||
    command === "service" ||
    command === "project" ||
    command === "serve" ||
    command === "start"
  ) {
    const { runLightCli } = await import("./binLightCli.ts");
    await runLightCli(command);
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "__spawn-host") {
    const { runSpawnHost } = await import("./process/spawnHostProcess.ts");
    runSpawnHost();
  } else {
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
