import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Public screenshot fixtures must never scan a contributor's provider homes.
const sandbox = resolve(process.argv[2] ?? ".t3");
if (sandbox === resolve(process.env.HOME, ".t3")) throw new Error("Refusing live T3 home");
const homes = join(sandbox, "usage-fixtures");
await mkdir(join(homes, "claude", "projects", "fixture"), { recursive: true });
await mkdir(join(homes, "codex"), { recursive: true });
await mkdir(join(homes, "config"), { recursive: true });
await mkdir(join(homes, "opencode"), { recursive: true });
await mkdir(join(sandbox, "userdata"), { recursive: true });
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
await writeFile(
  join(homes, "claude", "projects", "fixture", "session.jsonl"),
  records.join("\n") + "\n",
);
await writeFile(
  join(sandbox, "userdata", "settings.json"),
  JSON.stringify(
    {
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", config: { homePath: join(homes, "claude") } },
        codex: { driver: "codex", config: { homePath: join(homes, "codex") } },
        cursor: { driver: "cursor", enabled: false, config: { homePath: join(homes, "cursor") } },
        grok: { driver: "grok", enabled: false },
        opencode: {
          driver: "opencode",
          enabled: false,
          environment: [{ name: "OPENCODE_DATA_DIR", value: join(homes, "opencode") }],
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

// Cursor account history reads host environment rather than instance homePath.
console.log(
  `Start the verifier server with XDG_CONFIG_HOME=${join(homes, "config")} AGENT_CLI_CREDENTIAL_STORE=memory`,
);
