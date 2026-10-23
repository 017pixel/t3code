import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Public screenshot fixtures must never scan a contributor's provider homes.
const sandbox = NodePath.resolve(process.argv[2] ?? ".t3");
if (sandbox === NodePath.resolve(process.env.HOME, ".t3")) throw new Error("Refusing live T3 home");
const homes = NodePath.join(sandbox, "usage-fixtures");
await NodeFSP.mkdir(homes, { recursive: true });
await NodeFSP.mkdir(NodePath.join(homes, "claude", "projects", "fixture"), { recursive: true });
await NodeFSP.mkdir(NodePath.join(homes, "codex"), { recursive: true });
await NodeFSP.mkdir(NodePath.join(homes, "config"), { recursive: true });
await NodeFSP.mkdir(NodePath.join(homes, "opencode"), { recursive: true });
await NodeFSP.mkdir(NodePath.join(sandbox, "userdata"), { recursive: true });
const now = new Date(process.argv[3] ?? "2026-10-23T12:00:00Z");
const records = [0, 1, 5, 12, 25, 60].map((days, i) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(+now - days * 86400000 - i * 3600000).toISOString(),
    requestId: `fixture-request-${i}`,
    sessionId: "fixture-session",
    message: {
      id: `fixture-message-${i}`,
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 10000 * (i + 1), output_tokens: 2000 * (i + 1) },
    },
  }),
);
await NodeFSP.writeFile(
  NodePath.join(homes, "claude", "projects", "fixture", "session.jsonl"),
  records.join("\n") + "\n",
);
await NodeFSP.writeFile(
  NodePath.join(sandbox, "userdata", "settings.json"),
  JSON.stringify(
    {
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          config: { homePath: NodePath.join(homes, "claude") },
        },
        codex: { driver: "codex", config: { homePath: NodePath.join(homes, "codex") } },
        cursor: {
          driver: "cursor",
          enabled: false,
          config: { homePath: NodePath.join(homes, "cursor") },
        },
        grok: { driver: "grok", enabled: false },
        opencode: {
          driver: "opencode",
          enabled: false,
          environment: [{ name: "OPENCODE_DATA_DIR", value: NodePath.join(homes, "opencode") }],
        },
        antigravity: { driver: "antigravity", enabled: false },
      },
      usageLimitSources: {},
      cursorKeychainUsageEnabled: false,
    },
    null,
    2,
  ) + "\n",
);
console.log("Seeded synthetic usage in", sandbox);

// Some usage readers ignore enabled and resolve history from host env overrides
// (CODEX_HOME, GROK_HOME, PI_CODING_AGENT_DIR, ...), so start from an empty env.
console.log(
  `Start the verifier server under: env -i PATH="$PATH" HOME=${homes} XDG_CONFIG_HOME=${NodePath.join(homes, "config")} XDG_DATA_HOME=${NodePath.join(homes, "data")} XDG_STATE_HOME=${NodePath.join(homes, "state")} AGENT_CLI_CREDENTIAL_STORE=memory`,
);
