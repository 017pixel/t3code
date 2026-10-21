import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ModelSelection, RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
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

const CUSTOM_MODEL_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  customModels: [
    "opus",
    {
      slug: "claude-custom-tuned",
      name: "Tuned",
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "gentle", label: "Gentle", isDefault: true },
              { id: "brutal", label: "Brutal" },
            ],
          },
        ],
      },
    },
  ],
});

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("ClaudeAdapterV2 subagent control", () => {
  const makeStopFixture = (options?: Parameters<typeof makeWakeHarnessWithOptions>[0]) =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<void>();
      const harness = yield* makeWakeHarnessWithOptions({
        ...options,
        stopTask: (id) =>
          Queue.offer(requests, undefined).pipe(
            Effect.andThen(options?.stopTask?.(id) ?? Effect.void),
          ),
      });
      let sequence = 4500;
      const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const startTurn = (continuation = false) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: DateTime.makeUnsafe(0),
            attemptId: RunAttemptId.make(`attempt-stop-${continuation ? 2 : 1}`),
            providerTurnOrdinal: continuation ? 2 : 1,
            text: "Run an audit.",
            attachments: [],
            ...(continuation
              ? { messageCreatedBy: "agent" as const, messageCreationSource: "provider" as const }
              : {}),
          }),
        );
      const start = (toolUseId = "toolu-stop-agent") =>
        harness.offerAndWait(
          makeSubagentTaskStartedFrame({
            taskId: "stop-agent",
            toolUseId,
            uuid: uuid(),
          }),
        );
      const notify = (
        status: "completed" | "failed" | "stopped",
        summary = "Native outcome.",
        toolUseId = "toolu-stop-agent",
      ) =>
        harness.offerAndWait(
          claudeSdkFrame({
            ...makeSubagentNotificationFrame({
              taskId: "stop-agent",
              toolUseId,
              summary,
              uuid: uuid(),
            }),
            status,
          }),
        );
      const stop = (requestedAt?: DateTime.Utc) =>
        harness.runtime.stopSubagent!({
          providerThread: harness.providerThread,
          nativeTaskId: "stop-agent",
          ...(requestedAt === undefined ? {} : { requestedAt }),
        });
      const finishParent = () =>
        harness
          .offerAndWait(makeResultFrame({ uuid: uuid(), result: "Launched." }))
          .pipe(Effect.andThen(Queue.take(harness.terminalReceipts)));
      yield* startTurn();
      yield* start();
      yield* Queue.take(harness.subagentReceipts);
      return {
        ...harness,
        start,
        notify,
        stop,
        finishParent,
        replay: () => startTurn(true),
        uuid,
        requests,
      };
    });

  it.effect("retains native confirmation after the synchronous Agent tool result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeStopFixture({
          stopTask: () => Effect.die("Task already completed"),
        });
        yield* fixture.notify("completed");
        const completed = yield* Queue.take(fixture.subagentReceipts);
        yield* fixture.offerAndWait(
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu-stop-agent", content: "Tool result." },
              ],
            },
            parent_tool_use_id: null,
            uuid: fixture.uuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        assert.equal((yield* Queue.take(fixture.subagentReceipts)).subagent.result, "Tool result.");
        assert.deepEqual(yield* fixture.stop(), {
          status: "completed",
          completedAt: completed.subagent.completedAt!,
          result: "Native outcome.",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    [false, "stopped"],
    [true, "stopped"],
    [false, "completed"],
  ] as const)(
    "stops one native subagent while its sibling keeps running, owner settled %s, outcome %s",
    ([ownerSettled, outcome]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stopped: string[] = [];
          const stopRequested = yield* Deferred.make<void>();
          let closes = 0;
          const harness = yield* makeWakeHarnessWithOptions({
            stopTask: (taskId) =>
              Effect.sync(() => {
                stopped.push(taskId);
              }).pipe(Effect.andThen(Deferred.succeed(stopRequested, undefined))),
            interrupt: Effect.die("A child stop must not interrupt its owner"),
            close: () =>
              Effect.sync(() => {
                closes++;
              }),
          });
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-native-child-stop"),
              text: "Start two agents.",
              attachments: [],
            }),
          );
          for (const [taskId, toolUseId, uuid] of [
            ["agent-stop", "toolu-stop", "00000000-0000-4000-8000-000000000801"],
            ["agent-keep", "toolu-keep", "00000000-0000-4000-8000-000000000802"],
          ]) {
            yield* harness.offerAndWait(
              makeSubagentTaskStartedFrame({ taskId: taskId!, toolUseId: toolUseId!, uuid: uuid! }),
            );
            yield* Queue.take(harness.subagentReceipts);
          }
          if (ownerSettled) {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000803",
                result: "Agents are working.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
          }
          const stop = harness.runtime.stopSubagent;
          assert.isDefined(stop);
          const stopping = yield* stop!({
            providerThread: harness.providerThread,
            nativeTaskId: "agent-stop",
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(stopRequested);
          assert.deepEqual(stopped, ["agent-stop"]);
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...makeSubagentNotificationFrame({
                taskId: "agent-stop",
                toolUseId: "toolu-stop",
                summary: "Stopped by user",
                uuid: "00000000-0000-4000-8000-000000000804",
              }),
              status: outcome,
            }),
          );
          if (ownerSettled) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-native-child-stop-wake"),
                text: "Background task stopped.",
                attachments: [],
                providerTurnOrdinal: 2,
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          yield* Fiber.join(stopping);
          const stoppedEvent = yield* Queue.take(harness.subagentReceipts);
          assert.equal(
            stoppedEvent.subagent.status,
            outcome === "stopped" ? "cancelled" : "completed",
          );
          const tasks = harness.events.filter((event) => event.type === "subagent.updated");
          assert.equal(
            tasks.findLast((event) => event.subagent.nativeTaskRef?.nativeId === "agent-stop")
              ?.subagent.status,
            outcome === "stopped" ? "cancelled" : "completed",
          );
          assert.equal(
            tasks.findLast((event) => event.subagent.nativeTaskRef?.nativeId === "agent-keep")
              ?.subagent.status,
            "running",
          );
          assert.lengthOf(harness.terminalEvents(), ownerSettled ? 1 : 0);
          yield* stop!({ providerThread: harness.providerThread, nativeTaskId: "agent-stop" });
          assert.deepEqual(stopped, ["agent-stop"]);
          assert.equal(closes, 0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each([
    "requested",
    "observed-before",
    "observed-after",
    "synthetic-after",
    "inherit",
    "unknown",
  ] as const)(
    "records the subagent model from %s without inheriting the parent override",
    (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const toolUseId = "toolu-subagent-model";
          const parentModel = "claude-opus-4-6";
          // Claude stamps its own error frames, such as a usage-limit notice, as
          // "<synthetic>"; that is not the model the subagent runs on.
          const observedModel =
            source === "synthetic-after" ? "<synthetic>" : "claude-haiku-4-5-20251001";
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-subagent-model"),
              text: "Spawn a Haiku subagent.",
              attachments: [],
              modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model: parentModel },
            }),
          );
          const observed = claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: toolUseId,
            message: {
              model: observedModel,
              id: "msg_subagent_model_observed",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Solving." }],
            },
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          });
          if (source === "observed-before") yield* Queue.offer(harness.sdkMessages, observed);
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "assistant",
              parent_tool_use_id: null,
              message: {
                model: parentModel,
                id: "msg_subagent_model_launch",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: toolUseId,
                    name: "Agent",
                    input: {
                      description: "Haiku puzzle",
                      subagent_type: "general-purpose",
                      ...(source === "unknown"
                        ? {}
                        : { model: source === "inherit" ? "inherit" : "haiku" }),
                      prompt: "Solve the puzzle.",
                    },
                  },
                ],
              },
              uuid: "00000000-0000-4000-8000-000000000209",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "task-subagent-model",
              tool_use_id: toolUseId,
              description: "Haiku puzzle",
              task_type: "local_agent",
              uuid: "00000000-0000-4000-8000-000000000207",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          if (source === "observed-after" || source === "synthetic-after") {
            yield* Queue.offer(harness.sdkMessages, observed);
          }
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000208",
              result: "Spawned the subagent.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const subagents = harness.events.filter((event) => event.type === "subagent.updated");
          const observedSlug = "claude-haiku-4-5";
          const initialModel =
            source === "observed-before"
              ? observedSlug
              : source === "inherit"
                ? parentModel
                : source === "unknown"
                  ? null
                  : "claude-haiku-5-5";
          assert.equal(subagents[0]?.subagent.model, initialModel);
          assert.equal(
            subagents.at(-1)?.subagent.model,
            source.startsWith("observed") ? observedSlug : initialModel,
          );
          const child = harness.events.find((event) => event.type === "app_thread.created");
          assert.equal(child?.appThread.modelSelection?.model, initialModel ?? parentModel);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("resolves a subagent's model and effort against the instance's custom models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TUNED_TOOL_USE_ID = "toolu-effort-custom-tuned";
        const SHADOW_TOOL_USE_ID = "toolu-effort-custom-shadow";
        const harness = yield* makeWakeHarnessWithOptions({
          settings: CUSTOM_MODEL_CLAUDE_SETTINGS,
        });
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-subagent-custom-effort"),
            text: "Spawn subagents on custom models.",
            attachments: [],
          }),
        );
        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              model: CLAUDE_TEST_MODEL_SELECTION.model,
              id: "msg_custom_effort_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: TUNED_TOOL_USE_ID,
                  name: "Agent",
                  input: {
                    description: "Tuned",
                    subagent_type: "general-purpose",
                    model: "claude-custom-tuned",
                    effort: "brutal",
                    prompt: "Check one thing.",
                  },
                },
                {
                  type: "tool_use",
                  id: SHADOW_TOOL_USE_ID,
                  name: "Agent",
                  input: {
                    description: "Shadow",
                    subagent_type: "general-purpose",
                    model: "opus",
                    prompt: "Check another thing.",
                  },
                },
              ],
            },
            uuid: "00000000-0000-4000-8000-000000000231",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...[TUNED_TOOL_USE_ID, SHADOW_TOOL_USE_ID].map((id, index) =>
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: `task-${id}`,
              tool_use_id: id,
              description: id,
              task_type: "local_agent",
              uuid: `00000000-0000-4000-8000-00000000023${index + 2}`,
              session_id: WAKE_NATIVE_SESSION,
            }),
          ),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000234",
            result: "Spawned the subagents.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.take(harness.terminalReceipts);

        const selections = Object.fromEntries(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent.modelSelection] as const]
              : [],
          ),
        );
        const instanceId = CLAUDE_TEST_MODEL_SELECTION.instanceId;
        assert.deepEqual(selections, {
          [`task-${TUNED_TOOL_USE_ID}`]: {
            instanceId,
            model: "claude-custom-tuned",
            options: [{ id: "effort", value: "brutal" }],
          },
          [`task-${SHADOW_TOOL_USE_ID}`]: { instanceId, model: "opus" },
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("gives a nested subagent its own effort, else the one its owner runs at", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TOOL_USE_ID = "toolu-effort-outer";
        const INHERITING_TOOL_USE_ID = "toolu-effort-nested-inheriting";
        const OVERRIDING_TOOL_USE_ID = "toolu-effort-nested-overriding";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const parentSelection = {
          instanceId: CLAUDE_TEST_MODEL_SELECTION.instanceId,
          model: "claude-opus-4-6",
          options: [{ id: "effort", value: "high" }],
        } satisfies ModelSelection;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-subagent-nested-effort"),
            text: "Spawn a subagent that spawns two more.",
            attachments: [],
            modelSelection: parentSelection,
          }),
        );
        const agentCall = (id: string, effort?: string) => ({
          type: "tool_use" as const,
          id,
          name: "Agent",
          input: {
            description: id,
            subagent_type: "general-purpose",
            ...(effort === undefined ? {} : { effort }),
            prompt: "Check one thing.",
          },
        });
        const taskStarted = (id: string, uuid: string) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: `task-${id}`,
            tool_use_id: id,
            description: id,
            task_type: "local_agent",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              model: parentSelection.model,
              id: "msg_nested_effort_outer_launch",
              type: "message",
              role: "assistant",
              content: [agentCall(OUTER_TOOL_USE_ID, "low")],
            },
            uuid: "00000000-0000-4000-8000-000000000221",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted(OUTER_TOOL_USE_ID, "00000000-0000-4000-8000-000000000222"),
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            message: {
              model: parentSelection.model,
              id: "msg_nested_effort_inner_launch",
              type: "message",
              role: "assistant",
              content: [
                agentCall(INHERITING_TOOL_USE_ID),
                agentCall(OVERRIDING_TOOL_USE_ID, "max"),
              ],
            },
            uuid: "00000000-0000-4000-8000-000000000223",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted(INHERITING_TOOL_USE_ID, "00000000-0000-4000-8000-000000000224"),
          taskStarted(OVERRIDING_TOOL_USE_ID, "00000000-0000-4000-8000-000000000225"),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000226",
            result: "Spawned the subagents.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.take(harness.terminalReceipts);

        const efforts = new Map(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [
                  [
                    event.subagent.nativeTaskRef?.nativeId,
                    getModelSelectionStringOptionValue(event.subagent.modelSelection, "effort"),
                  ] as const,
                ]
              : [],
          ),
        );
        assert.deepEqual(Object.fromEntries(efforts), {
          [`task-${OUTER_TOOL_USE_ID}`]: "low",
          [`task-${INHERITING_TOOL_USE_ID}`]: "low",
          [`task-${OVERRIDING_TOOL_USE_ID}`]: "max",
        });
        const childEfforts = harness.events.flatMap((event) =>
          event.type === "app_thread.created" && event.appThread.id !== harness.threadId
            ? [getModelSelectionStringOptionValue(event.appThread.modelSelection, "effort")]
            : [],
        );
        assert.deepEqual(childEfforts, ["low", "low", "max"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("extracts text from direct content-block subagent results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-direct-content-blocks";
        const SUBAGENT_TOOL_USE_ID = "toolu-direct-content-blocks";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-direct-content-blocks"),
            text: "Delegate this task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Delegated task",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the result.",
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.until(() => subagentEvents().length === 1);

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: SUBAGENT_TOOL_USE_ID,
                  content: [
                    { type: "text", text: "First line." },
                    { type: "text", text: "Second line." },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000207",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.until(() => subagentEvents().at(-1)?.subagent.status === "completed");

        assert.equal(subagentEvents().at(-1)?.subagent.result, "First line.\nSecond line.");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000208",
            result: "Delegation completed.",
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

  it.effect("releases the idle pin when a post-settle subagent stops without completing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-wake-subagent-stopped";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          description: "Long-running research task",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Investigate the flaky test.",
          uuid: "00000000-0000-4000-8000-000000000301",
          session_id: WAKE_NATIVE_SESSION,
        });
        const subagentStoppedNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          status: "stopped",
          output_file: "/tmp/task-wake-subagent-stopped.output",
          summary: "Agent was stopped before finishing.",
          uuid: "00000000-0000-4000-8000-000000000302",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* harness.until(() => subagentEvents().length >= 1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000303",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, subagentStoppedNotification);
        yield* harness.awaitContinuation(1);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000304",
            result: "The subagent was stopped.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        assert.equal(subagentEvents().at(-1)?.subagent.status, "cancelled");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("re-opens a resumed subagent whose task_started races past settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-resume-postsettle";
        const SUBAGENT_TOOL_USE_ID = "toolu-resume-postsettle";
        const RESUME_TOOL_USE_ID = "toolu-resume-postsettle-sendmessage";
        const FIRST_SUMMARY = "Answered early.";
        const SECOND_SUMMARY = "RESUME_SETTLE_DONE";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_SETTLE_DONE.",
          uuid: "00000000-0000-4000-8000-000000000501",
          session_id: WAKE_NATIVE_SESSION,
        });
        const firstNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: FIRST_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000502",
          session_id: WAKE_NATIVE_SESSION,
        });
        const resumeTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          description: "Sleep then echo done token",
          is_backgrounded: true,
          task_type: "local_agent",
          uuid: "00000000-0000-4000-8000-000000000505",
          session_id: WAKE_NATIVE_SESSION,
        });
        const secondNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: SECOND_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000506",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* harness.until(() => subagentEvents().length >= 1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* harness.awaitTerminal(1);

        yield* Queue.offer(harness.sdkMessages, firstNotification);
        yield* harness.awaitContinuation(1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000504",
            result: "The subagent answered early.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");
        assert.equal(subagentEvents().at(-1)?.subagent.result, FIRST_SUMMARY);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_resume_postsettle_sendmessage",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: RESUME_TOOL_USE_ID,
                  name: "SendMessage",
                  input: {
                    to: SUBAGENT_TASK_ID,
                    summary: "Resume the subagent",
                    message: "Continue and return the token.",
                  },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000508",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, resumeTaskStarted);
        // Shaped like the recorded SendMessage ACK in
        // claude_background_subagent_lifecycle: the text block is the JSON of
        // tool_use_result, and "message" names the agent's short id.
        const resumeAck = {
          success: true,
          message: `Resuming agent ${SUBAGENT_TASK_ID.slice(0, 7)}`,
          resumedAgentId: SUBAGENT_TASK_ID,
          pin: { id: SUBAGENT_TASK_ID, name: SUBAGENT_TASK_ID, ref: "42ab31" },
        };
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  tool_use_id: RESUME_TOOL_USE_ID,
                  type: "tool_result",
                  content: [
                    {
                      type: "text",
                      text: encodeJsonString(resumeAck),
                    },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000509",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: resumeAck,
          }),
        );
        for (const frame of [
          ...makeSubagentAssistantFrames({
            parentToolUseId: SUBAGENT_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000961",
            text: "RESUMED_WORK",
            bashToolUseId: "toolu-resume-postsettle-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: SUBAGENT_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000962",
            toolUseId: "toolu-resume-postsettle-bash",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.offer(harness.sdkMessages, secondNotification);
        yield* harness.awaitContinuation(2);
        assert.equal(harness.continuationRequests[1]?.detail, SECOND_SUMMARY);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000507",
            result: "The subagent finished with RESUME_SETTLE_DONE.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);

        const statuses = subagentEvents().map((event) => event.subagent.status);
        const firstCompleted = statuses.indexOf("completed");
        const reopenedIndex = statuses.lastIndexOf("running");
        assert.isAbove(reopenedIndex, firstCompleted);
        assert.isNull(subagentEvents()[reopenedIndex]?.subagent.result);
        assert.equal(subagentEvents()[reopenedIndex]?.subagent.runId, "run-attempt-claude-wake-9c");
        const nodeStatuses = harness.events
          .filter(
            (
              event,
            ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
          )
          .map((event) => event.node.status);
        assert.isAbove(nodeStatuses.lastIndexOf("running"), nodeStatuses.indexOf("completed"));
        const finalSubagent = subagentEvents().at(-1)?.subagent;
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, SECOND_SUMMARY);
        assert.equal(finalSubagent?.runId, "run-attempt-claude-wake-9c");
        const reopenIndex = harness.events.findIndex(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.status === "running" &&
            event.subagent.runId === "run-attempt-claude-wake-9c",
        );
        assert.isAtLeast(reopenIndex, 0);
        const resumedWorkIndexes = harness.events.flatMap((event, index) =>
          event.type === "message.updated" && event.message.text === "RESUMED_WORK" ? [index] : [],
        );
        assert.lengthOf(resumedWorkIndexes, 1);
        assert.isAbove(resumedWorkIndexes[0] ?? -1, reopenIndex);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
