// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

// Mirrors Claude Code 2.1.295 and 2.1.303: initialize answers only after
// session.start hooks finish, so a mod's registered command is in init unless
// hooks are disabled, in which case the hook never runs.
const mockClaudeWithMod = () =>
  vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
    const hooksRun =
      options?.settings === undefined || typeof options.settings === "string"
        ? true
        : options.settings.disableAllHooks !== true;
    const builtin = { name: "review", description: "", argumentHint: "" };
    const modCommand = { name: "handoffs", description: "", argumentHint: "" };
    // oxlint-disable-next-line require-yield -- the stream stays open until abort, like the real SDK query
    const messages = (async function* () {
      await new Promise((resolve) =>
        options?.abortController?.signal.addEventListener("abort", resolve),
      );
    })();
    return Object.assign(messages, {
      initializationResult: async () => ({
        commands: hooksRun ? [builtin, modCommand] : [builtin],
        account: {},
      }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw new Error("usage unavailable");
      },
    }) as unknown as ReturnType<typeof ClaudeSdk.query>;
  });

const probeCommandNames = (healthCheck: boolean) =>
  Effect.gen(function* () {
    const query = mockClaudeWithMod();
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(
      DEFAULT_CLAUDE_SETTINGS,
      {},
      undefined,
      healthCheck,
    );
    return probe.slashCommands.map((command) => command.name);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("workspace discovery lists commands that mods register in session.start", () =>
  Effect.gen(function* () {
    assert.include(yield* probeCommandNames(false), "handoffs");
  }),
);

it.effect("the periodic health check does not run session.start hooks", () =>
  Effect.gen(function* () {
    assert.notInclude(yield* probeCommandNames(true), "handoffs");
  }),
);
