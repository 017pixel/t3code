import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as EventStore from "./EventStore.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerProjectionStoreTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

const threadId = ThreadId.make("thread:checkpoint-capture-delegated");
const projectId = ProjectId.make("project:checkpoint-capture-delegated");
const runId = RunId.make("run:checkpoint-capture-delegated");
const scopeId = CheckpointScopeId.make("scope:checkpoint-capture-delegated");
const rootNodeId = NodeId.make("node:checkpoint-capture-delegated-root");
const taskId = NodeId.make("node:checkpoint-capture-task");
const deliveryMessageId = MessageId.make("message:checkpoint-capture-delivery");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-capture-delegated");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} as const;

it.layer(layerProjectionStoreTest)("CheckpointCaptureServiceV2", (it) => {
  it.effect.each([false, true])(
    "captures without decoding history or losing newer delegated completion, ref lookup fails=%s",
    (refLookupFails) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const later = DateTime.add(now, { seconds: 1 });

        const staleDelegatedCompletion = {
          disposition: "open" as const,
          nextGeneration: 1,
          delivery: null,
        };
        const newerCohort = {
          disposition: "open" as const,
          nextGeneration: 2,
          delivery: {
            generation: 1,
            messageId: deliveryMessageId,
            taskIds: [taskId],
          },
        };
        const staleRun: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:checkpoint-capture-user"),
          rootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          delegatedCompletion: staleDelegatedCompletion,
        };
        const rootNode = {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn" as const,
          status: "waiting" as const,
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: now,
          completedAt: null,
        };
        const scope = {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        };
        const providerThread = {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const readyBaseline = {
          id: CheckpointId.make("checkpoint:baseline-0"),
          threadId,
          scopeId,
          runId: null,
          nodeId: rootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:baseline-0"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };
        const captured = {
          id: CheckpointId.make("checkpoint:captured-1"),
          threadId,
          scopeId,
          runId,
          nodeId: rootNodeId,
          parentCheckpointId: readyBaseline.id,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("checkpoint-ref:captured-1"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };

        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Checkpoint capture delegated completion",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:run-stale"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: staleRun,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:node"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: rootNode,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:provider-thread"),
          type: "provider-thread.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: providerThread,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:scope"),
          type: "checkpoint-scope.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          occurredAt: now,
          payload: scope,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:baseline"),
          type: "checkpoint.captured",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: readyBaseline,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, ${runId}, ${rootNodeId}, NULL, NULL,
            NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
          WHERE checkpoint_id = ${readyBaseline.id}`;
        assert.equal(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );

        const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              ThreadCommandExecutor.layer,
              refLookupFails
                ? CheckpointService.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        IdAllocator.layer,
                        NodeCrypto.layer,
                        Layer.mock(CheckpointStore.CheckpointStore)({
                          listAuthoredPaths: () => Effect.succeed(null),
                          isGitRepository: () => Effect.succeed(true),
                          captureCheckpoint: () => Effect.void,
                          hasCheckpointRef: () =>
                            Effect.fail(
                              new VcsProcessTimeoutError({
                                operation: "test.hasCheckpointRef",
                                command: "git",
                                cwd: "/repo",
                                timeoutMs: 30000,
                              }),
                            ),
                        }),
                      ),
                    ),
                  )
                : Layer.mock(CheckpointService.CheckpointServiceV2)({
                    materializeBaselineCheckpoint: () =>
                      Effect.die(
                        "baseline materialization must be skipped when ordinal 0 is ready",
                      ),
                    capture: () => Effect.succeed(captured),
                  }),
              Layer.mock(EventSink.EventSinkV2)({
                writeIfRunCurrent: (input) =>
                  Ref.set(committed, input.events).pipe(
                    Effect.as({ committed: true, storedEvents: [] }),
                  ),
                commitCommand: (input) =>
                  Ref.set(committed, input.events).pipe(
                    Effect.as({
                      commandId: input.commandId,
                      committed: true,
                      sequence: 1,
                      events: input.events,
                      effects: [],
                    } as never),
                  ),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          const incomplete = yield* service
            .execute({ threadId, runId, scopeId: CheckpointScopeId.make("missing-scope") })
            .pipe(Effect.flip);
          assert.instanceOf(incomplete, CheckpointCaptureService.CheckpointCaptureExecutionError);
          yield* service.execute({ threadId, runId, scopeId });

          const events = yield* Ref.get(committed);
          const runUpdated = events.find((event) => event.type === "run.updated");
          assert.isDefined(runUpdated);
          if (runUpdated?.type !== "run.updated") {
            return;
          }
          assert.equal(runUpdated.payload.status, "completed");
          const capturedEvent = events.find((event) => event.type === "checkpoint.captured");
          assert.equal(
            runUpdated.payload.checkpointId,
            refLookupFails ? capturedEvent?.payload.id : captured.id,
          );
          if (refLookupFails && capturedEvent?.type === "checkpoint.captured") {
            assert.equal(capturedEvent.payload.status, "ready");
            assert.deepEqual(capturedEvent.payload.files, []);
          }
          assert.isUndefined(
            runUpdated.payload.delegatedCompletion,
            "checkpoint capture must omit delegatedCompletion so ProjectionStore can keep a newer cohort",
          );

          yield* projectionStore.apply({
            id: EventId.make("event:checkpoint-capture:newer-cohort"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: later,
            payload: {
              ...staleRun,
              delegatedCompletion: newerCohort,
            },
          });

          yield* projectionStore.apply(runUpdated);

          const projectedRun = (yield* projectionStore.getCheckpointCaptureContext(threadId, {
            runId,
            scopeId,
          })).run;
          assert.isDefined(projectedRun);
          assert.equal(projectedRun?.status, "completed");
          assert.equal(projectedRun?.checkpointId, runUpdated.payload.checkpointId);
          assert.deepEqual(projectedRun?.delegatedCompletion, newerCohort);
          assert.equal(projectedRun?.delegatedCompletion?.delivery?.messageId, deliveryMessageId);
          assert.deepEqual(projectedRun?.delegatedCompletion?.delivery?.taskIds, [taskId]);
          yield* Ref.set(committed, []);
          yield* service.execute({ threadId, runId, scopeId });
          assert.deepEqual(yield* Ref.get(committed), []);
        }).pipe(Effect.provide(layerCapture));
      }),
  );

  it.effect("does not capture a stopped run that a rollback already discarded", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const stoppedThreadId = ThreadId.make("thread:checkpoint-capture-rolled-back");
      const stoppedRunId = RunId.make("run:checkpoint-capture-rolled-back");
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:thread"),
        type: "thread.created",
        threadId: stoppedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: stoppedThreadId,
          projectId,
          title: "Checkpoint capture after rollback",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: stoppedThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const stoppedRun: OrchestrationV2Run = {
        id: stoppedRunId,
        threadId: stoppedThreadId,
        ordinal: 2,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-rolled-back"),
        rootNodeId,
        activeAttemptId: null,
        status: "interrupted",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:run"),
        type: "run.updated",
        threadId: stoppedThreadId,
        runId: stoppedRunId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...stoppedRun, status: "rolled_back" },
      });

      const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            ThreadCommandExecutor.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              materializeBaselineCheckpoint: () => Effect.die("a discarded run has no baseline"),
              capture: () => Effect.die("a discarded run must not be captured"),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
              writeIfRunCurrent: (input) =>
                Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
            }),
          ),
        ),
      );

      yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
        Effect.flatMap((service) =>
          service.execute({ threadId: stoppedThreadId, runId: stoppedRunId, scopeId }),
        ),
        Effect.provide(layerCapture),
      );

      assert.deepEqual(yield* Ref.get(committed), []);
      const projected = yield* projectionStore.getCheckpointCaptureContext(stoppedThreadId, {
        runId: stoppedRunId,
        scopeId,
      });
      assert.equal(projected.run?.status, "rolled_back");
      assert.isNull(projected.run?.checkpointId ?? null);
    }),
  );

  const seedCaptureRun = (key: string, terminalStatus: "waiting" | "cancelled" | "interrupted") =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const cancelledAt = DateTime.add(now, { seconds: 1 });
      const cancelledThreadId = ThreadId.make(`thread:checkpoint-capture:${key}`);
      const cancelledRunId = RunId.make(`run:checkpoint-capture:${key}`);
      const cancelledScopeId = CheckpointScopeId.make(`scope:checkpoint-capture:${key}`);
      const cancelledRootNodeId = NodeId.make(`node:checkpoint-capture-root:${key}`);
      const cancelledProviderThreadId = ProviderThreadId.make(
        `provider-thread:checkpoint-capture:${key}`,
      );
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:thread"),
        type: "thread.created",
        threadId: cancelledThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: cancelledThreadId,
          projectId,
          title: "Checkpoint capture after cancel",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: cancelledThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const runningRun: OrchestrationV2Run = {
        id: cancelledRunId,
        threadId: cancelledThreadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: cancelledProviderThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-cancelled"),
        rootNodeId: cancelledRootNodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const runningRootNode = {
        id: cancelledRootNodeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        parentNodeId: null,
        rootNodeId: cancelledRootNodeId,
        kind: "root_turn" as const,
        status: "running" as const,
        countsForRun: true,
        providerThreadId: cancelledProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: cancelledScopeId,
        startedAt: now,
        completedAt: null,
      };
      const scope = {
        id: cancelledScopeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentScopeId: null,
        providerThreadId: cancelledProviderThreadId,
        kind: "root_run" as const,
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:provider-thread"),
        type: "provider-thread.updated",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: cancelledProviderThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: cancelledThreadId,
          ownerNodeId: cancelledRootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:scope"),
        type: "checkpoint-scope.created",
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        occurredAt: now,
        payload: scope,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:baseline"),
        type: "checkpoint.captured",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: CheckpointId.make("checkpoint:cancelled-baseline-0"),
          threadId: cancelledThreadId,
          scopeId: cancelledScopeId,
          runId: null,
          nodeId: cancelledRootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:cancelled-baseline-0"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      });
      for (const [status, completedAt] of [
        ["running", null],
        [terminalStatus, terminalStatus === "waiting" ? null : cancelledAt],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:run-${status}`),
          type: "run.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRun, status, completedAt },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:node-${status}`),
          type: "node.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRootNode, status, completedAt },
        });
      }

      const captured = {
        id: CheckpointId.make("checkpoint:cancelled-captured-1"),
        threadId: cancelledThreadId,
        scopeId: cancelledScopeId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentCheckpointId: CheckpointId.make("checkpoint:cancelled-baseline-0"),
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make("checkpoint-ref:cancelled-captured-1"),
        status: "ready" as const,
        files: [],
        capturedAt: cancelledAt,
      };

      return {
        projectionStore,
        cancelledAt,
        cancelledThreadId,
        cancelledRunId,
        cancelledScopeId,
        captured,
        input: { threadId: cancelledThreadId, runId: cancelledRunId, scopeId: cancelledScopeId },
      };
    });

  it.effect.each(["cancelled", "interrupted"] as const)(
    "records the checkpoint of a %s run and preserves its terminal status on redelivery",
    (status) =>
      Effect.gen(function* () {
        const {
          projectionStore,
          cancelledAt,
          cancelledThreadId,
          cancelledRunId,
          cancelledScopeId,
          captured,
        } = yield* seedCaptureRun(status, status);
        const commits = yield* Ref.make(0);
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              ThreadCommandExecutor.layer,
              Layer.mock(CheckpointService.CheckpointServiceV2)({
                materializeBaselineCheckpoint: () =>
                  Effect.die("baseline materialization must be skipped when ordinal 0 is ready"),
                capture: () => Effect.succeed(captured),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                writeIfRunCurrent: (input) =>
                  Effect.forEach(input.events, (event) => projectionStore.apply(event)).pipe(
                    Effect.andThen(Ref.update(commits, (count) => count + 1)),
                    Effect.as({ committed: true, storedEvents: [] }),
                    Effect.orDie,
                  ),
                commitCommand: (input) =>
                  Effect.forEach(input.events, (event) => projectionStore.apply(event)).pipe(
                    Effect.andThen(Ref.update(commits, (count) => count + 1)),
                    Effect.as({ committed: true } as never),
                    Effect.orDie,
                  ),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          yield* service.execute({
            threadId: cancelledThreadId,
            runId: cancelledRunId,
            scopeId: cancelledScopeId,
          });
          yield* service.execute({
            threadId: cancelledThreadId,
            runId: cancelledRunId,
            scopeId: cancelledScopeId,
          });
        }).pipe(Effect.provide(layerCapture));

        assert.equal(yield* Ref.get(commits), 1);
        const projected = yield* projectionStore.getCheckpointCaptureContext(cancelledThreadId, {
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
        assert.equal(projected.run?.status, status);
        assert.equal(projected.run?.checkpointId, captured.id);
        const completedAt = projected.run?.completedAt;
        assert.equal(
          completedAt ? DateTime.formatIso(completedAt) : completedAt,
          DateTime.formatIso(cancelledAt),
        );
        assert.equal(projected.rootNode?.status, status);
        assert.deepEqual([...projected.readyCheckpointOrdinals].toSorted(), [0, 1]);
      }),
  );

  it.effect(
    "only a final Git failure settles capture; retry and interruption leave it waiting",
    () =>
      Effect.gen(function* () {
        const { input, projectionStore } = yield* seedCaptureRun("git-failure", "waiting");
        const started = yield* Deferred.make<void>();
        let blockCapture = true;
        const context = projectionStore.getCheckpointCaptureContext(input.threadId, input);
        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          const request = { ...input, willRetry: false };
          const capturing = yield* service.execute(request).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(capturing);
          assert.equal((yield* context).run?.status, "waiting");
          blockCapture = false;
          const retryRequest = { ...input, willRetry: true };
          assert.isTrue(Exit.isFailure(yield* service.execute(retryRequest).pipe(Effect.exit)));
          assert.equal((yield* context).run?.status, "waiting");
          const retrying = yield* projectionStore.getThreadProjection(input.threadId);
          assert.equal(
            retrying.turnItems.filter((item) => item.type === "system_notice").length,
            0,
          );
          assert.isTrue(Exit.isFailure(yield* service.execute(request).pipe(Effect.exit)));
        }).pipe(
          Effect.provide(
            CheckpointCaptureService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  IdAllocator.layer,
                  ThreadCommandExecutor.layer,
                  EventSink.layer.pipe(Layer.provide(EventStore.layer)),
                  Layer.mock(CheckpointService.CheckpointServiceV2)({
                    capture: () =>
                      blockCapture
                        ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                        : Effect.fail(
                            new CheckpointService.CheckpointCaptureError({
                              scopeId: input.scopeId,
                              cause: "Git capture failed",
                            }),
                          ),
                  }),
                ),
              ),
            ),
          ),
        );
        const failed = yield* context;
        assert.equal(failed.run?.status, "failed");
        assert.equal(failed.rootNode?.status, "failed");
        assert.isNull(failed.run?.checkpointId);
        const projection = yield* projectionStore.getThreadProjection(input.threadId);
        assert.lengthOf(
          projection.turnItems.filter((item) => item.type === "system_notice"),
          1,
        );
      }),
  );

  it.effect.each(["capture-first", "stop-first", "failure-after-stop"] as const)(
    "settles checkpoint work against Stop under the thread lock: %s",
    (order) =>
      Effect.gen(function* () {
        const { input, captured, projectionStore, cancelledAt } = yield* seedCaptureRun(
          order,
          "waiting",
        );
        const sink = yield* EventSink.EventSinkV2;
        const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const gitStarted = yield* Deferred.make<void>();
        const releaseGit = yield* Deferred.make<void>();
        const settlementAttempted = yield* Deferred.make<void>();
        const writeEntered = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const stopRead = yield* Deferred.make<void>();
        const releaseStop = yield* Deferred.make<void>();
        const stopAttempted = yield* Deferred.make<void>();
        const context = projectionStore.getCheckpointCaptureContext(input.threadId, input);
        const checkpointFailure = new CheckpointService.CheckpointCaptureError({
          scopeId: input.scopeId,
          cause: "Git capture failed",
        });
        const beforeWrite = Deferred.succeed(settlementAttempted, undefined).pipe(
          Effect.andThen(Deferred.succeed(writeEntered, undefined)),
          Effect.andThen(order === "capture-first" ? Deferred.await(releaseWrite) : Effect.void),
        );
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, {
                ...commands,
                withLock: (key, effect) =>
                  Deferred.succeed(settlementAttempted, undefined).pipe(
                    Effect.andThen(commands.withLock(key, effect)),
                  ),
              }),
              Layer.mock(CheckpointService.CheckpointServiceV2)({
                capture: () =>
                  Deferred.succeed(gitStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseGit)),
                    Effect.andThen(
                      order === "failure-after-stop"
                        ? Effect.fail(checkpointFailure)
                        : Effect.succeed(captured),
                    ),
                  ),
              }),
              Layer.succeed(EventSink.EventSinkV2, {
                ...sink,
                commitCommand: (request) =>
                  beforeWrite.pipe(Effect.andThen(sink.commitCommand(request))),
                writeIfRunCurrent: (request) =>
                  beforeWrite.pipe(Effect.andThen(sink.writeIfRunCurrent(request))),
              }),
            ),
          ),
        );
        const stop = Deferred.succeed(stopAttempted, undefined).pipe(
          Effect.andThen(
            commands.withLock(
              input.threadId,
              Effect.gen(function* () {
                const { run, rootNode } = yield* context;
                yield* Deferred.succeed(stopRead, undefined);
                if (run?.status !== "waiting" || rootNode === undefined) return;
                yield* Deferred.await(releaseStop);
                yield* sink.write({
                  events: [
                    {
                      id: EventId.make(`stop-run:${input.runId}`),
                      type: "run.updated",
                      threadId: input.threadId,
                      runId: run.id,
                      occurredAt: cancelledAt,
                      payload: { ...run, status: "interrupted", completedAt: cancelledAt },
                    },
                    {
                      id: EventId.make(`stop-node:${input.runId}`),
                      type: "node.updated",
                      threadId: input.threadId,
                      runId: run.id,
                      occurredAt: cancelledAt,
                      payload: { ...rootNode, status: "interrupted", completedAt: cancelledAt },
                    },
                  ],
                });
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          const request = { ...input, willRetry: false };
          const capturing = yield* service.execute(request).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(gitStarted);
          if (order === "capture-first") {
            yield* Deferred.succeed(releaseGit, undefined);
            yield* Deferred.await(writeEntered);
            const stopping = yield* stop.pipe(Effect.forkChild);
            yield* Deferred.await(stopAttempted);
            yield* Deferred.succeed(releaseStop, undefined);
            yield* Deferred.succeed(releaseWrite, undefined);
            yield* Fiber.join(capturing);
            yield* Fiber.join(stopping);
          } else {
            const stopping = yield* stop.pipe(Effect.forkChild);
            yield* Deferred.await(stopRead);
            yield* Deferred.succeed(releaseGit, undefined);
            // A failed capture may return without attempting a settlement.
            yield* Effect.raceFirst(Deferred.await(settlementAttempted), Fiber.await(capturing));
            assert.equal((yield* context).run?.status, "waiting");
            yield* Deferred.succeed(releaseStop, undefined);
            yield* Fiber.join(stopping);
            const result = yield* Fiber.join(capturing);
            assert.equal(Exit.isFailure(result), order === "failure-after-stop");
          }
        }).pipe(Effect.provide(layerCapture));
        const result = yield* context;
        assert.equal(result.run?.status, order === "capture-first" ? "completed" : "interrupted");
        assert.equal(result.rootNode?.status, result.run?.status);
        assert.equal(result.run?.checkpointId, order === "capture-first" ? captured.id : null);
        const projection = yield* projectionStore.getThreadProjection(input.threadId);
        assert.equal(
          projection.turnItems.filter((item) => item.type === "checkpoint").length,
          order === "capture-first" ? 1 : 0,
        );
        assert.equal(
          projection.turnItems.filter((item) => item.type === "system_notice").length,
          0,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ThreadCommandExecutor.layer,
            EventSink.layer.pipe(Layer.provide(EventStore.layer)),
          ),
        ),
      ),
  );
});
