import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Schema from "effect/Schema";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (["codex", "claudeAgent"] as const).flatMap((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return (["failed", "interrupted", "cancelled"] as const).map((status) => ({
    driver,
    status,
    instanceId,
    modelSelection,
    layer,
  }));
});

it.effect("a persisted fork leaves PR watching with its parent until explicitly opted in", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const sourceThreadId = ThreadId.make("fork-watch-source");
    const targetThreadId = ThreadId.make("fork-watch-target");
    const sourceRunId = RunId.make("fork-watch-source-run");
    const key = { host: "github.com", repository: "example/repo", number: 1 };
    const link = { url: "https://github.com/example/repo/pull/1", source: "agent" as const };

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-watch-create"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-watch-project"),
      title: "Watching source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-watch-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("fork-watch-source-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-parent-start"),
      threadId: sourceThreadId,
      ...key,
      watching: true,
      link,
    });
    const parentBefore = yield* orchestrator.getThreadShell(sourceThreadId);
    const parentWatch = parentBefore?.pullRequests?.[0]?.watch;
    assert.isDefined(parentWatch);
    assert.lengthOf(parentBefore?.pendingBackgroundTasks ?? [], 1);

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-watch-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const fork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isNotNull(fork);
    assert.deepEqual(fork.pullRequests, [
      {
        ...key,
        ...link,
        linkedAt: parentWatch.startedAt,
        snapshot: null,
        stack: null,
      },
    ]);
    assert.deepEqual(fork.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    // A delayed watcher update cannot reinstate the parent's subscription on the fork.
    const stale = yield* orchestrator
      .dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("fork-watch-stale-sync"),
        threadId: targetThreadId,
        ...key,
        startedAt: parentWatch.startedAt,
        watch: parentWatch,
        wake: {
          messageId: MessageId.make("fork-watch-unwanted-wake"),
          text: "A check failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "A check failed",
          },
        },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.deepEqual((yield* orchestrator.getThreadProjection(targetThreadId)).runs, []);

    // Advance virtual time only to distinguish the independent watch's start time.
    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-in"),
      threadId: targetThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchingFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isDefined(watchingFork?.pullRequests?.[0]?.watch);
    assert.notEqual(watchingFork.pullRequests[0].watch.startedAt, parentWatch.startedAt);
    assert.lengthOf(watchingFork.pendingBackgroundTasks ?? [], 1);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-out"),
      threadId: targetThreadId,
      ...key,
      watching: false,
    });
    const stoppedFork = yield* orchestrator.getThreadShell(targetThreadId);
    const [forkLink] = fork.pullRequests ?? [];
    assert.isDefined(forkLink);
    // The fork remembers its own watch, never the parent's, so watching again resumes from it.
    assert.deepEqual(stoppedFork?.pullRequests, [
      { ...forkLink, endedWatch: watchingFork.pullRequests[0].watch },
    ]);
    assert.deepEqual(stoppedFork?.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each(forkCases)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      for (const ordinal of [1, 2]) {
        const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 1 && status === "interrupted" ? attemptId : null,
                status: ordinal === 1 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

const decodeForkInput = Schema.decodeUnknownEffect(
  ThreadToolkit.tools.t3_thread_fork.parametersSchema,
);

const responseForkCases = [
  { ...forkCases[0]!, replyStatus: "completed" as const },
  { ...forkCases[3]!, replyStatus: "completed" as const },
  { ...forkCases[0]!, replyStatus: "interrupted" as const },
  { ...forkCases[0]!, replyStatus: "failed" as const },
];

it.effect.each(responseForkCases)(
  "bounds a $driver fork at a $replyStatus response before a steer",
  ({ driver, instanceId, modelSelection, layer, replyStatus }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("response-source");
      const runId = RunId.make("response-run");
      const providerThreadId = ProviderThreadId.make("response-provider-thread");
      const laterRunId = RunId.make("later-run");
      const cutId = TurnItemId.make("response-cut");
      const projectId = ProjectId.make("response-project");
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make("response-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(now),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Response forks",
          workspaceRoot: "/work/response-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      });

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-response-source"),
        threadId: sourceThreadId,
        projectId,
        title: "Response before steer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const base = {
        threadId: sourceThreadId,
        runId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      const items = [
        {
          ...base,
          id: TurnItemId.make("prompt"),
          ordinal: 1,
          type: "user_message",
          messageId: MessageId.make("prompt"),
          text: "INCLUDED_PROMPT",
          attachments: [],
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
        },
        {
          ...base,
          id: cutId,
          ordinal: 2,
          type: "assistant_message",
          messageId: MessageId.make("cut"),
          text: "INCLUDED_RESPONSE",
          streaming: false,
          status: replyStatus,
        },
        {
          ...base,
          id: TurnItemId.make("steer"),
          ordinal: 3,
          type: "user_message",
          messageId: MessageId.make("steer"),
          text: "EXCLUDED_STEER",
          attachments: [],
          inputIntent: "steer",
          createdBy: "user",
          creationSource: "web",
        },
        {
          ...base,
          id: TurnItemId.make("reply"),
          ordinal: 4,
          type: "assistant_message",
          messageId: MessageId.make("reply"),
          text: "EXCLUDED_REPLY",
          streaming: false,
        },
        {
          ...base,
          id: TurnItemId.make("later-response"),
          runId: laterRunId,
          ordinal: 5,
          type: "assistant_message",
          messageId: MessageId.make("later-response"),
          text: "EXCLUDED_LATER_RUN",
          streaming: false,
        },
      ] satisfies ReadonlyArray<OrchestrationV2TurnItem>;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("response-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      for (const [ordinal, id] of [runId, laterRunId].entries()) {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(id),
              type: "run.created",
              threadId: sourceThreadId,
              runId: id,
              occurredAt: now,
              payload: {
                id,
                threadId: sourceThreadId,
                ordinal: ordinal + 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: MessageId.make(ordinal === 0 ? "prompt" : "later-prompt"),
                rootNodeId: null,
                activeAttemptId: null,
                status:
                  replyStatus === "interrupted" && ordinal === 0 ? "interrupted" : "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
      }
      yield* eventSink.write({
        events: items.map((item) => ({
          id: EventId.make(item.id),
          type: "turn-item.updated" as const,
          threadId: sourceThreadId,
          runId: item.runId,
          occurredAt: now,
          payload: item,
        })),
      });

      const continueFork = (targetThreadId: ThreadId) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`continue-${targetThreadId}`),
          threadId: targetThreadId,
          messageId: MessageId.make(`continue-${targetThreadId}`),
          text: "Continue",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });

      const runEndId = ThreadId.make("whole-run-fork");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-whole-run"),
        sourceThreadId,
        targetThreadId: runEndId,
        sourcePoint: { type: "run", runId },
        createdBy: "user",
        creationSource: "web",
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(runEndId)).visibleTurnItems
          .filter((row) => row.visibility === "inherited")
          .map((row) => row.sourceItemId),
        items.slice(0, 4).map((item) => item.id),
      );

      yield* continueFork(runEndId);
      const wholeRun = yield* orchestrator.getThreadProjection(runEndId);
      assert.include(wholeRun.contextHandoffs[0]?.summaryText ?? "", "EXCLUDED_STEER");
      assert.include(wholeRun.contextHandoffs[0]?.summaryText ?? "", "EXCLUDED_REPLY");

      // Decode the public MCP input before dispatching its point through the real service.
      const forkAt = (turnItemId: TurnItemId, target: string) =>
        Effect.gen(function* () {
          const input = yield* decodeForkInput({
            sourcePoint: { type: "turn_item", runId, turnItemId },
          });
          return yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(target),
            sourceThreadId,
            targetThreadId: ThreadId.make(target),
            sourcePoint: input.sourcePoint,
            createdBy: "user",
            creationSource: "mcp",
          });
        });

      // A valid point must decode, so an invalid item's failure cannot pass on schema rejection.
      yield* decodeForkInput({
        sourcePoint: { type: "turn_item", runId, turnItemId: cutId },
      });
      for (const invalidId of [
        "steer",
        "missing",
        "later-response",
        ...(replyStatus === "failed" ? [cutId] : []),
      ]) {
        const targetId = ThreadId.make(`invalid-${invalidId}`);
        const error = yield* forkAt(TurnItemId.make(invalidId), targetId).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.isNull(yield* orchestrator.getThreadShell(targetId));
      }
      if (replyStatus === "failed") return;

      const targetThreadId = ThreadId.make("response-fork");
      yield* forkAt(cutId, targetThreadId);
      const expectedIds = items.slice(0, 2).map((item) => item.id);
      const inherited = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.deepEqual(
        inherited.visibleTurnItems
          .filter((row) => row.visibility === "inherited")
          .map((row) => row.sourceItemId),
        expectedIds,
      );
      const window = yield* orchestrator.getThreadSnapshotWindow(targetThreadId, { rowLimit: 1 });
      assert.deepEqual(
        window.projection.visibleTurnItems
          .filter((row) => row.visibility === "inherited")
          .map((row) => row.sourceItemId),
        [cutId],
      );
      const olderWindow = yield* orchestrator.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 1,
        anchorItemId: items[0]!.id,
      });
      assert.deepEqual(
        olderWindow.projection.visibleTurnItems
          .filter((row) => row.visibility === "inherited")
          .map((row) => row.sourceItemId),
        [items[0]!.id],
      );
      const page = yield* orchestrator.getTimelinePage(targetThreadId, { limit: 1 });
      assert.deepEqual(
        page.items.map((row) => row.sourceItemId),
        [items[0]!.id],
      );
      assert.equal(page.totalItems, inherited.visibleTurnItems.length);
      assert.isTrue(page.hasMore);
      const nextPage = yield* orchestrator.getTimelinePage(targetThreadId, {
        afterPosition: page.items[0]!.position,
        limit: 10,
      });
      assert.deepEqual(
        nextPage.items
          .filter((row) => row.visibility === "inherited")
          .map((row) => row.sourceItemId),
        [cutId],
      );
      assert.isFalse(nextPage.hasMore);
      const shell = yield* orchestrator.getThreadShell(targetThreadId);
      assert.equal(shell?.visibleItemCount, inherited.visibleTurnItems.length);
      assert.equal(
        (yield* orchestrator.searchThread({ threadId: targetThreadId, query: "INCLUDED_RESPONSE" }))
          .totalMatches,
        1,
      );
      assert.equal(
        (yield* orchestrator.searchThread({ threadId: targetThreadId, query: "EXCLUDED" }))
          .totalMatches,
        0,
      );

      yield* continueFork(targetThreadId);
      const continued = yield* orchestrator.getThreadProjection(targetThreadId);
      // This source has no native session. Check the context payload, not the chosen strategy.
      assert.lengthOf(continued.contextHandoffs, 1);
      const handoff = continued.contextHandoffs[0]!;
      const context = [
        handoff.summaryText,
        ...(handoff.history?.messages.map((message) => message.text) ?? []),
      ].join("\n");
      assert.include(context, "INCLUDED_PROMPT");
      assert.include(context, "INCLUDED_RESPONSE");
      assert.notInclude(context, "EXCLUDED");
    }).pipe(
      Effect.provide(
        Layer.merge(layer, ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
    ),
);
