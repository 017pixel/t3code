import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  WAKE_TASK_ID,
  WAKE_SUMMARY,
  WAKE_RESULT_TEXT,
  claudeSdkFrame,
  wakeTaskStarted,
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
  turnOneResult,
  wakeNotification,
  wakeAssistant,
  wakeTurnInit,
  wakeResult,
  STALE_TASK_NOTIFICATION_RESULT_TEXT,
  staleTaskNotificationResult,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  makeSubagentTaskStartedFrame,
  makeSubagentNotificationFrame,
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

describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect.each(["full-access", "approval-required"] as const)(
    "keeps a queued wake turn's tool callback with its continuation in %s mode",
    (runtimeMode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode,
            interactionMode: "default",
            cwd: "/workspace",
          });
          const firstAttempt = RunAttemptId.make("attempt-claude-wake-callback-1");
          const userAttempt = RunAttemptId.make("attempt-claude-wake-callback-2");
          const continuationAttempt = RunAttemptId.make("attempt-claude-wake-callback-3");
          const planToolUseId = "toolu_01WakePlanExitPlanMode";
          const planMarkdown = "# Wake plan\n\n1. Report the background result.";
          const stamp = (frame: SDKMessage, promptIndex: number) =>
            claudeSdkFrame({
              ...frame,
              user_message_uuid: harness.promptUuid(promptIndex),
            });
          const runOf = (attemptId: RunAttemptId) => RunId.make(`run-${attemptId}`);
          const planToolUse = claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_plan",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: planToolUseId,
                  name: "ExitPlanMode",
                  input: { plan: planMarkdown },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000741",
            session_id: WAKE_NATIVE_SESSION,
          });
          const planToolResult = claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: planToolUseId,
                  content:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                  is_error: true,
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000742",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: firstAttempt,
              text: "Run the build in the background.",
              attachments: [],
              runtimePolicy,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, stamp(wakeTaskStarted, 0));
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000740", result: "STARTED" }),
              0,
            ),
          );
          yield* harness.awaitTerminal(1);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: userAttempt,
              text: "Reply with exactly: USER_REPLY",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 2,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          // The SDK asks for permission only after streaming the tool_use.
          yield* harness.offerAndWait(planToolUse);
          const canUseTool = harness.getOpenedOptions()?.canUseTool;
          assert.isFunction(canUseTool);
          const callback = yield* Effect.promise(() =>
            canUseTool!(
              "ExitPlanMode",
              { plan: planMarkdown },
              {
                signal: new AbortController().signal,
                toolUseID: planToolUseId,
                requestId: "request-wake-plan",
              },
            ),
          );
          assert.equal(callback?.behavior, "deny");
          assert.include(
            callback?.behavior === "deny" ? callback.message : "",
            "The client captured your proposed plan",
          );
          yield* Queue.offer(harness.sdkMessages, planToolResult);
          yield* Queue.offer(harness.sdkMessages, wakeResult);
          yield* harness.awaitContinuation(1);

          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeAssistantTextFrame({
                uuid: "00000000-0000-4000-8000-000000000743",
                text: "USER_REPLY",
              }),
              1,
            ),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000744",
                result: "USER_REPLY",
              }),
              1,
            ),
          );
          yield* harness.awaitTerminal(2);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: continuationAttempt,
              text: "Background task completed.",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 3,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.awaitTerminal(3);

          const latestItems = new Map(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated"
                ? [[String(event.turnItem.id), event.turnItem]]
                : [],
            ),
          );
          const planTool = [...latestItems.values()].find(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === planToolUseId,
          );
          const proposedPlans = [...latestItems.values()].filter(
            (item) => item.type === "proposed_plan",
          );
          const plans = harness.events.flatMap((event) =>
            event.type === "plan.updated" && event.plan.kind === "proposed_plan"
              ? [event.plan]
              : [],
          );
          const planToolRuns = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === planToolUseId &&
            event.turnItem.type === "dynamic_tool"
              ? [event.turnItem.runId]
              : [],
          );
          assert.isNotEmpty(planToolRuns);
          assert.isTrue(planToolRuns.every((runId) => runId === runOf(continuationAttempt)));
          assert.equal(planTool?.runId, runOf(continuationAttempt));
          assert.lengthOf(proposedPlans, 1);
          assert.equal(proposedPlans[0]?.runId, runOf(continuationAttempt));
          assert.isTrue(plans.length > 0);
          assert.isTrue(plans.every((plan) => plan.runId === runOf(continuationAttempt)));
          const userRunItems = [...latestItems.values()].filter(
            (item) => item.runId === runOf(userAttempt),
          );
          assert.deepEqual(
            userRunItems.map((item) => item.type),
            ["assistant_message"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("stores a Bash result's stdout and stderr as command output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-bash-output");
        const bashToolUseId = "toolu_01BashOutput";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Run it.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_bash_output",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: bashToolUseId,
                  name: "Bash",
                  input: { command: "git status" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000790",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: bashToolUseId, content: "On branch main" },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000791",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              stdout: "On branch main",
              stderr: "warning: dirty",
              interrupted: false,
              isImage: false,
            },
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000792", result: "Done." }),
        );
        yield* harness.awaitTerminal(1);

        const bash = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === bashToolUseId,
        );
        assert.equal(
          bash?.type === "turn_item.updated" && bash.turnItem.type === "command_execution"
            ? bash.turnItem.output
            : undefined,
          "On branch main\nwarning: dirty",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("answers an approval a held wake turn raises without waiting for the echo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const approvalPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const firstAttempt = RunAttemptId.make("attempt-claude-wake-approval-1");
        const userAttempt = RunAttemptId.make("attempt-claude-wake-approval-2");
        const bashToolUseId = "toolu_01WakeApprovalBash";
        const stamp = (frame: SDKMessage, promptIndex: number) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: harness.promptUuid(promptIndex),
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
            runtimePolicy: approvalPolicy,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000780", text: "One." }),
            0,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000781", result: "One." }),
            0,
          ),
        );
        yield* harness.awaitTerminal(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: userAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
            runtimePolicy: approvalPolicy,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_bash",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: bashToolUseId,
                  name: "Bash",
                  input: { command: "git status" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000782",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const permission = yield* Effect.promise(() =>
          harness.getOpenedOptions()!.canUseTool!(
            "Bash",
            { command: "git status" },
            {
              signal: new AbortController().signal,
              toolUseID: bashToolUseId,
              requestId: "request-wake-bash",
            },
          ),
        ).pipe(Effect.forkScoped);

        yield* harness.until(() =>
          harness.events.some((event) => event.type === "runtime_request.updated"),
        );
        const request = harness.events.findLast(
          (event) => event.type === "runtime_request.updated",
        );
        const bashItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === bashToolUseId
            ? [event.turnItem.runId]
            : [],
        );
        assert.isNotEmpty(bashItems);
        assert.isTrue(bashItems.every((runId) => runId === RunId.make(`run-${userAttempt}`)));
        if (request?.type !== "runtime_request.updated") return;
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          decision: "accept",
        });
        const result = yield* Fiber.join(permission);
        assert.equal(result?.behavior, "allow");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("releases output held for a prompt echo when the stream ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) => Queue.shutdown(sdkMessages),
        });
        const now = yield* DateTime.now;
        const firstAttempt = RunAttemptId.make("attempt-claude-echo-1");
        const secondAttempt = RunAttemptId.make("attempt-claude-echo-2");
        const stamp = (frame: SDKMessage, promptIndex: number) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: harness.promptUuid(promptIndex),
          });
        const assistantTexts = () =>
          harness.events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000701", text: "One." }),
            0,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000702", result: "One." }),
            0,
          ),
        );
        yield* harness.awaitTerminal(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: secondAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000703", text: "Two." }),
        );
        assert.deepEqual(assistantTexts(), ["One."]);

        yield* Queue.shutdown(harness.sdkMessages);
        yield* harness.awaitTerminal(2);
        assert.deepEqual(assistantTexts(), ["One.", "Two."]);
        assert.equal(harness.terminalEvents()[1]?.status, "failed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("fails a prompt Claude completes without starting a turn for it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Claude answers a prompt whose uuid its transcript already holds with
        // a lone completed lifecycle frame and never runs a turn for it.
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-duplicate-prompt"),
            text: "Bump this PR to the latest main.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state: "completed",
            uuid: "00000000-0000-4000-8000-000000000790",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.awaitTerminal(1);
        const [terminal] = harness.terminalEvents();
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.threadDisposition, "reusable");
        assert.include(terminal.failure.message, "never started a turn");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  // regression: #16897 a prompt whose uuid the session already holds must not hang or end early
  it.effect("keeps a started prompt running until its result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-started-prompt"),
            text: "Bump this PR to the latest main.",
            attachments: [],
          }),
        );
        const lifecycle = (state: string, uuid: string) =>
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("queued", "00000000-0000-4000-8000-000000000791"),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("started", "00000000-0000-4000-8000-000000000792"),
        );
        // The CLI can report the prompt completed before its turn's result.
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("completed", "00000000-0000-4000-8000-000000000793"),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000794", result: "Done." }),
            user_message_uuid: harness.promptUuid(0),
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("buffers wake output and requests a single continuation run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        yield* harness.offerAndWait(wakeNotification);
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* harness.awaitContinuation(1);
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.providerThreadId, harness.providerThread.id);
        assert.equal(harness.continuationRequests[0]?.driver, ClaudeAdapterV2.CLAUDE_PROVIDER);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* harness.offerAndWait(wakeResult);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("starts the wake run when Claude opens the wake turn, before its output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-init-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);

        yield* harness.offerAndWait(wakeNotification);
        assert.lengthOf(harness.continuationRequests, 0);
        yield* harness.offerAndWait(wakeTurnInit);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-init-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        assert.lengthOf(harness.terminalEvents(), 1);

        yield* harness.offerAndWait(wakeAssistant);
        yield* harness.offerAndWait(wakeResult);
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([true, false])(
    "carries a rejected wake rate limit into the continuation failure (event=%s)",
    (standaloneEvent) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const resetsAt = 1790298600;

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-limit-1"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* Queue.take(harness.terminalReceipts);

          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          if (standaloneEvent) {
            yield* harness.offerAndWait(
              claudeSdkFrame({
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  resetsAt,
                  overageStatus: "rejected",
                },
                uuid: "00000000-0000-4000-8000-000000000630",
                session_id: WAKE_NATIVE_SESSION,
              }),
            );
          }
          assert.lengthOf(harness.continuationRequests, 0);
          yield* harness.offerAndWait(
            makeAssistantErrorFrame({
              uuid: "00000000-0000-4000-8000-000000000631",
              error: "rate_limit",
              apiErrorParams: {
                rate_limit_info: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  // A conflicting embedded time must not replace the event for this window.
                  resetsAt: standaloneEvent ? resetsAt + 3_600 : resetsAt,
                },
              },
            }),
          );
          assert.lengthOf(harness.continuationRequests, 1);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000632",
              result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
              isError: true,
              apiErrorStatus: 429,
              terminalReason: "api_error",
              origin: { kind: "task-notification" },
            }),
          );
          assert.lengthOf(harness.continuationRequests, 1);

          // An empty session-task lifecycle result arriving before T3 opens the
          // wake run must not replace the root's terminal usage-limit result.
          yield* harness.offerAndWait(wakeTurnInit);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000633",
              result: "",
              numTurns: 0,
              origin: { kind: "task-notification" },
              terminalReason: null,
            }),
          );

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-limit-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal?.status, "failed");
          if (terminal === undefined || terminal.status !== "failed") return;
          assert.equal(terminal.failure.class, "usage_limit");
          assert.equal(terminal.failure.resetAt, "2026-09-25T01:10:00.000Z");
          if (standaloneEvent) {
            const pause = yield* Queue.take(harness.systemNoticeReceipts);
            assert.equal(pause.turnItem.type, "system_notice");
            if (pause.turnItem.type !== "system_notice") return;
            assert.include(pause.turnItem.message, "This turn is paused until the 5-hour limit");
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("leaves buffered wake messages for the continuation queued behind a user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* harness.awaitContinuation(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4b"),
            text: "How is the build going?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );

        yield* harness.until(() => harness.offeredMessages.length === 2);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000105",
            result: "The build passed; nothing else pending.",
          }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);
        assert.equal(harness.terminalEvents()[2]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 2);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type !== "provider_thread.updated" &&
              JSON.stringify(event).includes(WAKE_TASK_ID),
          ),
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("ignores a zero-turn task-notification origin result during a normal user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const probeAssistantText = "Probe after stale task-notification result.";
        const recoveryAssistantText = "Recovered after the interrupt; continuing.";
        const staleResultText = STALE_TASK_NOTIFICATION_RESULT_TEXT;
        const hasMessageText = (text: string) =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === text,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-stale-notif-1"),
            text: "Continue after interrupt.",
            attachments: [],
          }),
        );
        yield* harness.until(() => harness.offeredMessages.length === 1);

        // Live interleaving seen after interrupt recovery: a stale stopped
        // task_notification and its task-notification-origin result arrive
        // before the real root assistant stream.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "task-stale-stopped",
            tool_use_id: "toolu-stale-stopped",
            status: "stopped",
            output_file: "/tmp/task-stale-stopped.log",
            summary: "",
            uuid: "00000000-0000-4000-8000-000000000107",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, staleTaskNotificationResult);
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-00000000010a",
            text: probeAssistantText,
          }),
        );

        yield* harness.until(() => hasMessageText(probeAssistantText));
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isFalse(hasMessageText(staleResultText));

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000108",
            text: recoveryAssistantText,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000109",
            result: recoveryAssistantText,
          }),
        );

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(hasMessageText(recoveryAssistantText));
        assert.isFalse(hasMessageText(staleResultText));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "emits one interrupted terminal for a positive task-notification result racing interrupt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const closeGate = yield* Deferred.make<void>();
          const testScope = yield* Scope.Scope;
          yield* Scope.addFinalizer(testScope, Deferred.succeed(closeGate, undefined));
          const interruptStarted = yield* Deferred.make<void>();
          const harness = yield* makeWakeHarnessWithOptions({
            close: (sdkMessages) =>
              Deferred.await(closeGate).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
            stopTask: () => Effect.void,
            interrupt: Deferred.succeed(interruptStarted, undefined),
          });
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const now = yield* DateTime.now;
          const attemptId = RunAttemptId.make("attempt-claude-interrupt-positive-notif");
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId,
              text: "Stop this task.",
              attachments: [],
            }),
          );
          yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(interruptStarted);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000115",
              result: "Late result after interrupt.",
              numTurns: 7,
              origin: { kind: "task-notification" },
            }),
          );
          const terminalized = Exit.isSuccess(yield* harness.awaitTerminal(1).pipe(Effect.exit));
          yield* Deferred.succeed(closeGate, undefined);
          assert.isTrue(terminalized);
          assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
          assert.lengthOf(harness.terminalEvents(), 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("settles a continuation turn immediately when no wake output is buffered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-3"),
            text: "Background task completed.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    { label: "an empty one", quotaFailureFirst: false },
    { label: "a quota failure and an empty one", quotaFailureFirst: true },
  ])(
    "keeps the wake run open for the turn Claude opens right after $label",
    ({ quotaFailureFirst }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const subagents = [
            { taskId: "task-wake-pair-a", toolUseId: "toolu_wake_pair_a" },
            { taskId: "task-wake-pair-b", toolUseId: "toolu_wake_pair_b" },
          ];
          const wakeAttempt = RunAttemptId.make("attempt-claude-wake-pair-2");

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-pair-1"),
              text: "Audit both in the background.",
              attachments: [],
            }),
          );
          for (const [index, subagent] of subagents.entries()) {
            yield* Queue.offer(
              harness.sdkMessages,
              makeSubagentTaskStartedFrame({
                ...subagent,
                uuid: `00000000-0000-4000-8000-00000000095${index}`,
              }),
            );
          }
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000952", result: "Started." }),
          );
          yield* harness.awaitTerminal(1);

          // Both subagents end together. Claude runs an empty turn for the first
          // notification and opens the real one a millisecond later, all before
          // the wake run attaches.
          for (const [index, subagent] of subagents.entries()) {
            yield* Queue.offer(
              harness.sdkMessages,
              makeSubagentNotificationFrame({
                ...subagent,
                summary: "AUDITED",
                uuid: `00000000-0000-4000-8000-00000000096${index}`,
              }),
            );
          }
          // A rejected wake that precedes the empty turn still must not settle
          // the run the live turn owns.
          if (quotaFailureFirst) {
            yield* harness.offerAndWait(
              makeAssistantErrorFrame({
                uuid: "00000000-0000-4000-8000-000000000964",
                error: "rate_limit",
              }),
            );
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000965",
                result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
                isError: true,
                apiErrorStatus: 429,
                terminalReason: "api_error",
                origin: { kind: "task-notification" },
              }),
            );
          }
          yield* Queue.offer(harness.sdkMessages, wakeTurnInit);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000962",
              result: "",
              numTurns: 0,
              origin: { kind: "task-notification" },
              terminalReason: null,
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000963" }),
          );
          assert.lengthOf(harness.continuationRequests, 1);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: wakeAttempt,
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          // Claude is still thinking, so the run stays working rather than
          // settling with nothing to show.
          assert.lengthOf(harness.terminalEvents(), 1);

          yield* harness.offerAndWait(wakeAssistant);
          yield* harness.offerAndWait(wakeResult);
          yield* harness.awaitTerminal(2);
          assert.equal(harness.terminalEvents()[1]?.status, "completed");
          assert.lengthOf(harness.continuationRequests, 1);
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.runId === RunId.make(`run-${wakeAttempt}`) &&
                event.message.text === WAKE_RESULT_TEXT,
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  describe("native goals", () => {
    const syntheticFrame = (uuid: string, text: string) =>
      claudeSdkFrame({
        type: "assistant",
        message: {
          model: "<synthetic>",
          id: uuid,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      });
    const stopHookFeedback = (uuid: string, condition: string, reason: string) =>
      claudeSdkFrame({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: `Stop hook feedback:\n[${condition}]: ${reason}` }],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      });
    const goalStatuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "provider_thread.updated" && event.providerThread.goal != null
          ? [event.providerThread.goal]
          : [],
      );

    it.effect("tracks a /goal through unmet checks until Claude stops on its own", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "all tests pass";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-attempt"),
            text: `/goal ${condition}`,
            attachments: [],
          }),
        );
        for (const frame of [
          syntheticFrame("goal-set", `Goal set: ${condition}`),
          makeAssistantTextFrame({ uuid: "goal-work-1", text: "Fixing the first test." }),
          stopHookFeedback("goal-check-1", condition, "One test still fails."),
          makeAssistantTextFrame({ uuid: "goal-work-2", text: "All tests pass now." }),
          makeResultFrame({ uuid: "goal-result", result: "All tests pass now." }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "completed");
        assert.deepEqual(goalStatuses(harness.events), [
          { objective: condition, status: "active", checks: 0 },
          {
            objective: condition,
            status: "active",
            checks: 1,
            lastCheck: "One test still fails.",
          },
          { objective: condition, status: "complete", checks: 1 },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect(
      "defers goal completion until an ambient subagent finishes and Claude checks again",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const condition = "the review finds no bugs";
          const taskId = "task-goal-review";
          const toolUseId = "toolu-goal-review";
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("goal-background-attempt"),
              text: `/goal ${condition}`,
              attachments: [],
            }),
          );
          for (const frame of [
            syntheticFrame("goal-background-set", `Goal set: ${condition}`),
            claudeSdkFrame({
              ...makeSubagentTaskStartedFrame({ taskId, toolUseId, uuid: "goal-review-start" }),
              ambient: true,
              skip_transcript: true,
            }),
            makeAssistantTextFrame({
              uuid: "goal-background-wait",
              text: "Waiting for the review.",
            }),
            makeResultFrame({ uuid: "goal-background-result", result: "Waiting for the review." }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          assert.deepEqual(goalStatuses(harness.events).at(-1), {
            objective: condition,
            status: "active",
            checks: 0,
          });

          yield* harness.offerAndWait(
            makeSubagentNotificationFrame({
              taskId,
              toolUseId,
              summary: "No bugs found.",
              uuid: "goal-review-done",
            }),
          );
          yield* harness.offerAndWait(wakeTurnInit);
          yield* Queue.take(harness.continuationReceipts);
          assert.equal(goalStatuses(harness.events).at(-1)?.status, "active");
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("goal-background-wake"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.offerAndWait(
            makeAssistantTextFrame({ uuid: "goal-background-wake-work", text: "No bugs found." }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "goal-background-wake-result",
              result: "No bugs found.",
              origin: { kind: "task-notification" },
            }),
          );
          assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          assert.deepEqual(goalStatuses(harness.events).at(-1), {
            objective: condition,
            status: "complete",
            checks: 0,
          });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    it.effect.each([
      { taskType: "mcp_task", status: "complete" },
      { taskType: undefined, status: "active" },
    ] as const)("leaves the goal $status with a running $taskType task", ({ taskType, status }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "the docs build";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-task-type-attempt"),
            text: `/goal ${condition}`,
            attachments: [],
          }),
        );
        for (const frame of [
          syntheticFrame("goal-task-type-set", `Goal set: ${condition}`),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-goal-docs",
            description: "Watch the docs",
            ...(taskType === undefined ? {} : { task_type: taskType }),
            uuid: "goal-task-type-start",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeAssistantTextFrame({ uuid: "goal-task-type-work", text: "The docs build." }),
          makeResultFrame({ uuid: "goal-task-type-result", result: "The docs build." }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
        assert.equal(goalStatuses(harness.events).at(-1)?.status, status);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("keeps a goal active after a command turn with no model output", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "the build is green";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: {
              ...harness.providerThread,
              goal: { objective: condition, status: "active", checks: 2 },
            },
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-show-attempt"),
            text: "/goal",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          syntheticFrame("goal-show", `Goal active: ${condition} (2 turns)`),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "goal-show-result", result: "", numTurns: 0 }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.deepEqual(goalStatuses(harness.events).at(-1), {
          objective: condition,
          status: "active",
          checks: 2,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );
  });
});
