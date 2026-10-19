import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type RunId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { planProjectCommand } from "./ProjectCommands.ts";
import * as ThreadImportService from "./ThreadImportService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { resolveAutoSettlementAt } from "./ThreadSettlementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:import");
const otherProjectId = ProjectId.make("project:other-import");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const request = {
  source: {
    environmentId: EnvironmentId.make("environment:source"),
    threadId: ThreadId.make("thread:source"),
    handoffId: "handoff:one",
  },
  projectId,
  title: "Continue the investigation",
  modelSelection,
  runtimeMode: "approval-required" as const,
  interactionMode: "plan" as const,
  linkOrigin: { sessionId: "session:source", label: "Source environment" },
  messages: [
    {
      role: "user" as const,
      text: "Investigate the login race.",
      createdAt: "2026-10-06T10:00:00.000Z",
    },
    {
      role: "assistant" as const,
      text: "The cookie arrives after the redirect.",
      createdAt: "2026-10-06T10:01:00.000Z",
    },
  ],
  continuationPrompt: "Continue from the earlier finding.",
};

const makeRuntime = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-import-" });
  const turns: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const driver = ProviderDriverKind.make("codex");
  const instanceId = modelSelection.instanceId;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
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
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: threadId, strength: "strong" },
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
              turns.push(turn);
              const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
              yield* PubSub.publishAll(events, [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: { driver, nativeId: turn.attemptId, strength: "strong" },
                    ordinal: turn.providerTurnOrdinal,
                    status: "completed",
                    startedAt: now,
                    completedAt: now,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.die("unexpected steering"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unexpected runtime request"),
          readThreadSnapshot: () => Effect.die("unexpected snapshot"),
          rollbackThread: () => Effect.die("unexpected rollback"),
          forkThread: () => Effect.die("unexpected fork"),
        };
      }),
  };
  const database = SqlitePersistence.layerMemory;
  const replay = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-import", runtimePolicyOverride: { cwd } },
    ProviderAdapterRegistry.layerSingle(adapter),
    { databaseLayer: database, runEffectWorker: false },
  );
  const layer = ThreadManagement.layer.pipe(
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(replay),
  );
  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      for (const id of [projectId, otherProjectId]) {
        const command = {
          type: "project.create" as const,
          commandId: CommandId.make(`create:${id}`),
          projectId: id,
          title: id,
          workspaceRoot: `${cwd}/${id}`,
        };
        yield* sink.commitProjectCommand({
          commandId: command.commandId,
          projectId: id,
          commandType: command.type,
          acceptedAt: now,
          event: Result.getOrThrow(
            planProjectCommand({
              command,
              state: { project: undefined, workspaceOwner: undefined },
              eventId: EventId.make(`created:${id}`),
              now,
            }),
          ),
        });
      }
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layer,
        ProjectStore.layer.pipe(Layer.provide(database)),
        ProjectionStore.layer.pipe(Layer.provide(database)),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      ),
    ),
  );
  return { layer: seeded, turns };
});

const finishRun = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* worker.drain();
  yield* threads.streamStoredEventsFrom({ threadId, eventType: "run.updated" }).pipe(
    Stream.filter(
      ({ event }) =>
        event.type === "run.updated" &&
        event.payload.id === runId &&
        (event.payload.status === "waiting" || event.payload.status === "completed"),
    ),
    Stream.runHead,
  );
  yield* worker.drain();
  return yield* threads.getThreadProjection(threadId);
});

it.effect("seeds the first continuation and replays its original run after later local work", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-19T12:00:00.000Z"));
    const runtime = yield* makeRuntime();
    yield* Effect.gen(function* () {
      const imports = yield* ThreadImportService.ThreadImportService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const first = yield* imports.importThread(request);
      assert.isTrue(first.created);
      assert.equal(first.projectId, projectId);
      assert.isNotNull(first.runId);
      const committed = yield* threads.getThreadProjection(first.threadId);
      assert.isEmpty(runtime.turns);
      assert.deepInclude(committed.thread, {
        historyOrigin: "v1_import",
        linkOrigin: request.linkOrigin,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
      });
      assert.deepEqual(
        committed.messages
          .filter((message) => message.runId === null)
          .map((message) => ({
            role: message.role,
            text: message.text,
            createdAt: DateTime.formatIso(message.createdAt),
          })),
        request.messages,
      );
      assert.equal(committed.turnItems.filter((item) => item.runId === null).length, 2);

      const continued = yield* finishRun(first.threadId, first.runId!);
      assert.equal(continued.contextHandoffs.length, 1);
      assert.equal(runtime.turns.length, 1);
      const turn = runtime.turns[0]!;
      for (const message of request.messages) assert.include(turn.message.text, message.text);
      assert.include(turn.message.text, `User message:\n${request.continuationPrompt}`);
      assert.deepInclude(turn.runtimePolicy, {
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
      });

      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:local-follow-up"),
        threadId: first.threadId,
        messageId: MessageId.make("message:local-follow-up"),
        text: "Now inspect the fix.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const local = yield* threads.getThreadProjection(first.threadId);
      const localRunId = local.runs.at(-1)!.id;
      assert.notEqual(localRunId, first.runId);
      const beforeRetry = yield* finishRun(first.threadId, localRunId);
      const retried = yield* imports.importThread({
        ...request,
        linkOrigin: { sessionId: "session:other", label: "Other environment" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      assert.deepEqual(retried, { ...first, created: false });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.deepEqual(yield* threads.getThreadProjection(first.threadId), beforeRetry);
      assert.equal(runtime.turns.length, 2);

      const importedAt = yield* DateTime.now;
      const distinct = yield* imports.importThread({
        ...request,
        source: { ...request.source, handoffId: "handoff:two" },
        continuationPrompt: undefined,
      });
      assert.isTrue(distinct.created);
      assert.notEqual(distinct.threadId, first.threadId);
      assert.isNull(distinct.runId);
      const idle = yield* threads.getThreadProjection(distinct.threadId);
      assert.isEmpty(idle.runs);
      assert.equal(idle.messages.length, request.messages.length);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.equal(runtime.turns.length, 2);
      assert.deepEqual(
        idle.messages.map((message) => DateTime.formatIso(message.createdAt)),
        request.messages.map((message) => message.createdAt),
      );
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const candidates = yield* projections.getSettlementCandidates(distinct.threadId);
      assert.equal(candidates.length, 1);
      assert.deepEqual(
        {
          activityIsCurrent:
            DateTime.toEpochMillis(idle.thread.updatedAt) >= DateTime.toEpochMillis(importedAt),
          autoSettledAt: resolveAutoSettlementAt({
            thread: candidates[0]!,
            pullRequest: null,
            nowMs: DateTime.toEpochMillis(importedAt),
            autoSettleAfterDays: DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays,
            autoSettleOnMerge: DEFAULT_SERVER_SETTINGS.sidebarAutoSettleOnMerge,
          }),
        },
        { activityIsCurrent: true, autoSettledAt: null },
      );
    }).pipe(
      Effect.provide(
        ThreadImportService.layer.pipe(
          Layer.provideMerge(runtime.layer),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "serializes identical imports and refuses to move their identity to another project",
  () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const writeEntered = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const retryEntered = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const gate = Deferred.succeed(writeEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseWrite)),
        );
        const gatedThreads = {
          ...threads,
          dispatch: (input: Parameters<typeof threads.dispatch>[0]) =>
            input.type === "thread.create"
              ? gate.pipe(Effect.andThen(threads.dispatch(input)))
              : threads.dispatch(input),
        };
        yield* Effect.gen(function* () {
          const imports = yield* ThreadImportService.ThreadImportService;
          const first = yield* imports.importThread(request).pipe(Effect.forkChild);
          yield* Deferred.await(writeEntered);
          const retry = yield* Deferred.succeed(retryEntered, undefined).pipe(
            Effect.andThen(imports.importThread(request)),
            Effect.forkChild,
          );
          yield* Deferred.await(retryEntered);
          yield* Deferred.succeed(releaseWrite, undefined);
          const results = yield* Effect.all([Fiber.join(first), Fiber.join(retry)]);
          assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
          assert.equal(results[0]!.threadId, results[1]!.threadId);
          assert.equal(results[0]!.runId, results[1]!.runId);
          assert.isNotNull(results[0]!.runId);
          const { threadId, runId } = results[0]!;
          const imported = yield* finishRun(threadId, runId!);
          assert.equal(
            (yield* threads.listProjectThreads({ projectId, includeSubagents: false })).length,
            1,
          );
          assert.equal(imported.runs.length, 1);
          assert.equal(imported.messages.filter((message) => message.runId === null).length, 2);
          assert.equal(imported.turnItems.filter((item) => item.runId === null).length, 2);
          assert.equal(
            imported.messages.filter((message) => message.text === request.continuationPrompt)
              .length,
            1,
          );
          assert.equal(runtime.turns.length, 1);

          const mismatch = yield* imports
            .importThread({ ...request, projectId: otherProjectId })
            .pipe(Effect.flip);
          assert.equal(mismatch._tag, "ThreadImportProjectMismatchError");
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          assert.deepEqual(yield* threads.getThreadProjection(threadId), imported);
          assert.isEmpty(
            yield* threads.listProjectThreads({
              projectId: otherProjectId,
              includeSubagents: false,
            }),
          );
          assert.equal(runtime.turns.length, 1);

          yield* threads.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("command:delete-imported-thread"),
            threadId,
          });
          const deletedRetry = yield* imports
            .importThread(request)
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          assert.isNull(yield* threads.getThreadShell(threadId));
          assert.equal(runtime.turns.length, 1);
          assert.equal(deletedRetry?._tag, "ThreadImportDeletedError");
          assert.deepInclude(deletedRetry ?? {}, { threadId });
        }).pipe(
          Effect.provide(
            ThreadImportService.layer.pipe(
              Layer.provide(Layer.succeed(ThreadManagement.ThreadManagementService, gatedThreads)),
              Layer.provide(NodeCrypto.layer),
            ),
          ),
        );
      }).pipe(Effect.provide(runtime.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);
