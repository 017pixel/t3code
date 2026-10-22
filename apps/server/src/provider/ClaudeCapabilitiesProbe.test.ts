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

it.effect("lists commands that mods register in their session.start hook", () =>
  Effect.gen(function* () {
    const builtin = { name: "review", description: "", argumentHint: "" };
    const modCommand = { name: "handoffs", description: "", argumentHint: "" };
    // Mirrors Claude Code 2.1.303: a mod's session.start hook registers its
    // command after init, so init omits it and a commands_changed push carries
    // it. With all hooks disabled the hook never runs and the command never
    // appears.
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      const hooksRun =
        options?.settings === undefined || typeof options.settings === "string"
          ? true
          : options.settings.disableAllHooks !== true;
      let commands = [builtin];
      // The SDK transport tracks the push even when nobody reads the stream.
      const registered = Promise.resolve().then(() => {
        if (hooksRun) commands = [builtin, modCommand];
      });
      const messages = (async function* () {
        await registered;
        if (hooksRun) yield { type: "system", subtype: "commands_changed", commands } as never;
        await new Promise((resolve) =>
          options?.abortController?.signal.addEventListener("abort", resolve),
        );
      })();
      return Object.assign(messages, {
        initializationResult: async () => ({ commands: [builtin], account: {} }),
        supportedCommands: async () => commands,
      }) as unknown as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));

    const probe = yield* probeClaudeCapabilities(DEFAULT_CLAUDE_SETTINGS, {}, undefined, false);

    assert.include(
      probe.slashCommands.map((command) => command.name),
      "handoffs",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
