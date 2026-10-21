import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChatAttachmentId, ChatFileAttachment, MessageId, RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  WAKE_ASSISTANT_TEXT,
  claudeSdkFrame,
  makeResultFrame,
  wakeAssistant,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
} from "./ClaudeAdapterV2.unit.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

describe("ClaudeAdapterV2 tool calls and approvals", () => {
  describe("Claude settings restrictions", () => {
    it.effect("resolves cached managed policy from the configured home through the real SDK", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-remote-" });
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-remote-cwd-" });
        const remoteFile = path.join(home, "remote-settings.json");
        const sdk = yield* Effect.promise(() =>
          vi.importActual<typeof ClaudeSdk>("@anthropic-ai/claude-agent-sdk"),
        );
        vi.mocked(ClaudeSdk.resolveSettings).mockImplementation(sdk.resolveSettings);
        const open = Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeWakeHarnessWithOptions({
              settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home },
            });
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-cached-managed-policy"),
                text: "Run git status.",
                attachments: [],
                runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  cwd,
                }),
              }),
            );
            return harness.getOpenedOptions()!;
          }),
        );
        yield* fileSystem.writeFileString(
          remoteFile,
          JSON.stringify({
            permissions: { disableBypassPermissionsMode: "disable" },
            disableAutoMode: "disable",
            managedSourcesBehavior: "merge",
          }),
        );
        const restricted = yield* open;
        assert.equal(restricted.permissionMode, "default");
        assert.isUndefined(restricted.allowDangerouslySkipPermissions);
        yield* fileSystem.remove(remoteFile);
        assert.equal((yield* open).permissionMode, "bypassPermissions");
        yield* fileSystem.writeFileString(remoteFile, "{ invalid json");
        assert.equal((yield* open).permissionMode, "auto");
        yield* fileSystem.remove(remoteFile);
        yield* fileSystem.makeDirectory(remoteFile);
        assert.equal((yield* open).permissionMode, "auto");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("asks before restricted Full access tools and follows policy across turns", () =>
      Effect.gen(function* () {
        const resolveSettings = vi
          .mocked(ClaudeSdk.resolveSettings)
          .mockImplementation(async (options) => ({
            effective:
              options?.cwd === "/unrestricted"
                ? {}
                : {
                    permissions: {
                      disableBypassPermissionsMode: "disable",
                      ...(options?.cwd === "/restricted-worktree"
                        ? { disableAutoMode: "disable" as const }
                        : {}),
                    },
                  },
            provenance: {},
            sources: [],
          }));
        const harness = yield* makeWakeHarnessWithOptions({
          close: Queue.shutdown,
          freshQueueOnReopen: true,
          setPermissionMode: (mode) =>
            mode === "bypassPermissions"
              ? Effect.fail(
                  new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                    method: "setPermissionMode",
                    cause: new Error(
                      "Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration",
                    ),
                  }),
                )
              : Effect.void,
        });
        const now = yield* DateTime.now;
        let ordinal = 0;
        const start = (cwd: string, runtimeMode: "full-access" | "auto" = "full-access") =>
          harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(`attempt-policy-${++ordinal}`),
              providerTurnOrdinal: ordinal,
              text: "Run git status.",
              attachments: [],
              runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                runtimeMode,
                interactionMode: "default",
                cwd,
              }),
            }),
          );
        const finish = Effect.gen(function* () {
          yield* harness.offerAndWait(
            makeResultFrame({ uuid: `policy-result-${ordinal}`, result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
        });
        const notices = () =>
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
          );

        yield* start("/restricted-worktree", "auto");
        assert.equal(harness.getOpenedOptions()?.permissionMode, "auto");
        yield* finish;
        assert.equal(notices().length, 0);
        assert.equal(resolveSettings.mock.calls.length, 0);

        yield* start("/restricted");
        const openedOptions = harness.getOpenedOptions()!;
        const decision = yield* Effect.promise(() =>
          openedOptions.canUseTool!(
            "Bash",
            { command: "git status" },
            {
              signal: new AbortController().signal,
              toolUseID: "policy-command",
              requestId: "request-policy-command",
            },
          ),
        ).pipe(Effect.forkScoped);
        const first = yield* Effect.raceFirst(
          Queue.take(harness.runtimeRequestReceipts).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(decision).pipe(
            Effect.map((result) => ({ type: "decision", result }) as const),
          ),
        );
        assert.equal(
          first.type,
          "request",
          "Full access must not auto-allow a policy-restricted command",
        );
        if (first.type !== "request") return;
        assert.equal(first.event.runtimeRequest.kind, "command");
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: first.event.runtimeRequest.id,
          decision: "decline",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "deny");
        assert.equal(openedOptions.permissionMode, "auto");
        assert.isUndefined(openedOptions.allowDangerouslySkipPermissions);

        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            permissionMode: "plan",
            uuid: "policy-enter-plan",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* finish;
        assert.equal(notices().length, 1);
        yield* start("/restricted");
        assert.strictEqual(harness.getOpenedOptions(), openedOptions);
        assert.deepEqual(harness.permissionModeChanges, ["auto"]);
        assert.equal(resolveSettings.mock.calls.length, 1);
        yield* finish;

        yield* start("/restricted-worktree");
        assert.equal(harness.getOpenedOptions()?.permissionMode, "default");
        assert.isUndefined(harness.getOpenedOptions()?.allowDangerouslySkipPermissions);
        assert.equal(resolveSettings.mock.calls.length, 2);
        yield* finish;

        yield* start("/unrestricted");
        assert.equal(harness.getOpenedOptions()?.permissionMode, "bypassPermissions");
        assert.equal(harness.getOpenedOptions()?.allowDangerouslySkipPermissions, true);
        // Forwarded asks (including ask rules and settings fallback) still need a decision
        // before queued init/status frames arrive.
        for (const { phase, frame } of [
          {
            phase: "init",
            frame: claudeSdkFrame({
              type: "system",
              subtype: "init",
              permissionMode: "bypassPermissions",
              uuid: "policy-cli-init",
              session_id: WAKE_NATIVE_SESSION,
            }),
          },
          {
            phase: "status",
            frame: claudeSdkFrame({
              type: "system",
              subtype: "status",
              status: null,
              permissionMode: "default",
              uuid: "policy-cli-downgrade",
              session_id: WAKE_NATIVE_SESSION,
            }),
          },
        ]) {
          const forwardedDecision = yield* Effect.promise(() =>
            harness.getOpenedOptions()!.canUseTool!(
              "Bash",
              { command: "git status" },
              {
                signal: new AbortController().signal,
                toolUseID: `forwarded-before-${phase}`,
                requestId: `request-forwarded-before-${phase}`,
              },
            ),
          ).pipe(Effect.forkScoped);
          const forwardedFirst = yield* Effect.raceFirst(
            Queue.take(harness.runtimeRequestReceipts).pipe(
              Effect.map((event) => ({ type: "request", event }) as const),
            ),
            Fiber.join(forwardedDecision).pipe(
              Effect.map((result) => ({ type: "decision", result }) as const),
            ),
          );
          assert.equal(
            forwardedFirst.type,
            "request",
            `CLI-forwarded Bash must ask before the queued ${phase} frame reaches the adapter`,
          );
          if (forwardedFirst.type !== "request") return;
          assert.equal(forwardedFirst.event.runtimeRequest.kind, "command");
          yield* harness.runtime.respondToRuntimeRequest({
            requestId: forwardedFirst.event.runtimeRequest.id,
            decision: "decline",
          });
          assert.equal((yield* Fiber.join(forwardedDecision))?.behavior, "deny");
          yield* harness.offerAndWait(frame);
        }
        yield* finish;
        const unrestrictedOptions = harness.getOpenedOptions();
        yield* start("/unrestricted");
        assert.strictEqual(harness.getOpenedOptions(), unrestrictedOptions);
        assert.deepEqual(
          harness.permissionModeChanges,
          ["auto"],
          "A CLI policy downgrade must not be restored to bypass on the next turn",
        );
        assert.equal(resolveSettings.mock.calls.length, 3);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            permissionMode: "plan",
            uuid: "policy-restricted-enter-plan",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* finish;
        assert.equal(notices().length, 1);

        for (const phase of ["restore", "reuse"]) {
          const started = yield* start("/unrestricted").pipe(Effect.exit);
          assert.isTrue(
            Exit.isSuccess(started),
            `A rejected bypass restore must not fail the ${phase} turn`,
          );
          assert.strictEqual(harness.getOpenedOptions(), unrestrictedOptions);
          assert.deepEqual(harness.permissionModeChanges, ["auto", "bypassPermissions", "default"]);
          assert.equal(harness.offeredMessages.length, ordinal);
          const restoredDecision = yield* Effect.promise(() =>
            harness.getOpenedOptions()!.canUseTool!(
              "Bash",
              { command: "git status" },
              {
                signal: new AbortController().signal,
                toolUseID: `forwarded-after-plan-${phase}`,
                requestId: `request-after-plan-${phase}`,
              },
            ),
          ).pipe(Effect.forkScoped);
          const restoredFirst = yield* Effect.raceFirst(
            Queue.take(harness.runtimeRequestReceipts).pipe(
              Effect.map((event) => ({ type: "request", event }) as const),
            ),
            Fiber.join(restoredDecision).pipe(
              Effect.map((result) => ({ type: "decision", result }) as const),
            ),
          );
          assert.equal(restoredFirst.type, "request");
          if (restoredFirst.type !== "request") return;
          assert.equal(restoredFirst.event.runtimeRequest.kind, "command");
          yield* harness.runtime.respondToRuntimeRequest({
            requestId: restoredFirst.event.runtimeRequest.id,
            decision: "decline",
          });
          assert.equal((yield* Fiber.join(restoredDecision))?.behavior, "deny");
          yield* finish;
          assert.equal(harness.terminalEvents().at(-1)?.status, "completed");
        }
        assert.equal(notices().length, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    // regression: #21806 bypass policy reads the custom home and project, never ambient ~/.claude
    it.effect(
      "combines a normalized custom home with project policy without reading the ambient user tier",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-policy-home-",
          });
          yield* fileSystem.makeDirectory(path.join(home, "profile"));
          yield* fileSystem.writeFileString(
            path.join(home, "profile", "settings.json"),
            `{
          // Claude accepts comments and trailing commas.
          "permissions": { "disableBypassPermissionsMode": "disable", },
        }`,
          );
          const resolveSettings = vi.mocked(ClaudeSdk.resolveSettings).mockResolvedValue({
            effective: { disableAutoMode: "disable" },
            provenance: {},
            sources: [{ source: "project", settings: { disableAutoMode: "disable" } }],
          });
          const harness = yield* makeWakeHarnessWithOptions({
            settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: " ~/profile " },
          }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-custom-home"),
              text: "Run git status.",
              attachments: [],
            }),
          );
          assert.equal(harness.getOpenedOptions()?.permissionMode, "default");
          assert.isUndefined(harness.getOpenedOptions()?.allowDangerouslySkipPermissions);
          assert.deepEqual(resolveSettings.mock.calls[0]?.[0]?.settingSources, [
            "project",
            "local",
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    // regression: #21806 only a missing custom settings file is benign; bad policy fails
    it.effect(
      "distinguishes missing custom settings from unreadable, malformed, or unresolved policy",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-policy-failure-",
          });
          const settingsFile = path.join(home, "settings.json");
          const open = Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeWakeHarnessWithOptions({
                settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home },
              });
              yield* harness.runtime.startTurn(
                makeClaudeTestTurnInput({
                  threadId: harness.threadId,
                  providerThread: harness.providerThread,
                  now: yield* DateTime.now,
                  attemptId: RunAttemptId.make("attempt-settings-failure"),
                  text: "Run git status.",
                  attachments: [],
                }),
              );
              return harness.getOpenedOptions()!;
            }),
          );
          assert.equal((yield* open).permissionMode, "bypassPermissions");
          yield* fileSystem.makeDirectory(settingsFile);
          const unreadable = yield* open;
          assert.equal(unreadable.permissionMode, "auto");
          assert.isUndefined(unreadable.allowDangerouslySkipPermissions);
          yield* fileSystem.remove(settingsFile, { recursive: true });
          yield* fileSystem.writeFileString(settingsFile, "{ invalid json");
          assert.equal((yield* open).permissionMode, "auto");
          yield* fileSystem.remove(settingsFile);
          const resolveSettings = vi
            .mocked(ClaudeSdk.resolveSettings)
            .mockClear()
            .mockRejectedValueOnce(new Error("Cannot resolve managed settings"))
            .mockResolvedValue({ effective: {}, provenance: {}, sources: [] });
          const harness = yield* makeWakeHarnessWithOptions({
            settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home },
            close: Queue.shutdown,
            freshQueueOnReopen: true,
          });
          for (const ordinal of [1, 2]) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make(`attempt-settings-recovery-${ordinal}`),
                providerTurnOrdinal: ordinal,
                text: "Run git status.",
                attachments: [],
              }),
            );
            const options = harness.getOpenedOptions()!;
            assert.equal(
              options.permissionMode,
              ordinal === 1 ? "auto" : "bypassPermissions",
              "A transient resolver failure must only downgrade the failing turn",
            );
            if (ordinal === 1) assert.isUndefined(options.allowDangerouslySkipPermissions);
            else assert.equal(options.allowDangerouslySkipPermissions, true);
            assert.equal(resolveSettings.mock.calls.length, ordinal);
            yield* harness.offerAndWait(
              makeResultFrame({ uuid: `settings-recovery-result-${ordinal}`, result: "Done." }),
            );
            assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          }
          assert.equal(harness.offeredMessages.length, 2);
          assert.equal(
            resolveSettings.mock.calls[0]?.[0]?.cwd,
            resolveSettings.mock.calls[1]?.[0]?.cwd,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );
  });

  describe("Plan-mode tool approval", () => {
    const openPlanTurn = Effect.fn("openPlanTurn")(function* (
      runtimeMode: "auto" | "full-access",
      approvalPolicy?: "never",
    ) {
      const harness = yield* makeWakeHarness;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "plan",
        cwd: "/workspace",
        ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      });
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-claude-plan-write"),
        text: "Investigate before implementing.",
        attachments: [],
        runtimePolicy,
      });
      yield* harness.runtime.startTurn({
        ...input,
        appThread: { ...input.appThread, runtimeMode, interactionMode: "plan" },
      });
      assert.equal(harness.getOpenedOptions()?.permissionMode, "plan");
      const canUseTool = harness.getOpenedOptions()?.canUseTool;
      assert.isDefined(canUseTool);
      return { ...harness, canUseTool: canUseTool! };
    });

    const requestWrite = Effect.fn("requestPlanWrite")(function* (
      turn: Effect.Success<ReturnType<typeof openPlanTurn>>,
      toolName: string,
      toolInput: Record<string, unknown>,
    ) {
      const decision = yield* Effect.promise(() =>
        turn.canUseTool(toolName, toolInput, {
          signal: new AbortController().signal,
          toolUseID: "tool-plan-write",
          requestId: "request-plan-write",
        }),
      ).pipe(Effect.forkScoped);
      const first = yield* Effect.raceFirst(
        Queue.take(turn.runtimeRequestReceipts).pipe(
          Effect.map((event) => ({ type: "request", event }) as const),
        ),
        Fiber.join(decision).pipe(Effect.map((result) => ({ type: "decision", result }) as const)),
      );
      return { first, decision };
    });

    it.effect.each([
      {
        runtimeMode: "auto",
        toolName: "Edit",
        toolInput: {
          file_path: "/workspace/target.txt",
          old_string: "before",
          new_string: "after",
        },
        kind: "file-change",
        decision: "accept",
        behavior: "allow",
      },
      {
        runtimeMode: "full-access",
        toolName: "Bash",
        toolInput: { command: "echo after > target.txt" },
        kind: "command",
        decision: "cancel",
        behavior: "deny",
      },
    ] as const)(
      "asks before $toolName in $runtimeMode Plan, then respects $decision",
      ({ runtimeMode, toolName, toolInput, kind, decision, behavior }) =>
        Effect.gen(function* () {
          const turn = yield* openPlanTurn(runtimeMode);
          const permission = yield* requestWrite(turn, toolName, toolInput);
          assert.equal(permission.first.type, "request", "the planned write bypassed approval");
          if (permission.first.type !== "request") return;
          const request = permission.first.event.runtimeRequest;
          assert.equal(request.status, "pending");
          assert.equal(request.kind, kind);
          yield* turn.runtime.respondToRuntimeRequest({ requestId: request.id, decision });
          const result = yield* Fiber.join(permission.decision);
          assert.equal(result?.behavior, behavior);
          if (result?.behavior === "allow") {
            assert.deepEqual(result.updatedInput, toolInput);
            assert.equal(result.toolUseID, "tool-plan-write");
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    it.effect("denies Plan writes without asking when approvals are never allowed", () =>
      Effect.gen(function* () {
        const turn = yield* openPlanTurn("full-access", "never");
        const permission = yield* requestWrite(turn, "Bash", {
          command: "echo after > target.txt",
        });
        assert.equal(permission.first.type, "decision", "Never raised an approval request");
        if (permission.first.type !== "decision") return;
        assert.equal(permission.first.result?.behavior, "deny");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("still captures ExitPlanMode when Plan approvals are never allowed", () =>
      Effect.gen(function* () {
        const turn = yield* openPlanTurn("full-access", "never");
        const markdown = "# Proposed work\n\nFix the calculation after approval.";
        const result = yield* Effect.promise(() =>
          turn.canUseTool(
            "ExitPlanMode",
            { plan: markdown },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-plan-capture",
              requestId: "request-plan-capture",
            },
          ),
        );
        assert.equal(result?.behavior, "deny");
        if (result?.behavior === "deny")
          assert.include(result.message, "captured your proposed plan");
        const event = yield* Queue.take(turn.planReceipts);
        assert.equal(event.plan.kind, "proposed_plan");
        assert.equal(event.plan.kind === "proposed_plan" ? event.plan.markdown : "", markdown);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );
  });

  it.effect(
    "carries earlier user-only skill instructions on sends and steering with attachments",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skill-dispatch-" });
        for (const [name, userOnly] of [
          ["interrogate", true],
          ["implement", true],
          ["review", false],
        ] as const) {
          const directory = path.join(homePath, "skills", name);
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(
            path.join(directory, "SKILL.md"),
            `---\nname: ${name}\ndisable-model-invocation: ${userOnly}\n---\nFollow the ${name} instructions.\n`,
          );
        }
        const harness = yield* makeWakeHarnessWithOptions({
          settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath },
        });
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("skill-dispatch"),
          text: "$interrogate then $review then $implement the fixes",
          attachments: [],
          runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, cwd: homePath },
        });
        yield* harness.runtime.startTurn(input);

        const leadingText = `Ultrathink:\n/interrogate [The user invoked this skill. Follow the instructions at: ${path.join(homePath, "skills", "interrogate", "SKILL.md")}] then /review then /implement the fixes`;
        assert.deepEqual(harness.offeredMessages[0]?.message.content, [
          { type: "text", text: leadingText },
          { type: "text", text: "/implement the fixes" },
        ]);

        const attachment = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make("skill-dispatch-12345678-1234-1234-1234-123456789abc"),
          name: "requirements.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        });
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${input.attemptId}`,
          }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("skill-dispatch-steer"),
            text: input.message.text,
            attachments: [attachment],
          },
        });
        const attachmentNote = `\n\n[Attached file "requirements.pdf" is saved at: ${path.join(harness.attachmentsDir, attachmentRelativePath(attachment)!)}]`;
        assert.equal(harness.offeredMessages[1]?.priority, "now");
        assert.deepEqual(harness.offeredMessages[1]?.message.content, [
          { type: "text", text: `${leadingText}${attachmentNote}` },
          { type: "text", text: `/implement the fixes${attachmentNote}` },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  // regression: #15475 MCP title arriving after the tool starts must survive to completion
  it.effect.each([
    { isError: false, title: "Check weather" },
    { isError: true, title: "Check weather" },
    { isError: false, title: undefined },
  ])("keeps late MCP display metadata with %j", ({ isError, title }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("mcp-presentation"),
          text: "Check the weather",
          attachments: [],
        }),
      );
      const toolName = "mcp__weather__get_weather";
      const id = "weather-call";
      const permission = yield* Effect.promise(() =>
        harness.getOpenedOptions()!.canUseTool!(
          toolName,
          { city: "Berlin" },
          {
            signal: new AbortController().signal,
            toolUseID: id,
            requestId: "weather-request",
          },
        ),
      ).pipe(Effect.forkScoped);
      const request = yield* Queue.take(harness.runtimeRequestReceipts);
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        decision: "accept",
      });
      yield* Fiber.join(permission);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "assistant",
          uuid: "weather-assistant",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "weather-message",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", id, name: toolName, input: { city: "Berlin" } }],
          },
          tool_use_meta: [
            {
              id,
              display_name: title,
              server_display_name: "Weather",
              icon_url: "https://example.com/weather.png",
            },
          ],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "user",
          uuid: "weather-result",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: "Weather result",
                is_error: isError,
              },
            ],
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "weather-terminal", result: "Weather checked" }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const items = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        items.map((item) => item.status),
        ["running", "running", isError ? "failed" : "completed"],
      );
      assert.isNull(items[0]?.title);
      for (const item of items.slice(1)) {
        assert.equal(item.title, title ?? "get weather");
        assert.deepEqual(item.toolIcon, {
          _tag: "themed-logo",
          logoUrl: "https://example.com/weather.png",
        });
        assert.deepEqual(item.toolSource, {
          key: "mcp:weather",
          name: "Weather",
          kind: "integration",
          icon: { _tag: "themed-logo", logoUrl: "https://example.com/weather.png" },
        });
        assert.deepEqual(item.input, { city: "Berlin" });
      }
      assert.equal(new Set(items.map((item) => item.id)).size, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each(["completed", "interrupted"] as const)(
    "projects Claude thinking blocks when %s",
    (status) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("reasoning-attempt"),
            text: "Check the plan",
            attachments: [],
          }),
        );
        const stream = (event: unknown, parent: string | null = null) =>
          claudeSdkFrame({
            type: "stream_event",
            event,
            parent_tool_use_id: parent,
            session_id: WAKE_NATIVE_SESSION,
            uuid: "stream-frame",
          });
        const snapshot = (id: string, uuid: string, thinking: string) =>
          claudeSdkFrame({
            type: "assistant",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
            parent_tool_use_id: null,
            message: {
              id,
              model: "claude-sonnet-4-6",
              content: [{ type: "thinking", thinking, signature: "secret-signature" }],
            },
          });
        const frames = [
          stream({ type: "message_start", message: { id: "thought-message" } }),
          stream({
            type: "content_block_start",
            index: 2,
            content_block: { type: "thinking", thinking: "" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "First " },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "thought" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "signature_delta", signature: "secret-signature" },
          }),
          stream({ type: "content_block_stop", index: 2 }),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          stream({
            type: "content_block_start",
            index: 4,
            content_block: { type: "thinking", thinking: "Second thought" },
          }),
          stream({ type: "content_block_stop", index: 4 }),
          snapshot("thought-message", "second-snapshot", ""),
          snapshot("completion-only", "third-snapshot", "Completion only"),
          snapshot("redacted", "empty-snapshot", ""),
          stream({ type: "message_start", message: { id: "child-message" } }, "child-tool"),
          stream(
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "Child thought" },
            },
            "child-tool",
          ),
          stream({ type: "message_start", message: { id: "partial-message" } }),
          stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "Partial thought" },
          }),
          makeResultFrame({
            uuid: "reasoning-result",
            result: "",
            ...(status === "interrupted" ? { terminalReason: "aborted_streaming" as const } : {}),
          }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, status);
        const latest = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        assert.deepEqual(
          [...latest.values()].map((item) => item.text),
          ["Authoritative first thought", "Second thought", "Completion only", "Partial thought"],
        );
        assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, 4);
        for (const item of latest.values()) {
          assert.equal(item.streaming, false);
          assert.isNotNull(item.completedAt);
        }
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          ),
        );
        for (const item of latest.values()) assert.notInclude(item.text, "secret-signature");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  // regression: #15892 non-execution metadata is carried through, not guessed from result text
  it.effect.each(["cancelled", "denied", "permission_denied", undefined])(
    "preserves native tool non-execution metadata %s without inferring a denial from text",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-tool-non-execution"),
              text: "Run the tool.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "user",
              uuid: "tool-non-execution",
              session_id: WAKE_NATIVE_SESSION,
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-error",
                    is_error: true,
                    content: "STOP and wait for the user.",
                  },
                  { type: "tool_result", tool_use_id: "tool-ok", is_error: false, content: "OK" },
                ],
              },
              ...(kind === undefined
                ? {}
                : {
                    tool_result_meta: [
                      { id: "tool-error", non_execution_kind: kind },
                      { id: "tool-ok", non_execution_kind: null },
                    ],
                  }),
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "result-non-execution", result: "Done" }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const items = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
              ? [event.turnItem]
              : [],
          );
          const failed = items.findLast((item) => item.nativeItemRef?.nativeId === "tool-error")!;
          assert.equal(failed.status, kind === "cancelled" ? "cancelled" : "failed");
          assert.equal(failed.toolNonExecutionKind, kind);
          const ok = items.findLast((item) => item.nativeItemRef?.nativeId === "tool-ok")!;
          assert.equal(ok.status, "completed");
          assert.equal(ok.toolNonExecutionKind, undefined);
          const node = harness.events.findLast(
            (event) =>
              event.type === "node.updated" && event.node.nativeItemRef?.nativeId === "tool-error",
          );
          assert.equal(node?.type === "node.updated" ? node.node.status : undefined, failed.status);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(
    (["aborted_tools", "aborted_streaming"] as const).flatMap((terminalReason) =>
      [true, false].map((steered) => ({ terminalReason, steered })),
    ),
  )("handles $terminalReason with active steering=$steered", ({ terminalReason, steered }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attemptId = RunAttemptId.make("attempt-steering-abort");
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId,
          text: "Audit the settings pages.",
          attachments: [],
        });
        yield* harness.runtime.startTurn(input);
        if (steered) {
          yield* harness.runtime.steerTurn({
            threadId: harness.threadId,
            runId: input.runId,
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            }),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-steering-abort"),
              text: "Include the hierarchy mock.",
              attachments: [],
            },
          });
          assert.equal(harness.offeredMessages[1]?.priority, "now");
        }
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000901",
            result: "",
            terminalReason,
            usage: {
              input_tokens: 600,
              output_tokens: 40,
              cache_creation_input_tokens: 500,
              cache_read_input_tokens: 2000,
            },
          }),
        );
        if (steered) {
          yield* Queue.offer(harness.sdkMessages, wakeAssistant);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000902",
              result: "Audit finished after the steer.",
              usage: {
                input_tokens: 3,
                output_tokens: 6,
                cache_creation_input_tokens: 2347,
                cache_read_input_tokens: 9455,
              },
            }),
          );
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, steered ? "completed" : "interrupted");
        if (steered) {
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                event.turnItem.text === WAKE_ASSISTANT_TEXT,
            ),
          );
          const completed = harness.events.findLast(
            (event) => event.type === "provider_turn.updated",
          );
          assert.deepEqual(
            completed?.type === "provider_turn.updated"
              ? completed.providerTurn.turnTokenUsage
              : undefined,
            {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              inputTokens: 603 + 2847 + 11455,
              outputTokens: 46,
              cachedInputTokens: 11455,
              cacheCreationTokens: 2847,
            },
          );
        }
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
