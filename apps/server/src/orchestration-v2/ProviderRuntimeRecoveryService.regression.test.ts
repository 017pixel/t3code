import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vite-plus/test";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";

it("uses the thread provider for stale background work without provider threads", async () => {
  const threadId = ThreadId.make("thread_recovery_background_no_provider_threads");
  const runId = RunId.make("run_recovery_background_no_provider_threads");
  const itemId = TurnItemId.make("turn_item_recovery_background_no_provider_threads");
  const providerInstanceId = ProviderInstanceId.make("codex");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "completed", providerInstanceId }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: itemId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        type: "command_execution",
        status: "running",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  await Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const event = committedInput?.events.find(
      (candidate) => candidate.type === "turn-item.updated",
    );
    expect(event?.providerInstanceId).toBe(providerInstanceId);
    expect(event?.type === "turn-item.updated" ? event.payload.status : null).toBe("cancelled");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it.each(["assistant_message", "reasoning", "proposed_plan"] as const)(
  "closes the streaming flag on a cancelled %s item",
  async (type) => {
    const threadId = ThreadId.make(`thread:streaming:${type}`);
    const runId = RunId.make(`run:streaming:${type}`);
    const events: Parameters<
      EventSink.EventSinkV2["Service"]["commitCommand"]
    >[0]["events"][number][] = [];
    const projection = {
      thread: { id: threadId, providerInstanceId: ProviderInstanceId.make("codex") },
      runs: [
        { id: runId, status: "running", providerInstanceId: ProviderInstanceId.make("codex") },
      ],
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: TurnItemId.make(`item:${type}`),
          runId,
          nodeId: null,
          type,
          status: "running",
          streaming: true,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    await Effect.gen(function* () {
      const recovery = yield* ProviderRuntimeRecovery.make;
      yield* recovery.reconcile("startup");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              events.push(...input.events);
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
      Effect.runPromise,
    );
    const item = events.find((event) => event.type === "turn-item.updated");
    expect(
      item?.type === "turn-item.updated" && "streaming" in item.payload && item.payload.streaming,
    ).toBe(false);
  },
);
