import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { sortActiveThreadsByOrderKey } from "@t3tools/shared/threadOrder";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

describe("reorderActiveThread", () => {
  const shell = (
    id: string,
    createdAt: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    ({
      id: ThreadId.make(id),
      createdAt: DateTime.makeUnsafe(createdAt),
      unsettledAt: null,
      deletedAt: null,
      archivedAt: null,
      pinnedAt: null,
      settledOverride: null,
      lineage: { relationshipToParent: null },
      activeOrderKey: null,
      runtimeMode: "auto",
      interactionMode: "default",
      ...overrides,
    }) as unknown as OrchestrationV2ThreadShell;

  // Stands in for the orchestrator: applies each key to the snapshot and
  // replays a command id already handled for the same thread, as receipts do.
  const reorderService = (threads: Array<OrchestrationV2ThreadShell>) => {
    const dispatched: Array<
      Extract<OrchestrationV2ServerCommand, { readonly type: "thread.active.reorder" }>
    > = [];
    const receipts = new Map<string, { threadId: ThreadId; sequence: number }>();
    const refuse = new Set<string>();
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getShellSnapshot: () =>
            Effect.sync(() => ({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [...threads],
              archivedThreads: [],
            })),
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type !== "thread.active.reorder") return yield* Effect.die("unexpected");
              const receipt = receipts.get(command.commandId);
              if (receipt !== undefined) {
                if (receipt.threadId !== command.threadId) {
                  return yield* new Orchestrator.OrchestratorCommandIdConflictError({
                    commandId: command.commandId,
                    commandType: command.type,
                    receiptThreadId: receipt.threadId,
                    commandThreadId: command.threadId,
                  });
                }
                return { sequence: receipt.sequence, storedEvents: [] };
              }
              if (refuse.has(command.threadId)) {
                return yield* new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "refused",
                });
              }
              dispatched.push(command);
              const index = threads.findIndex((thread) => thread.id === command.threadId);
              threads[index] = { ...threads[index]!, activeOrderKey: command.orderKey };
              receipts.set(command.commandId, {
                threadId: command.threadId,
                sequence: dispatched.length,
              });
              return { sequence: dispatched.length, storedEvents: [] };
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const order = () =>
      sortActiveThreadsByOrderKey(
        threads
          .filter((thread) => thread.pinnedAt == null && thread.settledOverride !== "settled")
          .map((thread) => ({
            id: thread.id,
            createdAt: DateTime.formatIso(thread.createdAt),
            activeOrderKey: thread.activeOrderKey,
          })),
      ).map((thread) => thread.id);
    const run = (input: {
      threadId: string;
      placement: "before" | "after";
      targetThreadId: string;
    }) =>
      ThreadManagementService.ThreadManagementService.pipe(
        Effect.flatMap((service) =>
          service.reorderActiveThread({
            threadId: ThreadId.make(input.threadId),
            commandId: CommandId.make("command:reorder"),
            placement: input.placement,
            targetThreadId: ThreadId.make(input.targetThreadId),
          }),
        ),
        Effect.provide(layerTest),
      );
    return { run, order, dispatched, refuse };
  };

  const reorder = (
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    input: { threadId: string; placement: "before" | "after"; targetThreadId: string },
  ) =>
    Effect.gen(function* () {
      const service = reorderService([...threads]);
      const result = yield* service.run(input);
      return { result, dispatched: service.dispatched, order: service.order() };
    });

  it.effect("places a thread directly before a keyed neighbor with one write", () =>
    Effect.gen(function* () {
      const { dispatched, order } = yield* reorder(
        [
          shell("a", "2026-01-01T00:00:00Z", { activeOrderKey: "c" }),
          shell("b", "2026-01-01T00:00:00Z", { activeOrderKey: "m" }),
          shell("c", "2026-01-01T00:00:00Z", { activeOrderKey: "t" }),
        ],
        { threadId: "c", placement: "before", targetThreadId: "b" },
      );
      expect(order).toEqual(["a", "c", "b"]);
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("seeds keyless threads so a thread can move above them", () =>
    Effect.gen(function* () {
      const { order } = yield* reorder(
        [
          shell("new", "2026-03-01T00:00:00Z"),
          shell("old", "2026-02-01T00:00:00Z"),
          shell("a", "2026-01-01T00:00:00Z", { activeOrderKey: "m" }),
          shell("pinned", "2026-01-01T00:00:00Z", {
            pinnedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
          }),
        ],
        { threadId: "a", placement: "after", targetThreadId: "new" },
      );
      expect(order).toEqual(["new", "a", "old"]);
    }),
  );

  it.effect("refuses threads outside the active section", () =>
    Effect.gen(function* () {
      const threads = [
        shell("a", "2026-01-01T00:00:00Z"),
        shell("settled", "2026-01-01T00:00:00Z", { settledOverride: "settled" }),
      ];
      const moved = yield* Effect.flip(
        reorder(threads, { threadId: "settled", placement: "before", targetThreadId: "a" }),
      );
      const target = yield* Effect.flip(
        reorder(threads, { threadId: "a", placement: "before", targetThreadId: "settled" }),
      );
      expect(moved).toBeInstanceOf(Orchestrator.OrchestratorDispatchError);
      expect(target).toBeInstanceOf(Orchestrator.OrchestratorDispatchError);
    }),
  );
  const keyless = () => [
    shell("a", "2026-03-01T00:00:00Z"),
    shell("b", "2026-02-01T00:00:00Z"),
    shell("c", "2026-01-01T00:00:00Z", { runtimeMode: "full-access" }),
  ];

  it.effect("refuses a reseed touching a thread above the caller's modes before any write", () =>
    Effect.gen(function* () {
      const service = reorderService(keyless());
      const error = yield* Effect.flip(
        service.run({ threadId: "a", placement: "after", targetThreadId: "b" }).pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "auto",
            interactionMode: "default",
          }),
        ),
      );
      expect(error).toBeInstanceOf(Orchestrator.OrchestratorThreadAboveModeLimitError);
      expect(service.dispatched).toEqual([]);
      expect(service.order()).toEqual(["a", "b", "c"]);
    }),
  );

  it.effect("retrying the same command after a partial reseed does not conflict", () =>
    Effect.gen(function* () {
      const service = reorderService(keyless());
      service.refuse.add("c");
      yield* Effect.flip(service.run({ threadId: "a", placement: "after", targetThreadId: "b" }));
      expect(service.dispatched.map((command) => command.threadId)).toEqual(["b", "a"]);
      service.refuse.clear();
      // Keyless c now sorts above the keyed pair, which already satisfies the
      // request, so the retry replays a's landed write instead of conflicting.
      yield* service.run({ threadId: "a", placement: "after", targetThreadId: "b" });
      expect(service.order()).toEqual(["c", "b", "a"]);
      expect(service.dispatched.map((command) => command.threadId)).toEqual(["b", "a"]);
    }),
  );
});
