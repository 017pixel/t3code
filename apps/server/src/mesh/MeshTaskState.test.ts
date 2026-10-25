import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MeshTaskState from "./MeshTaskState.ts";
import { layerOrchestration, modelSelection, seedParent } from "./RemoteDelegation.testkit.ts";
import * as MeshTestkit from "./testkit.ts";

const layer = MeshTaskState.layer.pipe(Layer.provideMerge(layerOrchestration));

describe("mesh.taskState", () => {
  it.effect("times out and aborts a stalled response body and drops its route", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const forgotten: Array<EnvironmentId> = [];
      let signal: AbortSignal | null | undefined;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode('{"workState":'));
        },
        pull() {
          Deferred.doneUnsafe(reading, Effect.void);
        },
      });
      const client = yield* MeshTaskState.MeshTaskStateClient.pipe(
        Effect.provide(
          MeshTaskState.layerClient.pipe(
            Layer.provide(
              MeshTestkit.layerCredentials({
                forgetRoute: (environmentId) =>
                  Effect.sync(() => {
                    forgotten.push(environmentId);
                  }),
              }),
            ),
          ),
        ),
      );
      const member = EnvironmentId.make("member");
      const read = yield* client
        .read(member, {
          threadId: ThreadId.make("thread"),
          runId: RunId.make("run"),
        })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (_url, init) => {
            signal = init?.signal;
            signal?.addEventListener("abort", () => bodyController?.error(new Error("aborted")));
            return new Response(body, { headers: { "content-type": "application/json" } });
          }),
          Effect.flip,
          Effect.forkChild,
        );
      yield* Deferred.await(reading);
      yield* TestClock.adjust("15 seconds");
      assert.isTrue(signal?.aborted);
      assert.strictEqual((yield* Fiber.join(read))._tag, "MeshTaskStateRequestError");
      assert.deepStrictEqual(forgotten, [member]);
    }),
  );

  it.effect("reports a launched thread's work, open question, and result", () =>
    Effect.gen(function* () {
      const thread = yield* seedParent("member-thread");
      const taskState = yield* MeshTaskState.MeshTaskState;
      const sink = yield* EventSink.EventSinkV2;
      const request = { threadId: thread.threadId, runId: thread.runId };
      const scope = {
        threadId: thread.threadId,
        runId: thread.runId,
        providerInstanceId: modelSelection.instanceId,
      };

      const working = yield* taskState.read(request);
      assert.equal(working.workState, "working");
      assert.equal(working.status, "running");
      assert.isFalse(working.settled);
      assert.isFalse(working.hasPendingQuestion);

      const now = yield* DateTime.now;
      const questionId = RuntimeRequestId.make("request:member-question");
      yield* sink.write({
        events: [
          {
            ...scope,
            id: EventId.make("event:member-question"),
            type: "runtime-request.updated",
            nodeId: thread.rootNodeId,
            occurredAt: now,
            payload: {
              id: questionId,
              nodeId: thread.rootNodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make("provider-session:member"),
              },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const asking = yield* taskState.read(request);
      assert.isTrue(asking.hasPendingQuestion);
      assert.equal(asking.pendingQuestionRequestId, questionId);

      const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(thread.threadId, [
        "runs",
      ])).runs[0]!;
      yield* sink.write({
        events: [
          {
            ...scope,
            id: EventId.make("event:member-answer"),
            type: "message.updated",
            nodeId: thread.rootNodeId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:member-answer"),
              threadId: thread.threadId,
              runId: thread.runId,
              nodeId: thread.rootNodeId,
              role: "assistant",
              text: "Deployed to staging.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            ...scope,
            id: EventId.make("event:member-run-completed"),
            type: "run.updated",
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      const settled = yield* taskState.read(request);
      assert.isTrue(settled.settled);
      assert.equal(settled.workState, "result_available");
      assert.equal(settled.status, "completed");
      assert.equal(settled.result, "Deployed to staging.");
      assert.isFalse(settled.hasPendingQuestion);

      const missing = yield* taskState
        .read({ threadId: thread.threadId, runId: RunId.make("run:never") })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "MeshTaskStateNotFoundError");
    }).pipe(Effect.provide(layer)),
  );
  it.effect("reports a question asked by message apart from blocking ones", () =>
    Effect.gen(function* () {
      const thread = yield* seedParent("member-message-question");
      const now = yield* DateTime.now;
      const questionId = RuntimeRequestId.make("request:member-message-question");
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            threadId: thread.threadId,
            runId: thread.runId,
            providerInstanceId: modelSelection.instanceId,
            id: EventId.make("event:member-message-question"),
            type: "runtime-request.updated",
            nodeId: thread.rootNodeId,
            occurredAt: now,
            payload: {
              id: questionId,
              nodeId: thread.rootNodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const taskState = yield* MeshTaskState.MeshTaskState;
      const request = { threadId: thread.threadId, runId: thread.runId };
      const state = yield* taskState.read(request);
      assert.deepEqual(state.messageQuestionRequestIds, [questionId]);
      assert.isFalse(state.hasPendingQuestion);
      assert.isNull(state.pendingQuestionRequestId ?? null);

      const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(thread.threadId, [
        "runs",
      ])).runs[0]!;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            threadId: thread.threadId,
            runId: thread.runId,
            providerInstanceId: modelSelection.instanceId,
            id: EventId.make("event:member-message-question-run-completed"),
            type: "run.updated",
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      const settled = yield* taskState.read(request);
      assert.isTrue(settled.settled);
      assert.deepEqual(settled.messageQuestionRequestIds, [questionId]);
    }).pipe(Effect.provide(layer)),
  );
});
