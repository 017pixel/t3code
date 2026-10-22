// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
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
const mockClaudeWithMod = (hook: "registers" | "never-finishes" = "registers") => {
  const hookRuns = { count: 0 };
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
    const hooksRun =
      options?.settings === undefined || typeof options.settings === "string"
        ? true
        : options.settings.disableAllHooks !== true;
    if (hooksRun) hookRuns.count += 1;
    markStarted();
    const builtin = { name: "review", description: "", argumentHint: "" };
    const modCommand = { name: "handoffs", description: "", argumentHint: "" };
    // oxlint-disable-next-line require-yield -- the stream stays open until abort, like the real SDK query
    const messages = (async function* () {
      await new Promise((resolve) =>
        options?.abortController?.signal.addEventListener("abort", resolve),
      );
    })();
    return Object.assign(messages, {
      initializationResult: () =>
        hooksRun && hook === "never-finishes"
          ? new Promise<never>(() => {})
          : Promise.resolve({
              commands: hooksRun ? [builtin, modCommand] : [builtin],
              account: {},
            }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw new Error("usage unavailable");
      },
    }) as unknown as ReturnType<typeof ClaudeSdk.query>;
  });
  return { query, hookRuns, started };
};

const MACHINE_SNAPSHOT = {
  ...buildServerProvider({
    presentation: { displayName: "Claude" },
    enabled: true,
    checkedAt: "2026-10-22T00:00:00.000Z",
    models: [],
    slashCommands: [{ name: "review" }],
    probe: {
      installed: true,
      version: "2.1.303",
      status: "ready",
      auth: { status: "authenticated" },
    },
  }),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
};

const scanWorkspace = (hook: "registers" | "never-finishes", runHooks: boolean) =>
  Effect.gen(function* () {
    const { query, hookRuns, started } = mockClaudeWithMod(hook);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const scan = yield* probeClaudeWorkspaceSnapshot(
      DEFAULT_CLAUDE_SETTINGS,
      MACHINE_SNAPSHOT,
      NodeOS.tmpdir(),
      {},
      runHooks,
    ).pipe(Effect.forkChild);
    // The probe deadline runs on the test clock, so a hook that never
    // finishes reaches it without any real waiting.
    yield* Effect.promise(() => started);
    yield* TestClock.adjust("30 seconds");
    const snapshot = yield* Fiber.join(scan);
    return {
      commands: snapshot.slashCommands.map((command) => command.name),
      pending: snapshot.slashCommandsPending,
      hookRuns: hookRuns.count,
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("a scan that may run hooks lists commands that mods register in session.start", () =>
  Effect.gen(function* () {
    const scan = yield* scanWorkspace("registers", true);
    assert.include(scan.commands, "handoffs");
    assert.equal(scan.pending, false);
  }),
);

it.effect("a scan for a read-only caller does not run session.start hooks", () =>
  Effect.gen(function* () {
    const scan = yield* scanWorkspace("registers", false);
    assert.equal(scan.hookRuns, 0);
    assert.notInclude(scan.commands, "handoffs");
    assert.include(scan.commands, "review");
  }),
);

it.effect("a hook that outlasts the probe keeps the machine commands and is not retried", () =>
  Effect.gen(function* () {
    const scan = yield* scanWorkspace("never-finishes", true);
    assert.equal(scan.hookRuns, 1);
    assert.includeMembers(scan.commands, ["compact", "review"]);
    assert.equal(scan.pending, false);
  }),
);

it.effect("the periodic health check does not run session.start hooks", () =>
  Effect.gen(function* () {
    const { query, hookRuns } = mockClaudeWithMod();
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(DEFAULT_CLAUDE_SETTINGS, {}, undefined, true);
    assert.equal(hookRuns.count, 0);
    assert.notInclude(
      probe.slashCommands.map((command) => command.name),
      "handoffs",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
