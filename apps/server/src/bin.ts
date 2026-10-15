/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `t3 acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads; everything else defers to
 * the real CLI in ./binCli.ts.
 */
import packageJson from "../package.json" with { type: "json" };
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
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
  } else if (command === "__load-bundle") {
    const { loadBundle } = await import("./loadBundle.ts");
    const chunks = await loadBundle(import.meta.url);
    process.stdout.write(`t3 v${packageJson.version}: loaded ${chunks} bundle chunks\n`);
    // A chunk may start timers or handles at load, as it would in the server.
    process.exit(0);
  } else {
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
