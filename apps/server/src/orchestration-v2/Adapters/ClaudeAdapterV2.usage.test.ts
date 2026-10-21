import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeResultFrame,
  turnOneResult,
  wakeTurnInit,
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

describe("ClaudeAdapterV2 usage, context, and compaction", () => {
  it.effect("keeps the measured context when a usage limit ends the turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-limit-context"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000660", text: "Working." }),
      );
      // The CLI answers a 429 with a locally generated frame that reports no usage.
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          message: {
            model: "<synthetic>",
            id: "00000000-0000-4000-8000-000000000661",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "You've hit your session limit" }],
            stop_reason: "stop_sequence",
            stop_sequence: "",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          error: "rate_limit",
          uuid: "00000000-0000-4000-8000-000000000661",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000662",
          result: "You've hit your session limit",
          terminalReason: "api_error",
          isError: true,
          apiErrorStatus: 429,
        }),
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      const reportedContext = harness.events.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
          ? [event.providerTurn.tokenUsage.usedTokens]
          : [],
      );
      assert.deepEqual(reportedContext, [2]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  const usageStreamFrame = (event: unknown, parentToolUseId: string | null = null) =>
    claudeSdkFrame({
      type: "stream_event",
      event,
      parent_tool_use_id: parentToolUseId,
      session_id: WAKE_NATIVE_SESSION,
      uuid: "usage-stream-frame",
    });
  const usageSnapshotFrame = (id: string, uuid: string, usage: unknown) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Working." }],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
      parent_tool_use_id: null,
      uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const zeroUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const reportedContextTokens = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.flatMap((event) =>
      event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
        ? [event.providerTurn.tokenUsage.usedTokens]
        : [],
    );

  it.effect("reports context from final stream usage when the request starts at zero", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-zero-start-usage"),
          text: "Continue.",
          attachments: [],
        }),
      );
      // Some Anthropic-compatible proxies report zero usage at message_start
      // and the real counts on the final message_delta.
      const frames = [
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_first", usage: zeroUsage },
        }),
        usageSnapshotFrame("msg_first", "00000000-0000-4000-8000-000000000670", zeroUsage),
        usageStreamFrame(
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { ...zeroUsage, input_tokens: 999_999, output_tokens: 9 },
          },
          "child-tool",
        ),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { ...zeroUsage, input_tokens: 37_939, output_tokens: 184 },
        }),
        usageSnapshotFrame("msg_first", "00000000-0000-4000-8000-000000000671", zeroUsage),
        // The next request starts at zero again and its delta reports only output.
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_second", usage: zeroUsage },
        }),
        usageSnapshotFrame("msg_second", "00000000-0000-4000-8000-000000000672", zeroUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 12 },
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000673", result: "Done." }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "completed");
      assert.deepEqual(reportedContextTokens(harness.events), [38_123]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("merges cumulative stream usage into the message_start counts", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        settings: { ...DEFAULT_CLAUDE_SETTINGS, autoCompactWindow: "150000" },
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-merged-stream-usage"),
          text: "Continue.",
          attachments: [],
        }),
      );
      const startUsage = {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1_000,
      };
      const frames = [
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_native", usage: startUsage },
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000680", startUsage),
        // Output-only deltas keep the input and cache counts from message_start.
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 20 },
        }),
        // A delta that restates input (server tools) replaces it, explicit zeros included.
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: 25,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1_000,
          },
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000681", startUsage),
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 1_075, post_tokens: 400 },
          uuid: "00000000-0000-4000-8000-000000000682",
          session_id: WAKE_NATIVE_SESSION,
        }),
        // Usage for the message before the boundary no longer describes the context.
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000684", startUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 60 },
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000683", result: "Done." }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "completed");
      assert.deepEqual(reportedContextTokens(harness.events), [1_211, 1_230, 1_075, 400]);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
            ? [event.providerTurn.tokenUsage.autoCompactThreshold]
            : [],
        ),
        [150_000, 150_000, 150_000, 150_000],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { autoCompactWindow: "", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "150000", model: "claude-sonnet-4-6", threshold: 150_000 },
    { autoCompactWindow: "200000", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "650000", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "650000", model: "uncatalogued-model", threshold: 650_000 },
  ])(
    "ignores stale snapshots after compaction and reports threshold $autoCompactWindow for $model",
    ({ autoCompactWindow, model, threshold }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          settings: { ...DEFAULT_CLAUDE_SETTINGS, autoCompactWindow },
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-snapshot-usage-compaction"),
            text: "Continue.",
            attachments: [],
            modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model },
          }),
        );
        const usage = { ...zeroUsage, input_tokens: 1_000, output_tokens: 75 };
        const frames = [
          usageSnapshotFrame("msg_fallback", "00000000-0000-4000-8000-000000000790", usage),
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 1_075, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000791",
            session_id: WAKE_NATIVE_SESSION,
          }),
          usageSnapshotFrame("msg_fallback", "00000000-0000-4000-8000-000000000792", usage),
          // A new request after the boundary reports the compacted context.
          usageSnapshotFrame("msg_after", "00000000-0000-4000-8000-000000000793", {
            ...zeroUsage,
            input_tokens: 450,
            output_tokens: 10,
          }),
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000794", result: "Done." }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "completed");
        assert.deepEqual(reportedContextTokens(harness.events), [1_075, 400, 460]);
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
              ? [event.providerTurn.tokenUsage.autoCompactThreshold]
              : [],
          ),
          [threshold, threshold, threshold],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("shows a hook-dropped Claude prompt once and skips info-level lines", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-hook-dropped-prompt-attempt"),
          text: "Deploy to production",
          attachments: [],
        }),
      );
      const notice = "Prompt dropped by a hook: Deploys are frozen until Monday.";
      const uuid = "00000000-0000-4000-8000-000000000305";
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: "Started in the background: agent-1",
          level: "info",
          session_id: WAKE_NATIVE_SESSION,
          uuid: "00000000-0000-4000-8000-000000000307",
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: notice,
          level: "warning",
          prevent_continuation: true,
          session_id: WAKE_NATIVE_SESSION,
          uuid,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000306",
          result: notice,
          numTurns: 0,
          terminalReason: null,
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const notices = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(notices, 1);
      assert.equal(notices[0]?.message, notice);
      assert.equal(notices[0]?.status, "completed");
      assert.equal(notices[0]?.nativeItemRef?.nativeId, uuid);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.isFalse(
        harness.events.some(
          (event) => event.type === "message.updated" && event.message.role === "assistant",
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect(
    "runs native compaction and keeps its context watermark separate from billed usage",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const compact = harness.runtime.compactThread;
        assert.isDefined(compact);
        if (compact === undefined) return;
        yield* compact(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("claude-native-compact-attempt"),
            text: " /COMPACT ",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual", pre_tokens: 1500, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            result: "Compacted conversation.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        assert.deepEqual(harness.offeredMessages[0]?.message.content, "/compact");
        const compaction = harness.events.find(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        );
        assert.isDefined(compaction);
        if (compaction?.type === "turn_item.updated" && compaction.turnItem.type === "compaction") {
          assert.equal(compaction.turnItem.beforeTokenCount, 1500);
          assert.equal(compaction.turnItem.afterTokenCount, 400);
          assert.equal(compaction.turnItem.status, "completed");
        }
        const watermark = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.tokenUsage?.usedTokens === 400,
        );
        assert.isDefined(watermark);
        const completed = harness.events.findLast(
          (event) => event.type === "provider_turn.updated",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect("shows automatic compaction before its boundary and completes the same item", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const observeCompactions = Effect.fnUntraced(function* (uuid: string) {
        // A later notice receipt confirms the event subscriber consumed preceding updates.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "informational",
            content: "Context checkpoint",
            level: "warning",
            session_id: WAKE_NATIVE_SESSION,
            uuid,
          }),
        );
        yield* Queue.take(harness.systemNoticeReceipts);
        return harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("claude-auto-compact-attempt"),
          text: "Continue working.",
          attachments: [],
        }),
      );
      for (const index of [1, 2]) {
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: `00000000-0000-4000-8000-00000000021${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      }
      const beforeBoundary = yield* observeCompactions("00000000-0000-4000-8000-000000000215");
      assert.lengthOf(beforeBoundary, 1);
      const running = beforeBoundary[0]!;
      assert.equal(running.status, "running");
      assert.isNull(running.completedAt);
      assert.isNotNull(running.startedAt);

      yield* TestClock.adjust(1_000);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "success",
          uuid: "00000000-0000-4000-8000-000000000222",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const reported = yield* observeCompactions("00000000-0000-4000-8000-000000000223");
      assert.lengthOf(reported, 2);
      assert.equal(reported[1]?.id, running.id);
      assert.equal(reported[1]?.status, "completed");
      assert.isUndefined(reported[1]?.afterTokenCount);
      assert.isEmpty(harness.terminalEvents());
      yield* TestClock.adjust(1_000);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 1500, post_tokens: 400 },
          uuid: "00000000-0000-4000-8000-000000000213",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const afterBoundary = yield* observeCompactions("00000000-0000-4000-8000-000000000216");
      assert.lengthOf(afterBoundary, 3);
      const completed = afterBoundary[2]!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.id, running.id);
      assert.equal(completed.ordinal, running.ordinal);
      assert.deepEqual(completed.startedAt, running.startedAt);
      assert.equal(completed.beforeTokenCount, 1500);
      assert.equal(completed.afterTokenCount, 400);
      assert.deepEqual(completed.completedAt, reported[1]?.completedAt);

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 2000, post_tokens: 500 },
          uuid: "00000000-0000-4000-8000-000000000217",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000218",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const nextCompactions = yield* observeCompactions("00000000-0000-4000-8000-000000000219");
      assert.lengthOf(nextCompactions, 5);
      const boundaryOnly = nextCompactions[3]!;
      const nextRunning = nextCompactions[4]!;
      assert.equal(boundaryOnly.status, "completed");
      assert.notEqual(boundaryOnly.id, completed.id);
      assert.isAbove(boundaryOnly.ordinal, completed.ordinal);
      assert.equal(boundaryOnly.beforeTokenCount, 2000);
      assert.equal(boundaryOnly.afterTokenCount, 500);
      assert.equal(nextRunning.status, "running");
      assert.notEqual(nextRunning.id, boundaryOnly.id);
      assert.isAbove(nextRunning.ordinal, boundaryOnly.ordinal);

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
          uuid: "00000000-0000-4000-8000-000000000233",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      assert.deepEqual(
        yield* observeCompactions("00000000-0000-4000-8000-000000000234"),
        nextCompactions,
      );

      let retryRunning = nextRunning;
      for (const [index, outcome] of [
        { compact_result: "failed", compact_error: "Temporary compaction failure." },
        {},
      ].entries()) {
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            ...outcome,
            uuid: `00000000-0000-4000-8000-00000000024${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const stopped = yield* observeCompactions(`00000000-0000-4000-8000-00000000025${index}`);
        assert.lengthOf(stopped, 6 + index * 2);
        const settled = stopped.at(-1)!;
        assert.equal(settled.id, retryRunning.id);
        assert.equal(settled.ordinal, retryRunning.ordinal);
        assert.deepEqual(settled.startedAt, retryRunning.startedAt);
        assert.equal(
          settled.status,
          outcome.compact_result === "failed" ? "failed" : "interrupted",
        );
        assert.equal(
          settled.title,
          outcome.compact_result === "failed"
            ? "Context compaction failed"
            : "Context compaction stopped",
        );
        assert.isNotNull(settled.completedAt);
        assert.isEmpty(harness.terminalEvents());

        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: `00000000-0000-4000-8000-00000000026${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retried = yield* observeCompactions(`00000000-0000-4000-8000-00000000027${index}`);
        assert.lengthOf(retried, stopped.length + 1);
        retryRunning = retried.at(-1)!;
        assert.equal(retryRunning.status, "running");
        assert.notEqual(retryRunning.id, settled.id);
        assert.isAbove(retryRunning.ordinal, settled.ordinal);
      }

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 3000, post_tokens: 600 },
          uuid: "00000000-0000-4000-8000-000000000220",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const allCompactions = yield* observeCompactions("00000000-0000-4000-8000-000000000221");
      assert.lengthOf(allCompactions, 10);
      assert.equal(allCompactions[9]?.id, retryRunning.id);
      assert.equal(allCompactions[9]?.ordinal, retryRunning.ordinal);
      assert.equal(allCompactions[9]?.status, "completed");
      assert.equal(allCompactions[9]?.beforeTokenCount, 3000);
      assert.equal(allCompactions[9]?.afterTokenCount, 600);

      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000214",
          result: "Work complete.",
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        ),
        allCompactions,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { outcome: "result", turnStatus: "completed", itemStatus: "failed" },
    { outcome: "interrupt", turnStatus: "interrupted", itemStatus: "interrupted" },
    { outcome: "query_exit", turnStatus: "failed", itemStatus: "failed" },
  ] as const)(
    "settles unfinished compaction before the $outcome terminal receipt",
    ({ outcome, turnStatus, itemStatus }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) => Queue.shutdown(sdkMessages),
        });
        const attemptId = RunAttemptId.make(`claude-compact-${outcome}`);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId,
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: "00000000-0000-4000-8000-000000000221",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        if (outcome === "query_exit") {
          yield* Queue.shutdown(harness.sdkMessages);
        } else if (outcome === "interrupt") {
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            }),
          });
        } else {
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000222",
              result: "Stopped before the boundary.",
            }),
          );
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, turnStatus);
        const updates = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(updates, 2);
        const [running, settled] = updates;
        assert.equal(running?.status, "running");
        assert.equal(settled?.status, itemStatus);
        assert.equal(settled?.id, running?.id);
        assert.equal(settled?.ordinal, running?.ordinal);
        assert.deepEqual(settled?.startedAt, running?.startedAt);
        assert.isNotNull(settled?.completedAt);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect.each(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"])(
    "renegotiates auto only when switching API models after fallback to default: %s",
    (nextModel) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
        const modelSelection = {
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          model: "claude-haiku-4-5-20251001",
        };
        const turnInput = {
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attachments: [],
          modelSelection,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...CLAUDE_TEST_RUNTIME_POLICY,
            runtimeMode: "auto",
          }),
        };
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            ...turnInput,
            attemptId: RunAttemptId.make("attempt-claude-auto-fallback-1"),
            text: "Hello.",
          }),
        );
        const openedOptions = harness.getOpenedOptions();
        assert.equal(openedOptions?.permissionMode, "auto");
        yield* harness.offerAndWait(claudeSdkFrame({ ...wakeTurnInit, permissionMode: "default" }));
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            ...turnInput,
            modelSelection: { ...modelSelection, model: nextModel },
            attemptId: RunAttemptId.make("attempt-claude-auto-fallback-2"),
            providerTurnOrdinal: 2,
            text: "Continue.",
          }),
        );
        if (nextModel === modelSelection.model) {
          assert.strictEqual(harness.getOpenedOptions(), openedOptions);
          assert.lengthOf(harness.processQueues, 1);
        } else {
          const resumedOptions = harness.getOpenedOptions();
          assert.notStrictEqual(resumedOptions, openedOptions);
          assert.equal(resumedOptions?.model, nextModel);
          assert.equal(resumedOptions?.resume, WAKE_NATIVE_SESSION);
          assert.isUndefined(resumedOptions?.sessionId);
          assert.equal(resumedOptions?.permissionMode, "auto");
          assert.lengthOf(harness.processQueues, 2);
        }
        assert.lengthOf(harness.offeredMessages, 2);
        assert.deepEqual(harness.permissionModeChanges, []);
        assert.deepEqual(harness.liveSelectionChanges, []);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );
});
