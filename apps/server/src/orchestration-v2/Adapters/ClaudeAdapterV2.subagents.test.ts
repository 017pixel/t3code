import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  yieldTicks,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  makeSubagentAssistantFrames,
  makeSubagentToolResultFrame,
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

describe("ClaudeAdapterV2 subagents", () => {
  const subagentRouting = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    nativeToolIds: ReadonlyArray<string>,
  ) => {
    const childThreadId =
      events.find((event) => event.type === "subagent.updated")?.subagent.childThreadId ??
      undefined;
    const toolThreadIds = new Map<string, Set<string>>();
    for (const event of events) {
      const nativeId =
        event.type === "turn_item.updated" ? event.turnItem.nativeItemRef?.nativeId : undefined;
      if (event.type === "turn_item.updated" && nativeId && nativeToolIds.includes(nativeId)) {
        toolThreadIds.set(
          nativeId,
          (toolThreadIds.get(nativeId) ?? new Set()).add(event.turnItem.threadId),
        );
      }
    }
    const assistantTexts = (threadId: string | undefined) =>
      events.flatMap((event) =>
        event.type === "message.updated" &&
        event.message.role === "assistant" &&
        event.message.threadId === threadId
          ? [event.message.text]
          : [],
      );
    return { childThreadId, toolThreadIds, assistantTexts };
  };

  it.effect("streams a background subagent's work while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-live-idle";
        const TOOL_USE_ID = "toolu-live-idle";
        const STRADDLING_BASH = "toolu-live-straddling-bash";
        const IDLE_BASH = "toolu-live-idle-bash";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const latestToolItem = (nativeId: string) =>
          harness.events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === nativeId,
          );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-live-idle-1"),
            text: "Audit in the background.",
            attachments: [],
          }),
        );
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000951",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000952",
            bashToolUseId: STRADDLING_BASH,
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000953",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        for (const frame of [
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000954",
            toolUseId: STRADDLING_BASH,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000955",
            text: "Still auditing.",
            bashToolUseId: IDLE_BASH,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            description: "Reading the last commits",
            uuid: "00000000-0000-4000-8000-000000000956",
            session_id: WAKE_NATIVE_SESSION,
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() => {
          const event = latestToolItem(IDLE_BASH);
          return event?.type === "turn_item.updated" && event.turnItem.status === "running";
        });
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.progress === "Reading the last commits",
          ),
        );
        const routing = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), ["Still auditing."]);
        const straddling = latestToolItem(STRADDLING_BASH);
        const straddlingItem =
          straddling?.type === "turn_item.updated" ? straddling.turnItem : undefined;
        assert.equal(straddlingItem?.status, "completed");
        assert.equal(
          straddlingItem?.type === "command_execution" ? straddlingItem.input : undefined,
          "git log -5",
        );
        assert.equal(harness.continuationRequests.length, 0);

        for (const frame of [
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000957",
            toolUseId: IDLE_BASH,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: "Still auditing.",
            uuid: "00000000-0000-4000-8000-000000000958",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitContinuation(1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000959",
            result: "The auditor finished.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-live-idle-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        const finalRouting = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
        assert.deepEqual(finalRouting.assistantTexts(finalRouting.childThreadId), [
          "Still auditing.",
        ]);
        for (const nativeId of [STRADDLING_BASH, IDLE_BASH]) {
          assert.deepEqual(
            [...(finalRouting.toolThreadIds.get(nativeId) ?? [])],
            [finalRouting.childThreadId],
          );
          const statuses = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId
              ? [`${event.turnItem.type}:${event.turnItem.status}`]
              : [],
          );
          assert.deepEqual(statuses, ["command_execution:running", "command_execution:completed"]);
        }
        const finalSubagent = harness.events.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          finalSubagent?.type === "subagent.updated" && finalSubagent.subagent.status,
          "completed",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("keeps a nested subagent's launch in order while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-idle-outer";
        const OUTER_TOOL_USE_ID = "toolu-idle-outer";
        const NESTED_TASK_ID = "task-idle-nested";
        const NESTED_TOOL_USE_ID = "toolu-idle-nested";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-nested-1"),
            text: "Audit in the background.",
            attachments: [],
          }),
        );
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000971",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000972",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_idle_nested_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: NESTED_TOOL_USE_ID,
                  name: "Agent",
                  input: { description: "Nested check", prompt: "Reply with NESTED_OK" },
                },
              ],
            },
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000973",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: NESTED_TASK_ID,
            tool_use_id: NESTED_TOOL_USE_ID,
            description: "Nested check",
            subagent_type: "general-purpose",
            is_backgrounded: false,
            spawn_depth: 2,
            task_type: "local_agent",
            prompt: "Reply with NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000974",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: OUTER_TASK_ID,
            description: "Waiting on the nested check",
            uuid: "00000000-0000-4000-8000-000000000984",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000988",
            messageId: "msg_idle_outer_working",
            text: "OUTER_WORKING",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === "OUTER_WORKING",
          ),
        );
        assert.lengthOf(harness.continuationRequests, 0);
        for (const frame of [
          ...makeSubagentAssistantFrames({
            parentToolUseId: NESTED_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000975",
            text: "NESTED_OK",
          }),
          makeSubagentNotificationFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000976",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000977",
            toolUseId: NESTED_TOOL_USE_ID,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000978",
            text: "OUTER_DONE",
          }),
          makeSubagentNotificationFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            summary: "OUTER_DONE",
            uuid: "00000000-0000-4000-8000-000000000979",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitContinuation(1);
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.progress === "Waiting on the nested check",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000980",
            result: "The audit finished.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-nested-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === NESTED_TOOL_USE_ID,
          ),
        );
        const finalSubagents = new Map(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent] as const]
              : [],
          ),
        );
        const outer = finalSubagents.get(OUTER_TASK_ID);
        const nested = finalSubagents.get(NESTED_TASK_ID);
        assert.equal(outer?.status, "completed");
        assert.equal(nested?.status, "completed");
        assert.equal(nested?.parentNodeId, outer?.id);
        assert.deepEqual(
          subagentRouting(harness.events, []).assistantTexts(outer?.childThreadId ?? undefined),
          ["OUTER_WORKING", "OUTER_DONE"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("ends an earlier turn's nested subagent while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-earlier-outer";
        const OUTER_TOOL_USE_ID = "toolu-earlier-outer";
        const NESTED_TASK_ID = "task-earlier-nested";
        const NESTED_TOOL_USE_ID = "toolu-earlier-nested";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const userTurn = (attemptId: string, providerTurnOrdinal: number) =>
          harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(attemptId),
              text: "Keep auditing.",
              attachments: [],
              providerTurnOrdinal,
            }),
          );
        yield* userTurn("attempt-claude-earlier-nested-1", 1);
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a01",
          }),
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_earlier_nested_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: NESTED_TOOL_USE_ID,
                  name: "Agent",
                  input: { description: "Nested check", prompt: "Reply with NESTED_OK" },
                },
              ],
            },
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a02",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: NESTED_TASK_ID,
            tool_use_id: NESTED_TOOL_USE_ID,
            description: "Nested check",
            subagent_type: "general-purpose",
            is_backgrounded: false,
            spawn_depth: 2,
            task_type: "local_agent",
            prompt: "Reply with NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000a03",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000a04",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);
        yield* userTurn("attempt-claude-earlier-nested-2", 2);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000a05", result: "Still on it." }),
        );
        yield* harness.awaitTerminal(2);

        for (const frame of [
          makeSubagentNotificationFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000a06",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a07",
            toolUseId: NESTED_TOOL_USE_ID,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a08",
            text: "OUTER_AFTER_NESTED",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "OUTER_AFTER_NESTED",
          ),
        );

        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === NESTED_TOOL_USE_ID,
          ),
        );
        const nested = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === NESTED_TASK_ID,
        );
        assert.equal(nested?.type === "subagent.updated" && nested.subagent.status, "completed");
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(["exit", "Stop"] as const)(
    "settles a plain background subagent and its open call on %s after the root turn completes",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const TOOL_USE_ID = "toolu-idle-exit";
          const BASH = "toolu-idle-exit-bash";
          const harness = yield* makeWakeHarnessWithOptions({ close: Queue.shutdown });
          const now = yield* DateTime.now;
          const bashStatuses = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`${event.turnItem.type}:${event.turnItem.status}`]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-idle-exit"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            makeSubagentTaskStartedFrame({
              taskId: "task-idle-exit",
              toolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000981",
            }),
          );
          const started = yield* Queue.take(harness.subagentReceipts);
          assert.equal(started.subagent.status, "running");
          for (const frame of makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000982",
            bashToolUseId: BASH,
          })) {
            yield* harness.offerAndWait(frame);
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000983",
              result: "Auditing in the background.",
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.deepEqual(bashStatuses(), ["command_execution:running"]);

          if (reason === "Stop") {
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId: terminal.providerTurnId,
              requestRuntimeRestart: true,
            });
          } else {
            yield* Queue.shutdown(harness.sdkMessages);
          }
          let ended = yield* Queue.take(harness.subagentReceipts);
          while (ended.subagent.status === "running") {
            ended = yield* Queue.take(harness.subagentReceipts);
          }
          assert.equal(ended.subagent.nativeTaskRef?.nativeId, "task-idle-exit");
          assert.equal(ended.subagent.status, reason === "Stop" ? "cancelled" : "failed");
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.deepEqual(bashStatuses(), [
            "command_execution:running",
            reason === "Stop" ? "command_execution:interrupted" : "command_execution:failed",
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(["before", "after"] as const)(
    "keeps a subagent call's result when the CLI exits before the drain (result %s the nested launch's)",
    (bashResultOrder) =>
      Effect.scoped(
        Effect.gen(function* () {
          const OUTER_TASK_ID = "task-exit-buffered-outer";
          const OUTER_TOOL_USE_ID = "toolu-exit-buffered-outer";
          const NESTED_TASK_ID = "task-exit-buffered-nested";
          const NESTED_TOOL_USE_ID = "toolu-exit-buffered-nested";
          const BASH = "toolu-exit-buffered-bash";
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const now = yield* DateTime.now;
          const bashItems = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [
                    `${event.turnItem.type}:${event.turnItem.status}:${JSON.stringify("input" in event.turnItem ? event.turnItem.input : null)}`,
                  ]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-buffered-1"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            makeSubagentTaskStartedFrame({
              taskId: OUTER_TASK_ID,
              toolUseId: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001001",
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001002",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          for (const frame of makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000001003",
            bashToolUseId: BASH,
          })) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.until(() => bashItems().length === 1);

          const bashResultFrame = makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000001006",
            toolUseId: BASH,
          });
          for (const frame of [
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "msg_exit_buffered_nested_launch",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: NESTED_TOOL_USE_ID,
                    name: "Agent",
                    input: { description: "Nested check", prompt: "Reply with NESTED_OK" },
                  },
                ],
              },
              parent_tool_use_id: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001004",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: NESTED_TASK_ID,
              tool_use_id: NESTED_TOOL_USE_ID,
              description: "Nested check",
              subagent_type: "general-purpose",
              is_backgrounded: false,
              spawn_depth: 2,
              task_type: "local_agent",
              prompt: "Reply with NESTED_OK",
              uuid: "00000000-0000-4000-8000-000000001005",
              session_id: WAKE_NATIVE_SESSION,
            }),
            ...(bashResultOrder === "before" ? [bashResultFrame] : []),
            ...makeSubagentAssistantFrames({
              parentToolUseId: NESTED_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001007",
              text: "NESTED_OK",
            }),
            makeSubagentNotificationFrame({
              taskId: NESTED_TASK_ID,
              toolUseId: NESTED_TOOL_USE_ID,
              summary: "NESTED_OK",
              uuid: "00000000-0000-4000-8000-000000001008",
            }),
            makeSubagentToolResultFrame({
              parentToolUseId: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001009",
              toolUseId: NESTED_TOOL_USE_ID,
            }),
            ...(bashResultOrder === "after" ? [bashResultFrame] : []),
            makeSubagentNotificationFrame({
              taskId: OUTER_TASK_ID,
              toolUseId: OUTER_TOOL_USE_ID,
              summary: "OUTER_DONE",
              uuid: "00000000-0000-4000-8000-000000001010",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);

          yield* Queue.shutdown(harness.sdkMessages);
          yield* yieldTicks(50);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-buffered-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          assert.equal(harness.processQueues.length, 2);
          yield* Queue.offer(
            harness.processQueues[1]!,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001011",
              result: "The audit finished.",
            }),
          );
          yield* harness.awaitTerminal(2);

          const input = JSON.stringify("git log -5");
          assert.deepEqual(bashItems(), [
            `command_execution:running:${input}`,
            `command_execution:completed:${input}`,
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect(
    "ends a subagent's SendMessage with its result when the CLI exits while the resume waits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const SENDER_TASK_ID = "task-exit-resume-sender";
          const SENDER_TOOL_USE_ID = "toolu-exit-resume-sender";
          const RESUMED_TASK_ID = "task-exit-resume-target";
          const RESUMED_TOOL_USE_ID = "toolu-exit-resume-target";
          const SEND = "toolu-exit-resume-sendmessage";
          const SEND_INPUT = { to: RESUMED_TASK_ID, message: "Check the last commit again." };
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const now = yield* DateTime.now;
          const sendItems = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === SEND
                ? [
                    `${event.turnItem.type}:${event.turnItem.status}:${JSON.stringify("input" in event.turnItem ? event.turnItem.input : null)}`,
                  ]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-resume-1"),
              text: "Run two auditors in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            makeSubagentTaskStartedFrame({
              taskId: SENDER_TASK_ID,
              toolUseId: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001101",
            }),
            makeSubagentTaskStartedFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: RESUMED_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001102",
            }),
            makeSubagentNotificationFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: RESUMED_TOOL_USE_ID,
              summary: "First answer.",
              uuid: "00000000-0000-4000-8000-000000001103",
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001104",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "msg_exit_resume_sendmessage",
                type: "message",
                role: "assistant",
                content: [{ type: "tool_use", id: SEND, name: "SendMessage", input: SEND_INPUT }],
              },
              parent_tool_use_id: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001105",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* harness.until(() => sendItems().length >= 1);

          for (const frame of [
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: RESUMED_TASK_ID,
              tool_use_id: SEND,
              description: "Audit recent commits",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: SEND_INPUT.message,
              uuid: "00000000-0000-4000-8000-000000001106",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: SEND, content: "Message sent." }],
              },
              parent_tool_use_id: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001107",
              session_id: WAKE_NATIVE_SESSION,
            }),
            makeSubagentNotificationFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: SEND,
              summary: "Second answer.",
              uuid: "00000000-0000-4000-8000-000000001108",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);
          const beforeExit = sendItems();

          yield* Queue.shutdown(harness.sdkMessages);
          yield* yieldTicks(50);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-resume-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          assert.equal(harness.processQueues.length, 2);
          yield* Queue.offer(
            harness.processQueues[1]!,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001109",
              result: "The audit finished.",
            }),
          );
          yield* harness.awaitTerminal(2);

          const input = JSON.stringify(SEND_INPUT);
          assert.deepEqual(beforeExit, [`dynamic_tool:running:${input}`]);
          assert.deepEqual(sendItems(), [
            `dynamic_tool:running:${input}`,
            `dynamic_tool:completed:${input}`,
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each([
    ["", "none"],
    [" behind another subagent's start without one", "before"],
    [" when another subagent's start without one arrives between its frames", "between"],
  ] as const)(
    "keeps a subagent's frames in order when a late progress names its tool use while the root is idle%s",
    ([, otherStart]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const TASK_ID = "task-late-owner-idle";
          const TOOL_USE_ID = "toolu-late-owner-idle";
          const BASH = "toolu-late-owner-idle-bash";
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const bashStatuses = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`${event.turnItem.type}:${event.turnItem.status}`]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-late-owner-idle-1"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: TASK_ID,
              description: "Audit recent commits",
              subagent_type: "general-purpose",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: "Audit the last five commits.",
              uuid: "00000000-0000-4000-8000-000000000a01",
              session_id: WAKE_NATIVE_SESSION,
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000a02",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          const otherStartFrame = claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-late-owner-other",
            description: "Check the changelog",
            subagent_type: "general-purpose",
            is_backgrounded: true,
            task_type: "local_agent",
            prompt: "Check the changelog.",
            uuid: "00000000-0000-4000-8000-000000000a09",
            session_id: WAKE_NATIVE_SESSION,
          });
          const progressFrame = claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            tool_use_id: TOOL_USE_ID,
            description: "Reading the last commits",
            usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
            uuid: "00000000-0000-4000-8000-000000000a04",
            session_id: WAKE_NATIVE_SESSION,
          });
          const bashResultFrame = makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a05",
            toolUseId: BASH,
          });
          for (const frame of [
            ...(otherStart === "before" ? [otherStartFrame] : []),
            ...makeSubagentAssistantFrames({
              parentToolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000a03",
              text: "First.",
              bashToolUseId: BASH,
            }),
            ...(otherStart === "between"
              ? [otherStartFrame, bashResultFrame, progressFrame]
              : [progressFrame, bashResultFrame]),
            ...makeSubagentAssistantFrames({
              parentToolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000a06",
              text: "Second.",
            }),
            makeSubagentNotificationFrame({
              taskId: TASK_ID,
              toolUseId: TOOL_USE_ID,
              summary: "Second.",
              uuid: "00000000-0000-4000-8000-000000000a07",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000a08",
              result: "The auditor finished.",
            }),
          );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-late-owner-idle-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.awaitTerminal(2);

          const routing = subagentRouting(harness.events, [BASH]);
          const childTexts = routing.assistantTexts(routing.childThreadId);
          const statuses = bashStatuses();
          const trace = harness.events.flatMap((event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.threadId === routing.childThreadId
              ? [`text:${event.message.text}#${event.message.id}`]
              : event.type === "turn_item.updated" &&
                  event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`bash:${event.turnItem.status}`]
                : [],
          );
          assert.deepEqual(childTexts, ["First.", "Second."], `trace: ${JSON.stringify(trace)}`);
          assert.deepEqual(
            [...(routing.toolThreadIds.get(BASH) ?? [])],
            [routing.childThreadId],
            `trace: ${JSON.stringify(trace)}`,
          );
          assert.deepEqual(
            statuses,
            ["command_execution:running", "command_execution:completed"],
            `trace: ${JSON.stringify(trace)}`,
          );
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.progress === "Reading the last commits",
            ),
          );
          assert.lengthOf(harness.continuationRequests, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("holds subagent frames that precede task_started and shows its result once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-early-subagent";
        const TOOL_USE_ID = "toolu-early-subagent";
        const FINAL_REPORT = "Early auditor done.";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-early-subagent"),
            text: "Run an auditor.",
            attachments: [],
          }),
        );
        const frames = [
          // The SDK can forward child frames before the task_started that
          // registers their subagent.
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000321",
            text: "Starting early.",
            bashToolUseId: "toolu-early-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000322",
            toolUseId: "toolu-early-bash",
          }),
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000323",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000324",
            text: "Still working.",
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            description: "Checking the diffs",
            uuid: "00000000-0000-4000-8000-000000000325",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000326",
            text: FINAL_REPORT,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: FINAL_REPORT,
            uuid: "00000000-0000-4000-8000-000000000327",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000328",
            result: "The auditor finished.",
          }),
        ];
        for (const frame of frames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        const routing = subagentRouting(harness.events, ["toolu-early-bash"]);
        assert.isDefined(routing.childThreadId);
        assert.deepEqual(
          [...(routing.toolThreadIds.get("toolu-early-bash") ?? [])],
          [routing.childThreadId],
        );
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), [
          "Starting early.",
          "Still working.",
          FINAL_REPORT,
        ]);
        assert.deepEqual(routing.assistantTexts(harness.threadId), ["The auditor finished."]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([false, true])(
    "drops an idle start superseded by live completion, later resume %s",
    (resume) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const startTurn = (ordinal: number, continuation = false) =>
            harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: DateTime.makeUnsafe(0),
                attemptId: RunAttemptId.make(`attempt-stale-start-${ordinal}`),
                providerTurnOrdinal: ordinal,
                text: "Continue work.",
                attachments: [],
                ...(continuation
                  ? {
                      messageCreatedBy: "agent" as const,
                      messageCreationSource: "provider" as const,
                    }
                  : {}),
              }),
            );
          const started = (taskId: string, suffix: string) =>
            makeSubagentTaskStartedFrame({
              taskId,
              toolUseId: `toolu-${taskId}`,
              uuid: `00000000-0000-4000-8000-${suffix}`,
            });
          const finished = (taskId: string, suffix: string) =>
            makeSubagentNotificationFrame({
              taskId,
              toolUseId: `toolu-${taskId}`,
              summary: "Finished audit.",
              uuid: `00000000-0000-4000-8000-${suffix}`,
            });
          yield* startTurn(1);
          yield* harness.offerAndWait(started("stale-agent", "000000004001"));
          yield* harness.offerAndWait(started("wake-agent", "000000004002"));
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004003",
              result: "Agents launched.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(started("stale-agent", "000000004004"));
          yield* startTurn(2);
          yield* harness.offerAndWait(finished("stale-agent", "000000004005"));
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004006",
              result: "User turn finished.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          if (resume) yield* harness.offerAndWait(started("stale-agent", "000000004007"));
          yield* harness.offerAndWait(finished("wake-agent", "000000004008"));
          yield* Queue.take(harness.continuationReceipts);
          yield* startTurn(3, true);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004009",
              result: "Wake finished.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const latest = harness.events.findLast(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === "stale-agent",
          );
          assert.equal(latest?.type, "subagent.updated");
          if (latest?.type !== "subagent.updated") return;
          assert.equal(latest.subagent.status, resume ? "running" : "completed");
          assert.equal(latest.subagent.result, resume ? null : "Finished audit.");
          assert.equal(latest.subagent.completedAt === null, resume);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );
});
