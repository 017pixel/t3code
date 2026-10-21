import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "test-model" };
const databaseLayer = SqlitePersistence.layerMemory;
const capabilities = {
  ...ClaudeProviderCapabilitiesV2,
  sessions: {
    ...ClaudeProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
    supportsRuntimeModeSwitchInSession: false,
  },
};

it.effect.each([
  "approval status",
  "approval shell selection",
  "confirmed background",
  "completed",
  "dynamic approval",
  "accepted approval",
  "pending",
  "unlinked running",
] as const)("runtime mode change and dispatch preserve terminal shell invariants: %s", (check) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("terminal-shell-items");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:claudeAgent:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:terminal-shell-items");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:terminal-shell-items"),
          title: "Terminal shell items",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        const dispatch = (id: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: "Continue",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        yield* dispatch("first");
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make("request:pending-shell");
        const commandItem = {
          id: TurnItemId.make("item:pending-shell"),
          threadId,
          runId: first.runId,
          nodeId: NodeId.make("node:command"),
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          nativeItemRef: { driver, nativeId: "shell-native", strength: "strong" as const },
          parentItemId: null,
          ordinal: 100,
          status:
            check === "completed"
              ? ("completed" as const)
              : check === "pending"
                ? ("pending" as const)
                : ("running" as const),
          title: "Approval-blocked shell",
          startedAt: now,
          completedAt: check === "completed" ? now : null,
          updatedAt: now,
          ...(check === "dynamic approval"
            ? { type: "dynamic_tool" as const, toolName: "mcp:test", input: {} }
            : { type: "command_execution" as const, input: "echo approved" }),
        };
        const commandNode = {
          id: NodeId.make("node:command"),
          threadId,
          runId: first.runId,
          parentNodeId: first.rootNodeId,
          rootNodeId: first.rootNodeId,
          kind: "tool_call" as const,
          status: commandItem.status,
          countsForRun: true,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          nativeItemRef: commandItem.nativeItemRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: commandItem.completedAt,
        };
        const approvalPending = check.includes("approval");
        const ingested = yield* watch((event) =>
          approvalPending
            ? event.type === "runtime-request.updated" && event.payload.id === requestId
            : event.type === "turn-item.updated" && event.payload.id === commandItem.id,
        );
        if (check === "confirmed background") {
          yield* Queue.offer(events, {
            type: "provider_thread.updated",
            driver,
            providerThread: {
              ...projection.providerThreads[0]!,
              pendingBackgroundTasks: [
                { taskId: "shell-native", kind: "command", description: "Confirmed shell" },
              ],
            },
          });
        }
        yield* Queue.offer(events, { type: "node.updated", driver, node: commandNode });
        yield* Queue.offer(events, { type: "turn_item.updated", driver, turnItem: commandItem });
        if (approvalPending) {
          const approvalNodeId = NodeId.make("node:approval");
          yield* Queue.offer(events, {
            type: "node.updated",
            driver,
            node: {
              ...commandNode,
              id: approvalNodeId,
              parentNodeId: commandNode.id,
              kind: "approval_request",
              status: "waiting",
              runtimeRequestId: requestId,
            },
          });
          yield* Queue.offer(events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...commandItem,
              id: TurnItemId.make("item:approval"),
              nodeId: approvalNodeId,
              type: "approval_request",
              requestId,
              requestKind: "command",
              status: "waiting",
            },
          });
          yield* Queue.offer(events, {
            type: "node.updated",
            driver,
            node: {
              ...commandNode,
              id: NodeId.make("node:unrelated-approval"),
              parentNodeId: first.rootNodeId,
              kind: "approval_request",
              status: "waiting",
              runtimeRequestId: RuntimeRequestId.make("request:unrelated"),
            },
          });
          yield* Queue.offer(events, {
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: {
              id: RuntimeRequestId.make("request:unrelated"),
              nodeId: NodeId.make("node:unrelated-approval"),
              providerTurnId: turn.id,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: projection.providerSessions[0]!.id,
              },
              createdAt: now,
              resolvedAt: null,
            },
          });
          yield* Queue.offer(events, {
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: {
              id: requestId,
              nodeId: approvalNodeId,
              providerTurnId: turn.id,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: projection.providerSessions[0]!.id,
              },
              createdAt: now,
              resolvedAt: null,
            },
          });
        }
        yield* Fiber.join(ingested);
        const before = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
          (item) => item.id === commandItem.id,
        );
        assert.ok(before);
        assert.equal(
          before.status,
          check === "completed" ? "completed" : check === "pending" ? "pending" : "running",
        );
        const ingestedProjection = yield* orchestrator.getThreadProjection(threadId);
        if (approvalPending) {
          assert.equal(
            ingestedProjection.runtimeRequests.find((request) => request.id === requestId)?.status,
            "pending",
          );
          assert.equal(
            ingestedProjection.runtimeRequests.find((request) => request.id === requestId)?.nodeId,
            NodeId.make("node:approval"),
          );
          assert.equal(
            ingestedProjection.nodes.find((node) => node.id === NodeId.make("node:approval"))
              ?.parentNodeId,
            commandNode.id,
          );
        } else {
          assert.deepEqual(ingestedProjection.runtimeRequests, []);
        }
        if (check === "accepted approval") {
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("approve"),
            threadId,
            requestId,
            decision: "accept",
          });
          yield* worker.drain();
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
              (request) => request.id === requestId,
            )?.status,
            "resolved",
          );
        }
        const failed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "failed",
        );
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("change-mode"),
          threadId,
          runtimeMode: "auto",
        });
        yield* worker.drain();
        yield* Fiber.join(failed);
        // Read before the next run hides background tasks behind its active status.
        const snapshot = yield* projections.getShellSnapshot();
        const shell = snapshot.threads.find((thread) => thread.id === threadId)!;
        assert.ok(shell);
        const pending = shell.pendingBackgroundTasks ?? [];
        yield* dispatch("second");
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === first.runId)?.status, "failed");
        const item = after.turnItems.find((item) => item.id === commandItem.id)!;
        if (check === "approval status" || check === "dynamic approval" || check === "pending") {
          assert.equal(item.status, "cancelled");
          assert.equal(after.nodes.find((node) => node.id === commandNode.id)?.status, "cancelled");
          assert.isNotNull(item.completedAt);
          assert.equal(item.toolNonExecutionKind, "cancelled");
          const lateEvent: OrchestrationV2DomainEvent = {
            id: EventId.make("late-tool-use"),
            type: "turn-item.updated",
            threadId,
            runId: first.runId,
            occurredAt: now,
            payload: commandItem,
          };
          assert.deepEqual(
            ProjectionStore.applyToProjection(after, lateEvent).turnItems.find(
              (candidate) => candidate.id === item.id,
            ),
            item,
          );
          yield* projections.apply(lateEvent);
          assert.deepEqual(yield* projections.getTurnItem({ threadId, itemId: item.id }), item);
        } else if (check === "approval shell selection") {
          assert.isFalse(pending.some((task) => task.taskId === "shell-native"));
        } else if (check === "confirmed background") {
          assert.deepEqual(item, before);
          assert.isTrue(pending.some((task) => task.taskId === "shell-native"));
        } else {
          assert.deepEqual(item, before);
          assert.equal(
            pending.some((task) => task.taskId === "shell-native"),
            check !== "completed",
          );
        }
        if (approvalPending) {
          const unrelated = after.runtimeRequests.find(
            (request) => request.id === RuntimeRequestId.make("request:unrelated"),
          )!;
          assert.equal(unrelated.status, "pending");
          assert.equal(unrelated.responseCapability.type, "live");
          assert.equal(after.nodes.find((node) => node.id === unrelated.nodeId)?.status, "waiting");
        }
        if (approvalPending && check !== "accepted approval") {
          assert.equal(item.status, "cancelled");
          const request = after.runtimeRequests.find((request) => request.id === requestId)!;
          assert.equal(request.status, "cancelled");
          assert.deepEqual(request.responseCapability, {
            type: "not_resumable",
            reason: "The tool was cancelled before this approval was resolved.",
          });
          assert.isNotNull(request.resolvedAt);
          const approvalNode = after.nodes.find((node) => node.id === request.nodeId)!;
          assert.equal(approvalNode.status, "cancelled");
          assert.isNotNull(approvalNode.completedAt);
          const approvalItem = after.turnItems.find(
            (item) => item.id === TurnItemId.make("item:approval"),
          )!;
          assert.equal(approvalItem.status, "cancelled");
          assert.isNotNull(approvalItem.completedAt);
          const response = yield* orchestrator
            .dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("late-approve"),
              threadId,
              requestId,
              decision: "accept",
            })
            .pipe(Effect.flip);
          assert.equal(response._tag, "OrchestratorDispatchError");
          assert.equal(response.cause, `Runtime request ${requestId} is cancelled.`);
        } else if (check === "accepted approval") {
          assert.equal(
            after.runtimeRequests.find((request) => request.id === requestId)?.status,
            "resolved",
          );
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ProviderReplayHarness.layerWithRegistry(
              { name: "terminal-shell-items" },
              ProviderAdapterRegistry.layerFromAdapters([adapter]),
              { runEffectWorker: false, databaseLayer },
            ),
            ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
          ),
        ),
      );
    }),
  ),
);
