// @effect-diagnostics nodeBuiltinImport:off -- a fixture resolves a synthetic project path
import * as NodePath from "node:path";

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
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
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

describe("ClaudeAdapterV2 errors, limits, and retries", () => {
  it.effect("announces usage-limit pauses once per window and again on a new turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const resetsAt = Math.floor(DateTime.toEpochMillis(now) / 1000) + 7_200;
      const limit = (rateLimitType: "five_hour" | "seven_day" = "five_hour") =>
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
          uuid: "00000000-0000-4000-8000-000000000601",
          session_id: WAKE_NATIVE_SESSION,
        });
      const start = (ordinal: number) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-claude-limit-${ordinal}`),
            providerTurnOrdinal: ordinal,
            text: "Continue.",
            attachments: [],
          }),
        );
      yield* start(1);
      yield* Queue.offer(harness.sdkMessages, limit());
      const pause = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      assert.equal(pause.type, "system_notice");
      if (pause.type !== "system_notice") return;
      assert.equal(
        pause.message,
        "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h.",
      );
      assert.lengthOf(harness.terminalEvents(), 0);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        limit("seven_day"),
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000602",
          result: "Recovered.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      const notices = () =>
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem]
            : [],
        );
      assert.lengthOf(notices(), 2);
      yield* start(2);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000603",
          result: "Done.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      assert.lengthOf(notices(), 3);
      assert.notEqual(notices()[0]?.id, notices()[2]?.id);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("keeps a later future-window event-supplied Claude reset over the embedded reset", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-embedded-limit-event"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "future_window",
            resetsAt: 1791807600,
          },
          uuid: "00000000-0000-4000-8000-000000000683",
          session_id: WAKE_NATIVE_SESSION,
        }),
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000684",
          error: "rate_limit",
          apiErrorParams: {
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1791804000,
            },
          },
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000685",
          result: "Usage limit reached.",
          isError: true,
          apiErrorStatus: 429,
          terminalReason: "api_error",
        }),
      ]);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(terminal.failure.resetAt, "2026-10-12T12:20:00.000Z");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    {
      name: "an unflagged result with surrounding whitespace",
      isError: false,
      result: "  API Error: 400 Request rejected by a safeguard.\n",
      expected: "API Error: 400 Request rejected by a safeguard.",
    },
    {
      name: "a secret crossing the truncation boundary",
      isError: true,
      result: `API Error: 400 ${"x".repeat(440)} {"token":"${"synthetic-secret".repeat(100)}"} ${"y".repeat(100)}`,
      expected: `API Error: 400 ${"x".repeat(440)} {"token":"[REDACTED]"} `.padEnd(500, "y"),
    },
    {
      name: "ordinary assistant text",
      isError: true,
      result: "I found three files.",
      expected: "Claude gave up after repeated API errors.",
    },
    {
      name: "a listed non-diagnostic error",
      isError: true,
      result: "API Error: 400 Request rejected.",
      errors: ["[ede_diagnostic] internal detail", "Tool execution failed: EACCES"],
      expected: "Tool execution failed: EACCES",
    },
    {
      name: "an HTTP 529 overload",
      isError: true,
      result: "API Error: 529 Specific overload detail.",
      apiErrorStatus: 529,
      expected: "Claude API is overloaded (529). Try again shortly.",
    },
    {
      name: "an HTTP 429 rate limit",
      isError: true,
      result: "API Error: 429 Specific rate limit detail.",
      apiErrorStatus: 429,
      expected: "Claude API rate limit reached. Try again later.",
    },
    {
      name: "a different terminal reason",
      isError: true,
      result: "API Error: 400 Request rejected.",
      terminalReason: "prompt_too_long" as const,
      expected:
        "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.",
    },
  ])("reports terminal API error text for $name", (input) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-specific-api-error"),
          text: "Continue.",
          attachments: [],
        }),
      );
      const apiErrorStatus = input.apiErrorStatus ?? 400;
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000699",
          result: input.result,
          terminalReason: input.terminalReason ?? "api_error",
          apiErrorStatus,
          isError: input.isError,
          ...(input.errors === undefined ? {} : { errors: input.errors }),
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.message, input.expected);
      assert.equal(terminal.failure.code, `api_error_${apiErrorStatus}`);
      assert.equal(
        terminal.failure.class,
        apiErrorStatus === 429 ? "usage_limit" : "provider_error",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("names an expired Claude login instead of the terminal API error", () =>
    Effect.gen(function* () {
      const configDir = "/synthetic/Claude config";
      // The adapter resolves the cwd on the host, which adds a drive letter on Windows.
      const cwd = NodePath.resolve("/synthetic/project");
      const harness = yield* makeWakeHarnessWithOptions({
        environment: { CLAUDE_CONFIG_DIR: configDir },
      });
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-auth-failure"),
          text: "Continue.",
          attachments: [],
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd,
          }),
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000606",
          error: "authentication_failed",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000607",
          result: "API Error: 401 Credentials expired.",
          terminalReason: "api_error",
        }),
      ]);

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.include(terminal.failure.message, "run `claude auth login`");
      assert.include(terminal.failure.message, configDir);
      // The message quotes its paths, which escapes Windows separators.
      assert.include(terminal.failure.message, JSON.stringify(cwd));
      assert.notInclude(terminal.failure.message, "repeated API errors");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("shows a 403 permission error instead of the login hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-permission-denied"),
          text: "Continue.",
          attachments: [],
        }),
      );
      // Claude CLI 2.1.288 labels a 403 authentication_failed too.
      const cliText =
        "Failed to authenticate. API Error: 403 Your organization does not have access to this model.";
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000608",
          error: "authentication_failed",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000609",
          result: cliText,
          isError: true,
          apiErrorStatus: 403,
          terminalReason: "api_error",
        }),
      ]);

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.message, cliText);
      assert.equal(terminal.failure.code, "api_error_403");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    {
      name: "fails a /compact the usage limit stopped",
      limited: true,
      compaction: "failed",
      compact: true,
      status: "failed",
    },
    {
      name: "completes an unlimited failed /compact",
      limited: false,
      compaction: "failed",
      compact: true,
      status: "completed",
    },
    {
      name: "completes a successful limited /compact",
      limited: true,
      compaction: "success",
      compact: true,
      status: "completed",
    },
    {
      name: "completes a failed automatic compaction",
      limited: true,
      compaction: "failed",
      compact: false,
      status: "completed",
    },
  ] as const)("$name", ({ name, limited, compaction, compact, status }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const resetsAt = 1791991200;
      const compactError =
        "Error during compaction: You've hit your session limit · resets 5:20pm (Europe/Berlin).";
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-compaction-${name}`),
          text: compact ? "/compact" : "Continue.",
          attachments: [],
        }),
      );
      // Claude reports a compaction's outcome on a status frame. A /compact
      // then ends with a success result naming the command and no terminal
      // reason, even when the compaction failed (#19327). The automatic case
      // omits the terminal reason too, so only the missing command keeps it
      // completed.
      const result = makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000000613",
        result: compact ? "" : "Done.",
        numTurns: compact ? 0 : 1,
        terminalReason: null,
      });
      yield* Queue.offerAll(harness.sdkMessages, [
        ...(limited
          ? [
              claudeSdkFrame({
                type: "rate_limit_event",
                rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt },
                uuid: "00000000-0000-4000-8000-000000000611",
                session_id: WAKE_NATIVE_SESSION,
              }),
            ]
          : []),
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000610",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: compaction,
          ...(compaction === "failed"
            ? { compact_error: limited ? compactError : "Not enough messages to compact." }
            : {}),
          uuid: "00000000-0000-4000-8000-000000000612",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: "Compaction finished; turn continues.",
          level: "warning",
          uuid: "00000000-0000-4000-8000-000000000614",
          session_id: WAKE_NATIVE_SESSION,
        }),
      ]);
      yield* Queue.take(harness.systemNoticeReceipts);
      const updates = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "compaction"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(updates, 2);
      const [running, settled] = updates;
      assert.equal(running?.status, "running");
      assert.equal(settled?.status, compaction === "success" ? "completed" : "failed");
      assert.equal(settled?.id, running?.id);
      assert.equal(settled?.ordinal, running?.ordinal);
      assert.deepEqual(settled?.startedAt, running?.startedAt);
      assert.isNotNull(settled?.completedAt);
      assert.isEmpty(harness.terminalEvents());

      yield* Queue.offer(
        harness.sdkMessages,
        compact ? claudeSdkFrame({ ...result, local_command: "compact" }) : result,
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        ),
        updates,
      );
      assert.equal(terminal.status, status);
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(terminal.failure.message, compactError);
      assert.equal(
        terminal.failure.resetAt,
        DateTime.formatIso(DateTime.makeUnsafe(resetsAt * 1000)),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { name: "parent limit", parentErrors: ["rate_limit"], expectedLimit: true },
    {
      name: "parent limit then nested response",
      parentErrors: ["rate_limit", "nested-ok"],
      expectedLimit: true,
    },
    { name: "nested limit", parentErrors: ["nested-limit"], expectedLimit: false },
    {
      name: "parent limit then parent response",
      parentErrors: ["rate_limit", "ok"],
      expectedLimit: false,
    },
  ])("classifies retried terminal API failures after $name", ({ parentErrors, expectedLimit }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-retry-${parentErrors.join("-")}`),
          text: "Continue.",
          attachments: [],
        }),
      );
      for (const [index, evidence] of parentErrors.entries()) {
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantErrorFrame({
            uuid: `00000000-0000-4000-8000-00000000062${index}`,
            error: evidence.includes("limit") ? "rate_limit" : undefined,
            parentToolUseId: evidence.startsWith("nested") ? "nested-tool" : null,
            ...(evidence.includes("limit")
              ? {
                  apiErrorParams: {
                    rate_limit_info: {
                      status: "rejected",
                      rateLimitType: "five_hour",
                      resetsAt: 1790298600,
                    },
                  },
                }
              : {}),
          }),
        );
      }
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000629",
          result: "API Error",
          isError: true,
          terminalReason: "api_error",
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, expectedLimit ? "usage_limit" : "provider_error");
      assert.equal(
        terminal.failure.resetAt,
        expectedLimit ? "2026-09-25T01:10:00.000Z" : undefined,
      );
      assert.equal(
        terminal.failure.message,
        expectedLimit
          ? "Claude usage limit reached. Send the message again once the limit resets."
          : "Claude gave up after repeated API errors.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { status: 503, cooldown: "4m 6s", seconds: 246 },
    { status: 503, cooldown: "1h 2m 3s", seconds: 3723 },
    { status: 503, cooldown: "7s", seconds: 7 },
    { status: 503, cooldown: "0s", seconds: 0 },
    { status: 503, cooldown: "unknown", seconds: 0 },
    { status: 503, cooldown: "999999999999999999999999h", seconds: 0 },
    { status: 503, cooldown: "4m 6s", seconds: 0, errorType: "overloaded_error" },
    { status: 401, cooldown: "4m 6s", seconds: 0 },
  ])("recovers wrapped gateway limits with status $status and cooldown $cooldown", (input) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-gateway-limit"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000652",
          error: "server_error",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000653",
          result: `API Error: ${input.status} [claude/claude-opus-5-5] [429]: {"type":"error","error":{"type":"${input.errorType ?? "rate_limit_error"}","message":"Please try again later."}} (reset after ${input.cooldown}).`,
          terminalReason: "api_error",
          isError: true,
          apiErrorStatus: input.status,
        }),
      ]);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, input.seconds > 0 ? "usage_limit" : "provider_error");
      if (input.seconds > 0) {
        assert.equal(terminal.failure.retryable, true);
        assert.equal(
          terminal.failure.resetAt,
          DateTime.formatIso(
            DateTime.makeUnsafe(DateTime.toEpochMillis(now) + input.seconds * 1_000),
          ),
        );
      } else {
        assert.isUndefined(terminal.failure.resetAt);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("resolves API retries on resumed assistant activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-api-retry"),
            text: "Open github.com.",
            attachments: [],
          }),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 10,
            retry_delay_ms: 1_500,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retryItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.retry !== undefined
              ? [event.turnItem]
              : [],
          );
        yield* harness.until(() => retryItems().length === 1);
        const runningRetry = retryItems()[0];
        assert.equal(runningRetry?.status, "running");
        assert.equal(runningRetry?.failure.code, "api_error_529");
        assert.deepEqual(runningRetry?.retry, {
          attempt: 2,
          maxAttempts: 10,
          retryDelayMs: 1_500,
        });

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            text: "Opening GitHub.",
          }),
        );
        yield* harness.until(() => retryItems().length === 2);
        assert.lengthOf(harness.terminalEvents(), 0);
        const recoveredRetry = retryItems()[1];
        assert.equal(recoveredRetry?.id, runningRetry?.id);
        assert.equal(recoveredRetry?.status, "completed");
        assert.equal(recoveredRetry?.title, "Provider recovered");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000203",
            result: "Opened GitHub.",
          }),
        );
        yield* harness.awaitTerminal(1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(["api_error", "overloaded_status"] as const)(
    "fails a success-shaped Claude result with %s",
    (terminalReason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-structured-terminal-failure"),
              text: "Complete the task.",
              attachments: [],
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000205",
              result: "Provider failure details.",
              isError: false,
              ...(terminalReason === "overloaded_status"
                ? { apiErrorStatus: 529 }
                : { terminalReason }),
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, "failed");
          if (terminal.status !== "failed") return;
          assert.isNotEmpty(terminal.failure.message);
          assert.equal(terminal.failure.class, "provider_error");
          assert.isFalse(
            harness.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.text === "Provider failure details.",
            ),
          );
          assert.equal(
            terminal.failure.code,
            terminalReason === "overloaded_status" ? "api_error_529" : terminalReason,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  // Frames follow #19832: a full context window ends the turn with
  // blocking_limit while the plan's rate-limit window is still allowed.
  it.effect.each([
    {
      windowStatus: "allowed",
      expectedClass: "provider_error",
      expectedMessage: "Claude stopped: the prompt exceeds the model's context window.",
    },
    {
      windowStatus: "rejected",
      expectedClass: "usage_limit",
      expectedMessage: "Claude usage limit reached. Send the message again once the limit resets.",
    },
  ] as const)(
    "classifies blocking_limit by its rate-limit evidence ($windowStatus window)",
    ({ windowStatus, expectedClass, expectedMessage }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-blocking-limit-${windowStatus}`),
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info: { status: windowStatus, rateLimitType: "five_hour" },
            uuid: "00000000-0000-4000-8000-000000000660",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000661",
            error: "invalid_request",
            text: "Prompt is too long",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000662",
            result: "Prompt is too long",
            isError: true,
            numTurns: 189,
            terminalReason: "blocking_limit",
          }),
        ]);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.equal(terminal.failure.class, expectedClass);
        assert.include(terminal.failure.message, expectedMessage);
        assert.equal(terminal.failure.code, "blocking_limit");
        if (expectedClass === "provider_error") {
          assert.include(terminal.failure.message, "/compact");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );
});
