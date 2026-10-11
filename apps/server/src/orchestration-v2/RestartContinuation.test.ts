import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun, continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { pendingRestartCancelledBackgroundWork } from "./RestartBackgroundNote.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const threadId = ThreadId.make("thread:restart");
const runId = RunId.make("run:restart");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart");
const sessionId = ProviderSessionId.make("session:restart");
const attemptId = RunAttemptId.make("attempt:restart");
const testNow = DateTime.makeUnsafe("2026-10-03T10:00:00.000Z");
// "No project" threads belong to the environment's Scratch project.
const scratchProjectId = ProjectId.make("project:scratch");

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restart-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("requires matching saved native state for an unfinished root run", () => {
  const projection = makeProjection();
  assert.equal(restartContinuationRun(projection, testNow)?.id, runId);
  for (const invalid of [
    { ...projection, thread: { ...projection.thread, archivedAt: {} } },
    { ...projection, thread: { ...projection.thread, deletedAt: {} } },
    {
      ...projection,
      thread: { ...projection.thread, providerInstanceId: ProviderInstanceId.make("other") },
    },
    {
      ...projection,
      providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
    },
    {
      ...projection,
      providerSessions: [
        {
          ...projection.providerSessions[0]!,
          providerInstanceId: ProviderInstanceId.make("other"),
        },
      ],
    },
    { ...projection, providerTurns: [] },
    ...[
      "queued",
      "preparing",
      "starting",
      "waiting",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
    ].map((status) => ({ ...projection, runs: [{ ...projection.runs[0]!, status }] })),
  ])
    assert.isUndefined(restartContinuationRun(invalid as OrchestrationV2ThreadProjection, testNow));
});

it("checks the thread, run, turn and request recovery decision table", () => {
  const base = makeProjection();
  const holds = [
    [{}, false],
    [{ archivedAt: testNow }, true],
    [{ deletedAt: testNow }, true],
    [{ settledOverride: "settled" }, true],
    [{ settledOverride: "unsettled" }, false],
    [{ snoozedUntil: DateTime.add(testNow, { minutes: 1 }) }, true],
    [{ snoozedUntil: testNow }, false],
    [{ snoozedUntil: DateTime.subtract(testNow, { minutes: 1 }) }, false],
  ] as const;
  const requests = [
    [undefined, false],
    [{ kind: "user_input", status: "pending", responseCapability: { type: "live" } }, true],
    [{ kind: "command", status: "pending", responseCapability: { type: "live" } }, true],
    [{ kind: "user_input", status: "pending", responseCapability: { type: "message" } }, false],
    [{ kind: "user_input", status: "resolved", responseCapability: { type: "live" } }, false],
    [
      { kind: "user_input", status: "expired", responseCapability: { type: "not_resumable" } },
      true,
    ],
    [{ kind: "command", status: "cancelled", responseCapability: { type: "not_resumable" } }, true],
    [{ kind: "dynamic_tool_call", status: "pending", responseCapability: { type: "live" } }, false],
    [{ kind: "auth_refresh", status: "pending", responseCapability: { type: "live" } }, false],
  ] as const;
  for (const status of [
    "queued",
    "preparing",
    "starting",
    "running",
    "waiting",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "rolled_back",
  ] as const)
    for (const pending of [false, true])
      for (const [thread, held] of holds)
        for (const turnStatus of [
          "running",
          "completed",
          "failed",
          "interrupted",
          "cancelled",
        ] as const)
          for (const [request, blocked] of requests) {
            const eligible = status === "running" || pending;
            const turnBlocked =
              turnStatus === "failed" ||
              turnStatus === "interrupted" ||
              (turnStatus === "completed" && !pending);
            const projection = {
              ...base,
              thread: { ...base.thread, ...thread },
              runs: [
                {
                  ...base.runs[0]!,
                  status,
                  ...(pending
                    ? { restartPendingMessageIds: [MessageId.make("message:matrix-steer")] }
                    : {}),
                },
              ],
              providerTurns: [{ ...base.providerTurns[0]!, status: turnStatus }],
              runtimeRequests:
                request === undefined
                  ? []
                  : [{ ...request, providerTurnId: base.providerTurns[0]!.id }],
            } as unknown as OrchestrationV2ThreadProjection;
            const expected =
              !["queued", "failed", "interrupted", "rolled_back"].includes(status) &&
              eligible &&
              !held &&
              !blocked &&
              !turnBlocked &&
              (pending || turnStatus === "running");
            assert.equal(
              restartContinuationRun(projection, testNow) !== undefined,
              expected,
              JSON.stringify({ status, pending, thread, turnStatus, request }),
            );
          }
});

it.effect.each([
  ["user_input", "pending", "live", false],
  ["user_input", "expired", "not_resumable", false],
  ["user_input", "cancelled", "not_resumable", false],
  ["command", "pending", "live", false],
  ["command", "expired", "not_resumable", false],
  ["command", "cancelled", "not_resumable", false],
  ["user_input", "resolved", "live", true],
  ["command", "cancelled", "live", true],
  ["user_input", "pending", "message", true],
  ["dynamic_tool_call", "pending", "live", true],
  ["auth_refresh", "pending", "live", true],
] as const)(
  "respects a %s request that is %s with %s response capability across restart",
  ([kind, status, capability, shouldContinue]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("request:restart"),
            nodeId: NodeId.make("node:restart-question"),
            providerTurnId: base.providerTurns[0]!.id,
            kind,
            status,
            responseCapability:
              capability === "live"
                ? { type: capability, providerSessionId: sessionId }
                : capability === "not_resumable"
                  ? {
                      type: capability,
                      reason: "The server restarted before this runtime request was resolved.",
                    }
                  : { type: capability },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      assert.equal(restartContinuationRun(projection, testNow) !== undefined, shouldContinue);
      const dispatch = [] as Array<unknown>;
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  ...projection,
                  runs: [{ ...projection.runs[0]!, status: "cancelled" as const }],
                }),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                dispatch.push(command);
                return Effect.succeed({} as never);
              },
            }),
          ),
        ),
      );
      assert.lengthOf(dispatch, shouldContinue ? 1 : 0);
    }),
);

it.effect.each(["failed", "interrupted", "rolled_back"] as const)(
  "never revives a %s run with saved pending steering",
  (status) =>
    Effect.gen(function* () {
      const source = {
        ...cutMidTurn({
          status,
          restartPendingMessageIds: [MessageId.make("message:user")],
        }),
        messages: [
          {
            id: MessageId.make("message:user"),
            text: "Undelivered steering.",
            attachments: [],
          } as never,
        ],
      };
      assert.deepEqual(yield* continuationTexts(source), []);
    }),
);

it.effect.each(["pending", "cancelled"] as const)(
  "rebinds OpenCode's %s question after restart",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const opencode = ProviderDriverKind.make("opencode");
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status: "waiting" }],
        providerThreads: [
          {
            ...base.providerThreads[0]!,
            driver: opencode,
            nativeThreadRef: { driver: opencode, nativeId: "native", strength: "strong" },
          },
        ],
        providerSessions: [{ ...base.providerSessions[0]!, driver: opencode }],
        providerTurns: [
          {
            ...base.providerTurns[0]!,
            nativeTurnRef: { driver: opencode, nativeId: "msg_question", strength: "weak" },
          },
        ],
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("request:opencode"),
            nodeId: NodeId.make("question-node"),
            providerTurnId: base.providerTurns[0]!.id,
            nativeRequestRef: { driver: opencode, nativeId: "que_question", strength: "strong" },
            kind: "user_input",
            status,
            responseCapability:
              status === "pending"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "not_resumable", reason: "server restart" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      assert.equal(restartContinuationRun(projection, testNow)?.id, runId);
      const dispatched: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  ...projection,
                  runs: [{ ...projection.runs[0]!, status: "cancelled" as const }],
                  providerTurns: [
                    { ...projection.providerTurns[0]!, status: "cancelled" as const },
                  ],
                }),
              dispatch: (command) => {
                dispatched.push(command);
                return Effect.succeed({} as never);
              },
              recoverDelegatedTask: () => Effect.void,
            }),
          ),
        ),
      );
      assert.lengthOf(dispatched, 1);
      const withOtherRequest = {
        ...projection,
        runtimeRequests: [
          ...projection.runtimeRequests,
          {
            ...projection.runtimeRequests[0]!,
            id: RuntimeRequestId.make("other-provider-request"),
            status: "pending" as const,
            nativeRequestRef: { driver, nativeId: "other", strength: "strong" as const },
          },
        ],
      };
      assert.isUndefined(restartContinuationRun(withOtherRequest, testNow));
    }),
);

it("continues a live turn whose session the adapter never marked running", () => {
  const projection = makeProjection();
  // Codex, Claude, Cursor and ACP sessions stay "ready" for their whole life.
  const withSessionStatus = (status: string) =>
    ({
      ...projection,
      providerSessions: [{ ...projection.providerSessions[0]!, status }],
    }) as OrchestrationV2ThreadProjection;
  for (const status of ["starting", "ready", "running", "waiting"])
    assert.equal(restartContinuationRun(withSessionStatus(status), testNow)?.id, runId, status);
  for (const status of ["stopped", "error"])
    assert.isUndefined(restartContinuationRun(withSessionStatus(status), testNow), status);
});

it("recovers an admitted continuation after another crash before provider start", () => {
  const projection = makeProjection();
  const starting = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "starting" as const,
        restartContinuationOfRunId: RunId.make("run:previous-crash"),
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  assert.equal(restartContinuationRun(starting, testNow)?.id, runId);
});

it("recovers an accepted steering restart before the replacement turn starts", () => {
  const projection = makeProjection();
  const starting = {
    ...projection,
    runs: [{ ...projection.runs[0]!, status: "starting" as const }],
    attempts: [{ id: attemptId, runId, reason: "steering_restart" }],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.equal(restartContinuationRun(starting, testNow)?.id, runId);
});

it("does not continue settled root runs with restart-cancelled background work", () => {
  const projection = makeProjection();
  const settled = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "completed" as const,
        restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  for (const projectId of [scratchProjectId, projection.thread.projectId])
    for (const status of ["completed", "waiting"] as const)
      assert.isUndefined(
        restartContinuationRun(
          {
            ...settled,
            thread: { ...settled.thread, projectId },
            runs: [{ ...settled.runs[0]!, status }],
          },
          testNow,
        ),
      );
});

it.effect.each(["completed", "waiting", "cancelled"] as const)(
  "ignores a pending restart continuation for a %s run whose provider turn settled",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const work = [{ kind: "shell" as const, label: "sleep 25 && echo DONE" }];
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status, restartCancelledBackgroundWork: work }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(projection),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                commands.push(command);
                return Effect.succeed({} as never);
              },
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.lengthOf(commands, 0);
    }),
);

it.effect("does not continue a failed run that lost background work", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const projection = {
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "failed",
          restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
        },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "failed" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    assert.lengthOf(commands, 0);
  }),
);

it.effect.each([
  [false, undefined],
  [true, undefined],
  [false, true],
  [true, false],
] as const)(
  "atomically records restart intent with cancellation when opt-in is %s and project override is %s",
  ([enabled, projectOverride]) =>
    Effect.gen(function* () {
      let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              continueThreadsAfterServerUpdate: enabled,
              projectSettingsOverrides:
                projectOverride === undefined
                  ? {}
                  : {
                      [ProjectId.make("restart-project")]: {
                        continueThreadsAfterServerUpdate: projectOverride,
                      },
                    },
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(makeProjection()),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) => {
                committed = input;
                return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
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
      yield* recovery.reconcile("startup");
      assert.isDefined(committed);
      assert.isTrue(
        committed!.events.some(
          (event) => event.type === "run.updated" && event.payload.status === "cancelled",
        ),
      );
      assert.lengthOf(committed!.effects, (projectOverride ?? enabled) ? 1 : 0);
      if (projectOverride ?? enabled)
        assert.deepEqual(committed!.effects[0]?.request, {
          type: "provider-runtime.continue",
          sourceRunId: runId,
        });
    }),
);

it.effect("does not duplicate delivery and yields to newer user work or opt-out", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    projection = { ...projection, runs: [{ ...projection.runs[0]!, status: "cancelled" }] };
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(projection),
      recoverDelegatedTask: () => Effect.void,
      dispatch: (command) => {
        commands.push(command);
        if (command.type === "message.dispatch")
          projection = { ...projection, messages: [{ id: command.messageId } as never] };
        return Effect.succeed({} as never);
      },
    });
    const layerEnabled = Layer.merge(
      layerThreads,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    assert.match(String(commands[0]!.commandId), /run:restart$/);
    if (commands[0]!.type === "message.dispatch")
      assert.equal(commands[0]!.restartContinuationOfRunId, runId);
    projection = {
      ...projection,
      messages: [],
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          id: RunId.make("run:user-newer"),
          ordinal: 2,
          status: "completed",
        },
      ],
    };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    projection = { ...projection, runs: [projection.runs[0]!] };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          layerThreads,
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
        ),
      ),
    );
    assert.lengthOf(commands, 1);
  }),
);

it.effect("prepares no continuation for background work another provider thread launched", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const claudeThreadId = ProviderThreadId.make("provider-thread:claude");
    // A Claude turn left a background subagent open, then the thread switched
    // to Codex and its turn settled. Recovery would cancel Claude's work.
    const projection = {
      ...base,
      runs: [{ ...base.runs[0]!, status: "completed" }],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      turnItems: [
        {
          id: "turn-item:claude-subagent",
          runId: RunId.make("run:claude"),
          providerThreadId: claudeThreadId,
          type: "subagent",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.lengthOf(writes, 0);
    // Work on the settled run's own provider thread must not wake it either.
    const ownWork = {
      ...projection,
      turnItems: [{ ...projection.turnItems[0]!, providerThreadId }],
    } as OrchestrationV2ThreadProjection;
    const ownRecovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(ownWork),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* ownRecovery.prepareForShutdown;
    assert.lengthOf(writes, 0);
  }),
);

it.effect.each([
  ["completed", scratchProjectId],
  ["completed", ProjectId.make("restart-project")],
  ["waiting", scratchProjectId],
  ["waiting", ProjectId.make("restart-project")],
] as const)(
  "cleans up background work without waking a %s run in project %s",
  ([status, projectId]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        thread: { ...base.thread, projectId },
        runs: [{ ...base.runs[0]!, status }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
        turnItems: [
          {
            id: "turn-item:background-subagent",
            runId,
            nodeId: null,
            providerThreadId,
            providerInstanceId: instanceId,
            type: "subagent",
            subagentId: "subagent:background",
            title: "Background reviewer",
            status: "running",
          },
        ],
        subagents: [
          {
            id: "subagent:background",
            runId,
            origin: "provider_native",
            driver,
            providerInstanceId: instanceId,
            status: "running",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      for (const trigger of ["startup", "shutdown"] as const) {
        const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
        const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
        const recovery = yield* ProviderRuntimeRecovery.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                writeWithEffects: (input) =>
                  Effect.sync(() => {
                    writes.push(input);
                    return [];
                  }),
                commitCommand: (input) =>
                  Effect.sync(() => {
                    commits.push(input);
                    return { committed: true, cancelledEffectCount: 0 } as never;
                  }),
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
              }),
            ),
          ),
        );
        if (trigger === "shutdown") yield* recovery.prepareForShutdown;
        yield* recovery.reconcile(trigger);
        assert.lengthOf(writes, 0);
        assert.lengthOf(commits, 1);
        assert.lengthOf(commits[0]!.effects, 0);
        const events = commits[0]!.events;
        for (const type of ["turn-item.updated", "subagent.updated"] as const)
          assert.isTrue(
            events.some((event) => event.type === type && event.payload.status === "cancelled"),
          );
        const note = events.find((event) => event.type === "run.background-work-cancelled");
        assert.equal(note?.runId, runId);
        assert.deepEqual(note?.payload.restartCancelledBackgroundWork, [
          { kind: "subagent", label: "Background reviewer", id: "turn-item:background-subagent" },
        ]);
        if (status === "completed")
          assert.isFalse(events.some((event) => event.type === "run.updated"));
      }
    }),
);

it.effect("does not cancel or resume a run that completes while shutdown intent commits", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.sync(() => projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                assert.lengthOf(input.events, 0);
                assert.equal(input.effects[0]?.request.type, "provider-runtime.continue");
                projection = {
                  ...projection,
                  runs: [{ ...projection.runs[0]!, status: "completed" }],
                };
                return [];
              }),
            commitCommand: (input) =>
              Effect.sync(() => {
                commits.push(input);
                return { committed: true, cancelledEffectCount: 0 } as never;
              }),
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
    yield* recovery.prepareForShutdown;
    yield* recovery.reconcile("shutdown");
    assert.isFalse(
      commits.some((commit) => commit.events.some((event) => event.type === "run.updated")),
    );
    let dispatched = false;
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: () =>
              Effect.sync(() => {
                dispatched = true;
                return {} as never;
              }),
          }),
        ),
      ),
    );
    assert.isFalse(dispatched);
  }),
);

const continuationDispatches = (projection: OrchestrationV2ThreadProjection) =>
  Effect.gen(function* () {
    const dispatches: Array<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              if (command.type === "message.dispatch") dispatches.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    return dispatches;
  });

const continuationTexts = (projection: OrchestrationV2ThreadProjection) =>
  continuationDispatches(projection).pipe(
    Effect.map((dispatches) => dispatches.map((command) => command.text)),
  );

const cutMidTurn = (extra: Record<string, unknown> = {}) => {
  const base = makeProjection();
  return {
    ...base,
    runs: [
      {
        ...base.runs[0]!,
        status: "cancelled",
        userMessageId: MessageId.make("message:user"),
        ...extra,
      },
    ],
    providerTurns: [{ ...base.providerTurns[0]!, status: "cancelled" }],
  } as unknown as OrchestrationV2ThreadProjection;
};

it.effect(
  "delivers the replacement prompt when a steering restart never reached the provider",
  () =>
    Effect.gen(function* () {
      const projection = {
        ...cutMidTurn(),
        attempts: [{ id: attemptId, runId, reason: "steering_restart" }],
        providerTurns: [],
        messages: [
          {
            id: MessageId.make("message:user"),
            text: "Restart the review with the updated requirements.",
            attachments: [],
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      assert.deepEqual(yield* continuationTexts(projection), [projection.messages[0]!.text]);
    }),
);

it.effect.each(["interval", "fixed_time", "webhook"] as const)(
  "keeps %s task attribution through repeated restart continuations",
  (trigger) =>
    Effect.gen(function* () {
      const scheduledTaskId = ScheduledTaskId.make(`scheduled-task:${trigger}`);
      const originalMessage = {
        id: MessageId.make("message:user"),
        scheduledTaskId,
        text: trigger === "webhook" ? 'Handle {"action":"opened","number":7}.' : "Run the audit.",
        attachments: [],
      };
      const base = cutMidTurn();
      const messages = [originalMessage];
      const runs = [...base.runs];
      const projection = {
        ...base,
        messages,
        runs,
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      const dependencies = Layer.merge(
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          recoverDelegatedTask: () => Effect.void,
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({} as never);
          },
        }),
      );
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        const source = projection.runs.at(-1)!;
        yield* continueRestartedRun({ threadId, sourceRunId: source.id }).pipe(
          Effect.provide(dependencies),
        );
        const command = commands.at(-1)!;
        assert.equal(command.type, "message.dispatch");
        if (command.type !== "message.dispatch") return;
        assert.equal(command.scheduledTaskId, scheduledTaskId);
        assert.equal(command.threadId, threadId);
        assert.equal(command.restartContinuationOfRunId, source.id);
        assert.equal(command.text, "Continue where you left off.");
        messages.push({
          id: command.messageId,
          text: command.text,
          scheduledTaskId: command.scheduledTaskId,
          attachments: [],
        } as never);
        runs.push({
          ...source,
          id: RunId.make(`run:continuation:${ordinal}`),
          ordinal: ordinal + 1,
          userMessageId: command.messageId,
          restartContinuationOfRunId: source.id,
        });
      }
      assert.lengthOf(commands, 2);
      assert.equal(projection.messages[0]?.text, originalMessage.text);
    }),
);

it.effect("stops continuing after three automatic restart continuations in a row", () =>
  Effect.gen(function* () {
    const first = RunId.make("run:first-continuation");
    const second = RunId.make("run:second-continuation");
    const cut = cutMidTurn({ restartContinuationOfRunId: second });
    const withTwoLinks = {
      ...cut,
      runs: [
        ...cut.runs,
        { ...cut.runs[0]!, id: second, restartContinuationOfRunId: first },
        { ...cut.runs[0]!, id: first, restartContinuationOfRunId: undefined },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.lengthOf(yield* continuationTexts(withTwoLinks), 1);

    const withThreeLinks = {
      ...withTwoLinks,
      runs: withTwoLinks.runs.map((run) =>
        run.id === first ? { ...run, restartContinuationOfRunId: RunId.make("run:root") } : run,
      ),
    } as unknown as OrchestrationV2ThreadProjection;
    assert.lengthOf(yield* continuationTexts(withThreeLinks), 0);
  }),
);

it.effect.each([0, 1, 2, 3])(
  "counts only %s automatic continuations after a human steering restart",
  (automaticCount) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      const chain = Array.from({ length: automaticCount + 4 }, (_, index) => ({
        ...cut.runs[0]!,
        id: index === 0 ? runId : RunId.make(`run:steered-chain:${index}`),
        activeAttemptId: RunAttemptId.make(`attempt:steered-chain:${index}`),
        rootNodeId: NodeId.make(`node:steered-chain:${index}`),
        restartContinuationOfRunId: RunId.make(`run:steered-chain:${index + 1}`),
      }));
      const steered = chain[automaticCount]!;
      assert.lengthOf(
        yield* continuationTexts({
          ...cut,
          runs: chain,
          providerTurns: [{ ...cut.providerTurns[0]!, runAttemptId: chain[0]!.activeAttemptId }],
          attempts: [
            {
              id: steered.activeAttemptId!,
              runId: steered.id,
              attemptOrdinal: 1,
              rootNodeId: steered.rootNodeId!,
              providerInstanceId: instanceId,
              providerThreadId,
              providerTurnId: null,
              reason: "steering_restart",
              status: "cancelled",
              startedAt: testNow,
              completedAt: testNow,
            },
          ],
        }),
        automaticCount < 3 ? 1 : 0,
      );
    }),
);

const queuedFollowUp = {
  id: RunId.make("run:queued"),
  ordinal: 2,
  providerInstanceId: instanceId,
  providerThreadId,
  status: "queued",
  queueHeld: true,
};

it.effect("continues a cut run past queued follow-ups, which stay held", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    assert.equal(
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, queuedFollowUp],
        } as unknown as OrchestrationV2ThreadProjection,
        testNow,
      )?.id,
      runId,
    );
    const cut = cutMidTurn();
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, queuedFollowUp],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, ["Continue where you left off."]);
  }),
);

it.effect.each([
  ["startup", true, false, false],
  ["shutdown", true, false, false],
  ["startup", false, false, false],
  ["shutdown", false, false, false],
  ["startup", true, true, false],
  ["startup", true, false, true],
] as const)(
  "preserves a queued worktree continuation through %s when enabled is %s, held is %s, extra queue is %s",
  ([trigger, enabled, alreadyHeld, extraQueue]) =>
    Effect.gen(function* () {
      const projection = {
        ...makeProjection(),
        thread: { ...makeProjection().thread, worktreePath: "/tmp/handoff-worktree" },
        runs: [
          {
            ...queuedFollowUp,
            queueHeld: alreadyHeld,
            userMessageId: MessageId.make("message:mcp:credential:worktree-continuation:request"),
          },
          ...(extraQueue ? [{ ...queuedFollowUp, id: RunId.make("run:other-queued") }] : []),
        ],
        providerThreads: [],
        providerSessions: [],
        providerTurns: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const events: Array<
        Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]["events"][number]
      > = [];
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: enabled }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeWithEffects: (input) => {
                effects.push(...input.effects);
                return Effect.succeed([]);
              },
              commitCommand: (input) => {
                events.push(...input.events);
                effects.push(...input.effects);
                return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              cancelUnsettled: () => Effect.succeed([]),
              signalCancellations: () => Effect.void,
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile(trigger);
      const held =
        alreadyHeld ||
        events.some(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queuedFollowUp.id &&
            event.payload.queueHeld === true,
        );
      assert.equal(held, !enabled || alreadyHeld);
      assert.lengthOf(effects, trigger === "startup" && enabled && !alreadyHeld ? 1 : 0);
      if (effects.length > 0) assert.equal(effects[0]!.request.type, "provider-runtime.continue");
    }),
);

it.effect("delivers a queued handoff prompt once and respects cancellation before delivery", () =>
  Effect.gen(function* () {
    const message = {
      id: MessageId.make("message:mcp:credential:worktree-continuation:request"),
      text: "Keep fixing the login bug in the worktree.",
      attachments: [],
    };
    const base = cutMidTurn();
    const projection = {
      ...base,
      thread: { ...base.thread, worktreePath: "/tmp/handoff-worktree" },
      runs: [
        { ...base.runs[0]!, id: RunId.make("run:before-handoff"), ordinal: 1 },
        { ...queuedFollowUp, id: runId, userMessageId: message.id, queueHeld: false },
      ],
      messages: [message],
      providerTurns: [],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.deepEqual(yield* continuationTexts(projection), [message.text]);
    assert.deepEqual(
      yield* continuationTexts({
        ...projection,
        runs: [
          ...projection.runs,
          { ...queuedFollowUp, id: RunId.make("run:mixed-queue"), queueHeld: true },
        ],
      } as OrchestrationV2ThreadProjection),
      [message.text],
    );
    for (const status of ["queued", "cancelled"] as const) {
      assert.deepEqual(
        yield* continuationTexts({
          ...projection,
          runs: projection.runs.map((run) =>
            run.id === runId ? { ...run, status, queueHeld: true } : run,
          ),
        }),
        [],
      );
    }
  }),
);

it.effect("continues a resumed queued run that ran after an earlier continuation", () =>
  Effect.gen(function* () {
    // The continuation (ordinal 3) ran ahead of the held queue, then the user
    // resumed the queued run (ordinal 1 here) and the server restarted again.
    const finishedContinuation = {
      id: RunId.make("run:earlier-continuation"),
      ordinal: 3,
      providerInstanceId: instanceId,
      providerThreadId,
      status: "completed",
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    };
    const live = makeProjection();
    assert.equal(
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, finishedContinuation],
        } as unknown as OrchestrationV2ThreadProjection,
        testNow,
      )?.id,
      runId,
    );
    const cut = cutMidTurn({ completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z") });
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, finishedContinuation],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, ["Continue where you left off."]);
  }),
);

it.effect("does not continue a run the user asked to stop before the restart", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      turnItems: [{ id: "turn-item:interrupt", runId, type: "run_interrupt_request" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, []);
  }),
);

it.effect("does not continue a cut /compact or /logout turn", () =>
  Effect.gen(function* () {
    for (const text of ["/compact", " /LOGOUT "]) {
      const texts = yield* continuationTexts({
        ...cutMidTurn(),
        messages: [{ id: MessageId.make("message:user"), text, attachments: [] }],
      } as unknown as OrchestrationV2ThreadProjection);
      assert.deepEqual(texts, [], text);
    }
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      messages: [{ id: MessageId.make("message:user"), text: "/compact later", attachments: [] }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(texts, 1);
  }),
);

it.effect("tells a turn cut mid-way about the background work it lost", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts(
      cutMidTurn({
        restartCancelledBackgroundWork: [{ kind: "subagent", label: "Background reviewer" }],
      }),
    );
    assert.lengthOf(texts, 1);
    assert.include(texts[0]!, "Background reviewer");
    assert.isTrue(texts[0]!.endsWith("Continue where you left off."));
  }),
);

it.effect("shows a continuation as a T3 Code notice whose detail is the prompt", () =>
  Effect.gen(function* () {
    const [resumed] = yield* continuationDispatches(cutMidTurn());
    assert.deepEqual(resumed?.notification, {
      source: { kind: "system" },
      outcome: "updated",
      summary: "T3 Code restarted and resumed this turn",
      detail: "Continue where you left off.",
    });
  }),
);

it.effect(
  "carries the note forward when its continuation was cut before reaching the provider",
  () =>
    Effect.gen(function* () {
      const base = makeProjection();
      const original = {
        ...base.runs[0]!,
        id: RunId.make("run:original"),
        status: "completed",
        activeAttemptId: RunAttemptId.make("attempt:original"),
        restartCancelledBackgroundWork: [{ kind: "shell", label: "sleep 25 && echo DONE" }],
      };
      const projection = {
        ...base,
        runs: [
          original,
          {
            ...base.runs[0]!,
            ordinal: 2,
            status: "cancelled",
            restartContinuationOfRunId: original.id,
          },
        ],
        // The original turn settled; the continuation's attempt never started one.
        providerTurns: [
          {
            ...base.providerTurns[0]!,
            runAttemptId: original.activeAttemptId,
            status: "completed",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const texts = yield* continuationTexts(projection);
      assert.lengthOf(texts, 1);
      assert.include(texts[0]!, "sleep 25 && echo DONE");
      assert.notInclude(texts[0]!, "Continue where");
    }),
);

it.effect("prepares later threads' continuations when one thread fails", () =>
  Effect.gen(function* () {
    const brokenThreadId = ThreadId.make("thread:broken");
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([brokenThreadId, threadId]),
            getRuntimeRecoveryProjection: (id) =>
              id === brokenThreadId
                ? Effect.fail(
                    new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                  )
                : Effect.succeed(makeProjection()),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.deepEqual(
      writes.map((write) => write.effects[0]?.request),
      [{ type: "provider-runtime.continue", sourceRunId: runId }],
    );
  }),
);

it.effect.each(["snoozed", "settled"] as const)(
  "does not wake a %s thread after a restart",
  (state) =>
    Effect.gen(function* () {
      const live = makeProjection();
      const thread = {
        ...live.thread,
        ...(state === "snoozed"
          ? { snoozedUntil: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z") }
          : { settledOverride: "settled" as const }),
      };
      assert.isUndefined(restartContinuationRun({ ...live, thread }, testNow));
      assert.deepEqual(yield* continuationTexts({ ...cutMidTurn(), thread }), []);
    }),
);

it.effect("continues a thread whose snooze already elapsed", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    const thread = {
      ...live.thread,
      snoozedUntil: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    };
    assert.equal(restartContinuationRun({ ...live, thread }, testNow)?.id, runId);
    yield* TestClock.setTime(DateTime.toEpochMillis(testNow));
    assert.lengthOf(yield* continuationTexts({ ...cutMidTurn(), thread }), 1);
  }),
);

it.effect.each(["pending", "cancelled"] as const)(
  "does not continue a run whose secret request is %s at shutdown",
  (secretStatus) =>
    Effect.gen(function* () {
      const completedAt = DateTime.makeUnsafe("2026-10-03T10:05:00.000Z");
      const cut = cutMidTurn({ completedAt });
      const projection = {
        ...cut,
        turnItems: [{ type: "secret_request", runId, secretStatus, completedAt } as never],
      };
      if (secretStatus === "pending")
        assert.isUndefined(
          restartContinuationRun({ ...makeProjection(), turnItems: projection.turnItems }, testNow),
        );
      assert.deepEqual(yield* continuationTexts(projection), []);
    }),
);

it.effect("continues when an earlier attempt's question and secret were cancelled", () =>
  Effect.gen(function* () {
    const completedAt = DateTime.makeUnsafe("2026-10-03T10:05:00.000Z");
    const cut = cutMidTurn({ completedAt });
    const earlierTurn = {
      ...cut.providerTurns[0]!,
      id: ProviderTurnId.make("turn:earlier-question"),
      runAttemptId: RunAttemptId.make("attempt:earlier-question"),
    };
    const projection = {
      ...cut,
      providerTurns: [...cut.providerTurns, earlierTurn],
      runtimeRequests: [
        {
          kind: "user_input",
          status: "expired",
          providerTurnId: earlierTurn.id,
          responseCapability: { type: "not_resumable", reason: "The server restarted." },
        } as never,
      ],
      turnItems: [
        {
          type: "secret_request",
          runId,
          secretStatus: "cancelled",
          completedAt: DateTime.subtract(completedAt, { seconds: 1 }),
        } as never,
        {
          type: "secret_request",
          runId: RunId.make("run:earlier-secret"),
          secretStatus: "pending",
          completedAt: null,
        } as never,
      ],
    };
    assert.lengthOf(yield* continuationTexts(projection), 1);
  }),
);

it.effect.each(["completed", "failed", "interrupted"] as const)(
  "does not continue when the provider turn %s before the app run settled",
  (status) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      assert.deepEqual(
        yield* continuationTexts({
          ...cut,
          providerTurns: [{ ...cut.providerTurns[0]!, status }],
        }),
        [],
      );
    }),
);

it.effect("continues a cut goal turn after an earlier phase of the attempt completed", () =>
  Effect.gen(function* () {
    const cut = cutMidTurn();
    assert.lengthOf(
      yield* continuationTexts({
        ...cut,
        providerTurns: [
          { ...cut.providerTurns[0]!, ordinal: 1, status: "completed" },
          {
            ...cut.providerTurns[0]!,
            id: ProviderTurnId.make("turn:goal-later"),
            ordinal: 2,
          },
        ],
      }),
      1,
    );
  }),
);

it.effect.each(["settled", "running", "stopped"] as const)(
  "preserves startup session liveness after a shared-session %s thread is recovered",
  (firstStatus) =>
    Effect.gen(function* () {
      const secondThreadId = ThreadId.make("thread:restart-second");
      const secondRunId = RunId.make("run:restart-second");
      const base = makeProjection();
      let session = {
        ...base.providerSessions[0]!,
        status: firstStatus === "stopped" ? "stopped" : "ready",
      } as OrchestrationV2ThreadProjection["providerSessions"][number];
      const writes: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId, secondThreadId]),
              getRuntimeRecoveryProjection: (id) => {
                const second = id === secondThreadId;
                const settled = !second && firstStatus === "settled";
                return Effect.succeed({
                  ...base,
                  thread: { ...base.thread, id },
                  runs: [
                    {
                      ...base.runs[0]!,
                      id: second ? secondRunId : runId,
                      status: settled ? "completed" : "running",
                    },
                  ],
                  providerThreads: [
                    {
                      ...base.providerThreads[0]!,
                      appThreadId: id,
                      status: settled ? "idle" : "active",
                    },
                  ],
                  providerSessions: [session],
                  providerTurns: [
                    { ...base.providerTurns[0]!, status: settled ? "completed" : "running" },
                  ],
                } as OrchestrationV2ThreadProjection);
              },
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) => {
                writes.push(input);
                for (const event of input.events) {
                  if (event.type === "provider-session.updated") session = event.payload;
                }
                return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile("startup");
      const sources = writes
        .flatMap((write) => write.effects ?? [])
        .flatMap((effect) =>
          effect.request.type === "provider-runtime.continue" ? [effect.request.sourceRunId] : [],
        );
      assert.deepEqual(
        sources,
        firstStatus === "stopped"
          ? []
          : firstStatus === "running"
            ? [runId, secondRunId]
            : [secondRunId],
      );
      assert.lengthOf(
        writes
          .flatMap((write) => write.events)
          .filter((event) => event.type === "provider-session.updated"),
        firstStatus === "stopped" ? 0 : 1,
      );
    }),
);

it.effect.each(["cancelled", "completed"] as const)(
  "delivers pending native steering after a %s turn with attachments and context",
  (status) =>
    Effect.gen(function* () {
      const base = cutMidTurn();
      const messageId = MessageId.make("message:pending-steer");
      const attachment = {
        type: "file" as const,
        id: "file_steer",
        name: "steering.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
      };
      const context = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            contextId: ComposerContextId.make("ctx_steer"),
            kind: "file" as const,
            label: "steering.txt",
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      };
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status, restartPendingMessageIds: [messageId] }],
        messages: [
          {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user" as const,
            text: "Use the steering input.",
            attachments: [attachment],
            context,
            createdBy: "user" as const,
            creationSource: "web" as const,
            streaming: false,
            createdAt: testNow,
            updatedAt: testNow,
          },
        ],
      } as OrchestrationV2ThreadProjection;
      const commands = yield* continuationDispatches(projection);
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.equal(command.text, "Use the steering input.");
      assert.deepEqual(command.attachments, [attachment]);
      assert.deepEqual(command.context, context);
      const earlierId = MessageId.make("message:earlier-steer");
      const earlierRunId = RunId.make("run:earlier-steer");
      assert.deepEqual(
        yield* continuationTexts({
          ...projection,
          runs: [
            {
              ...projection.runs[0]!,
              id: earlierRunId,
              ordinal: 0,
              restartPendingMessageIds: [earlierId],
            },
            { ...projection.runs[0]!, restartContinuationOfRunId: earlierRunId },
          ],
          messages: [
            { ...projection.messages[0]!, id: earlierId, text: "Earlier input." },
            ...projection.messages,
          ],
        }),
        ["Earlier input.\n\nUse the steering input."],
      );
      for (const turnStatus of ["failed", "interrupted"] as const) {
        assert.deepEqual(
          yield* continuationTexts({
            ...projection,
            providerTurns: projection.providerTurns.map((turn) => ({
              ...turn,
              status: turnStatus,
            })),
          }),
          [],
        );
      }
    }),
);

it.effect("prepares pending native steering on a settled run before graceful shutdown", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const messageId = MessageId.make("message:shutdown-pending-steer");
    const projection = {
      ...base,
      runs: [{ ...base.runs[0]!, status: "completed" }],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      pendingSteering: [{ runId, messageId }],
    } as unknown as ProjectionStore.ProjectionRuntimeRecoveryState;
    const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
    const events: Array<
      Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]["events"][number]
    > = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) => {
              effects.push(...input.effects);
              return Effect.succeed([]);
            },
            commitCommand: (input) => {
              events.push(...input.events);
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            signalCancellations: () => Effect.void,
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.lengthOf(effects, 1);
    yield* recovery.reconcile("shutdown");
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "run.updated" &&
          event.payload.restartPendingMessageIds?.includes(messageId),
      ),
    );
  }),
);

it.effect.each(["expired", "cancelled"] as const)(
  "continues a later goal phase after an earlier phase's request was %s",
  (status) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      const earlier = { ...cut.providerTurns[0]!, ordinal: 1, status: "completed" as const };
      const current = {
        ...earlier,
        id: ProviderTurnId.make("turn:goal-current"),
        ordinal: 2,
        status: "cancelled" as const,
      };
      assert.lengthOf(
        yield* continuationTexts({
          ...cut,
          providerTurns: [earlier, current],
          runtimeRequests: [
            {
              kind: "user_input",
              status,
              providerTurnId: earlier.id,
              responseCapability: { type: "not_resumable", reason: "Earlier phase ended." },
            } as never,
          ],
        }),
        1,
      );
    }),
);

it.effect.each(["saved", "declined"] as const)(
  "continues after a secret was explicitly %s",
  (secretStatus) =>
    Effect.gen(function* () {
      assert.lengthOf(
        yield* continuationTexts({
          ...cutMidTurn(),
          turnItems: [{ type: "secret_request", runId, secretStatus } as never],
        }),
        1,
      );
    }),
);

it.effect.each(["dynamic_tool_call", "auth_refresh"] as const)(
  "continues after recovery expired a %s callback",
  (kind) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      assert.lengthOf(
        yield* continuationTexts({
          ...cut,
          runtimeRequests: [
            {
              kind,
              status: "expired",
              providerTurnId: cut.providerTurns[0]!.id,
              responseCapability: { type: "not_resumable", reason: "Process lost." },
            } as never,
          ],
        }),
        1,
      );
    }),
);

it.effect.each(["environment", "project"] as const)(
  "reads the %s setting fresh for shutdown, startup, and delivery",
  (scope) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService.pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
      );
      let projection = makeProjection();
      const intents: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      const layer = Layer.mergeAll(
        Layer.succeed(ServerSettings.ServerSettingsService, settings),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeWithEffects: (input) => {
            intents.push(...input.effects);
            return Effect.succeed([]);
          },
          commitCommand: (input) => {
            intents.push(...input.effects);
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          recoverDelegatedTask: () => Effect.void,
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({} as never);
          },
        }),
      );
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(Effect.provide(layer));
      const setEnabled = (enabled: boolean) =>
        settings.updateSettings(
          scope === "environment"
            ? { continueThreadsAfterServerUpdate: enabled }
            : {
                projectSettingsOverrides: {
                  [projection.thread.projectId]: { continueThreadsAfterServerUpdate: enabled },
                },
              },
        );
      for (const enabled of [false, true, false]) {
        yield* setEnabled(enabled);
        intents.length = 0;
        yield* recovery.prepareForShutdown;
        assert.lengthOf(intents, enabled ? 1 : 0);
        intents.length = 0;
        yield* recovery.reconcile("startup");
        assert.lengthOf(intents, enabled ? 1 : 0);
        projection = cutMidTurn();
        commands.length = 0;
        yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(Effect.provide(layer));
        assert.lengthOf(commands, enabled ? 1 : 0);
        projection = makeProjection();
      }
    }),
);

it.effect.each(["archivedAt", "deletedAt"] as const)(
  "declines an already recorded continuation after %s changes",
  (field) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      assert.deepEqual(
        yield* continuationTexts({ ...cut, thread: { ...cut.thread, [field]: testNow } }),
        [],
      );
    }),
);

it.effect.each([-1, 0, 1])("checks snooze expiry at the current clock boundary (%s ms)", (offset) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(testNow));
    const live = makeProjection();
    const thread = {
      ...live.thread,
      snoozedUntil: DateTime.add(testNow, { milliseconds: offset }),
    };
    assert.equal(restartContinuationRun({ ...live, thread }, testNow) !== undefined, offset <= 0);
    assert.lengthOf(yield* continuationTexts({ ...cutMidTurn(), thread }), offset <= 0 ? 1 : 0);
  }),
);

it.effect.each(["snoozed", "settled", "archived", "deleted", "question"] as const)(
  "holds a queued worktree handoff when the thread is %s during recovery",
  (state) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        thread: {
          ...base.thread,
          worktreePath: "/tmp/handoff-worktree",
          ...(state === "snoozed"
            ? { snoozedUntil: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z") }
            : {}),
          ...(state === "settled" ? { settledOverride: "settled" } : {}),
          ...(state === "archived" ? { archivedAt: testNow } : {}),
          ...(state === "deleted" ? { deletedAt: testNow } : {}),
        },
        runs: [
          {
            ...queuedFollowUp,
            queueHeld: false,
            userMessageId: MessageId.make("message:mcp:session:worktree-continuation:held"),
          },
        ],
        providerThreads: [],
        providerSessions: [],
        providerTurns: [],
        runtimeRequests:
          state === "question"
            ? [
                {
                  nodeId: NodeId.make("question-node"),
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId: sessionId },
                },
              ]
            : [],
      } as unknown as OrchestrationV2ThreadProjection;
      const events: Parameters<
        EventSink.EventSinkV2["Service"]["commitCommand"]
      >[0]["events"][number][] = [];
      const intents: EffectOutbox.PendingOrchestrationEffectV2[] = [];
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeWithEffects: (input) => {
                intents.push(...input.effects);
                return Effect.succeed([]);
              },
              commitCommand: (input) => {
                events.push(...input.events);
                intents.push(...input.effects);
                return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              cancelUnsettled: () => Effect.succeed([]),
              signalCancellations: () => Effect.void,
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile("startup");
      assert.lengthOf(intents, 0);
      assert.isTrue(
        events.some((event) => event.type === "run.updated" && event.payload.queueHeld === true),
      );
    }),
);

it.effect.each(["earlier", "newer"] as const)(
  "uses provider turn order when %s completed work has a skewed wall clock",
  (order) =>
    Effect.gen(function* () {
      const cut = cutMidTurn({ completedAt: DateTime.makeUnsafe("2026-10-03T09:00:00.000Z") });
      const otherAttempt = RunAttemptId.make(`attempt:clock:${order}`);
      const otherRun = {
        ...cut.runs[0]!,
        id: RunId.make(`run:clock:${order}`),
        ordinal: 2,
        status: "completed" as const,
        activeAttemptId: otherAttempt,
        completedAt: DateTime.makeUnsafe(
          order === "earlier" ? "2026-10-03T10:00:00.000Z" : "2026-10-03T08:00:00.000Z",
        ),
      };
      const projection = {
        ...cut,
        runs: [...cut.runs, otherRun],
        providerTurns: [
          { ...cut.providerTurns[0]!, ordinal: 2 },
          {
            ...cut.providerTurns[0]!,
            id: ProviderTurnId.make(`turn:clock:${order}`),
            runAttemptId: otherAttempt,
            ordinal: order === "earlier" ? 1 : 3,
            status: "completed" as const,
          },
        ],
      };
      assert.lengthOf(yield* continuationTexts(projection), order === "earlier" ? 1 : 0);
    }),
);

it.each([false, true])(
  "does not repeat a delivered background note after a backward clock change and steering: %s",
  (steered) => {
    const source = cutMidTurn({
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
      restartCancelledBackgroundWork: [{ kind: "shell", label: "Cancelled command" }],
    });
    const delivered = {
      ...source.runs[0]!,
      id: RunId.make("run:delivered-clock-note"),
      ordinal: 2,
      activeAttemptId: RunAttemptId.make(
        steered ? "attempt:steered-clock-note" : "attempt:delivered-clock-note",
      ),
      status: "completed" as const,
      restartCancelledBackgroundWork: [],
      completedAt: DateTime.makeUnsafe("2026-10-03T09:00:00.000Z"),
    };
    const current = {
      ...delivered,
      id: RunId.make("run:after-clock-note"),
      ordinal: 3,
      activeAttemptId: RunAttemptId.make("attempt:after-clock-note"),
      status: "running" as const,
      completedAt: null,
    };
    assert.deepEqual(
      pendingRestartCancelledBackgroundWork({
        runs: [...source.runs, delivered, current],
        run: current,
        compactionMessageIds: new Set(),
        attempts: [{ id: RunAttemptId.make("attempt:delivered-clock-note"), runId: delivered.id }],
        providerTurns: [
          { ...source.providerTurns[0]!, ordinal: 1 },
          {
            ...source.providerTurns[0]!,
            ordinal: 2,
            runAttemptId: RunAttemptId.make("attempt:delivered-clock-note"),
            status: "completed",
          },
        ],
      }),
      [],
    );
  },
);

it.effect("recovers an unstarted continuation after a second restart with a backward clock", () =>
  Effect.gen(function* () {
    const cut = cutMidTurn({
      ordinal: 2,
      restartContinuationOfRunId: RunId.make("run:clock-ancestor"),
      completedAt: DateTime.makeUnsafe("2026-10-03T09:00:00.000Z"),
    });
    const ancestor = {
      ...cut.runs[0]!,
      id: RunId.make("run:clock-ancestor"),
      ordinal: 1,
      restartContinuationOfRunId: undefined,
      activeAttemptId: RunAttemptId.make("attempt:clock-ancestor"),
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    };
    assert.lengthOf(
      yield* continuationTexts({
        ...cut,
        runs: [...cut.runs, ancestor],
        providerTurns: [
          { ...cut.providerTurns[0]!, ordinal: 1, runAttemptId: ancestor.activeAttemptId },
        ],
      }),
      1,
    );
  }),
);

it("selects a later continuation after its provider settled and the clock moved backward", () => {
  const base = makeProjection();
  const earlier = {
    ...base.runs[0]!,
    status: "completed" as const,
    completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
  };
  const current = {
    ...earlier,
    id: RunId.make("run:backward-pending-steer"),
    ordinal: 2,
    restartContinuationOfRunId: earlier.id,
    restartPendingMessageIds: [MessageId.make("message:backward-pending-steer")],
    activeAttemptId: RunAttemptId.make("attempt:backward-pending-steer"),
    completedAt: DateTime.makeUnsafe("2026-10-03T09:00:00.000Z"),
  };
  assert.equal(
    restartContinuationRun(
      {
        ...base,
        runs: [earlier, current],
        providerTurns: [
          { ...base.providerTurns[0]!, ordinal: 1, status: "completed" },
          {
            ...base.providerTurns[0]!,
            id: ProviderTurnId.make("turn:backward-pending-steer"),
            runAttemptId: current.activeAttemptId,
            ordinal: 2,
            status: "completed",
          },
        ],
      },
      testNow,
    )?.id,
    current.id,
  );
});
