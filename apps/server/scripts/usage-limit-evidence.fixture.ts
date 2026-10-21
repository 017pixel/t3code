// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetchInEffect:off schemaSyncInEffect:off globalConsole:off preferSchemaOverJson:off - Offline development fixture records complete synthetic inputs and stored events.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnItemId,
  ProviderInstanceId,
  ProviderDriverKind,
  CheckpointId,
  CheckpointScopeId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ServerConfig from "../src/config.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as ApplicationEvents from "../src/persistence/OrchestrationEventStore.ts";
import * as CheckpointStore from "../src/checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../src/git/GitWorkflowService.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as McpSessionRegistryTestkit from "../src/mcp/McpSessionRegistry.testkit.ts";
import * as ProviderRegistry from "../src/provider/ProviderInstanceRegistry.ts";
import * as SourceControlRegistry from "../src/sourceControl/SourceControlProviderRegistry.ts";
import * as VcsRegistry from "../src/vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import * as RuntimeLayer from "../src/orchestration-v2/runtimeLayer.ts";
import * as Orchestrator from "../src/orchestration-v2/Orchestrator.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import { CodexProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { limitRecoveryCommand } from "../src/orchestration-v2/UsageLimitRecoveryWorker.ts";
import recipe from "./usage-limit-evidence.fixture.json" with { type: "json" };

export async function offline(home: string, row: string, stage: string) {
  const log = (kind: string, data: unknown) =>
    console.log(
      JSON.stringify({
        kind,
        boundary: "OFFLINE EVENT HARNESS (server stopped)",
        row,
        stage,
        at: new Date().toISOString(),
        data,
      }),
    );
  const config = ServerConfig.layerTest(process.cwd(), home);
  const platform = Layer.merge(
    NodeServices.layer,
    Layer.mock(SourceControlRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused"),
    }),
  );
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  const driver = ProviderDriverKind.make("codex");
  const instance = {
    instanceId: modelSelection.instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
    displayName: "Synthetic Codex",
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    orchestrationAdapter: {
      instanceId: modelSelection.instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("offline fixture must not open a provider"),
    } as ProviderInstance["orchestrationAdapter"],
  } satisfies ProviderInstance;
  const registry = Layer.succeed(ProviderRegistry.ProviderInstanceRegistry, {
    getInstance: () => Effect.succeed(instance),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const vcs = VcsRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(config),
    Layer.provide(platform),
  );
  const layers = Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    ProjectionStore.layer,
    ProjectStore.layer,
    ApplicationEvents.layer,
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provide(Sqlite.layerConfig),
    Layer.provide(CheckpointStore.layer.pipe(Layer.provide(vcs))),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(registry),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
        createWorktree: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
    ),
    Layer.provide(config),
    Layer.provide(platform),
  );
  const manifestPath = `${home}/fixture.json`;
  const threadId = ThreadId.make(`proof:${row}`);
  await Effect.runPromise(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const dispatch = Effect.fnUntraced(function* (
        command: Parameters<typeof orchestrator.dispatch>[0],
      ) {
        log("command", command);
        return yield* orchestrator.dispatch(command);
      });
      const write = Effect.fnUntraced(function* (
        events: Parameters<typeof sink.write>[0]["events"],
      ) {
        log("synthetic-provider-events", events);
        log("committed", yield* sink.write({ events }));
      });
      if (stage === "init") {
        let now = yield* DateTime.now;
        let resetAt = new Date(DateTime.toEpochMillis(now) + recipe.resetDelayMs).toISOString();
        const projectId = ProjectId.make(`proof:project:${row}`);
        const createdAt = DateTime.formatIso(now);
        const project = {
          projectId,
          title: "Synthetic recovery evidence",
          workspaceRoot: `${home}/workspace`,
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        };
        // ProjectStore is the same fixture seam used by runtimeLayer.test.ts; thread history uses EventSink.
        yield* (yield* ProjectStore.ProjectStoreV2).apply({
          sequence: 0,
          eventId: EventId.make(`proof:project:${row}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: createdAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: project,
        });
        log("project-fixture", project);
        yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make(`proof:create:${row}`),
          threadId,
          projectId,
          title: row,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`proof:source:${row}`),
          threadId,
          messageId: MessageId.make(`proof:source:${row}`),
          text: recipe.sourceText,
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        now = yield* DateTime.now;
        resetAt = new Date(DateTime.toEpochMillis(now) + recipe.resetDelayMs).toISOString();
        yield* write([
          {
            id: EventId.make(`proof:failed:${row}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...source, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`proof:error:${row}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`proof:error:${row}`),
              type: "error",
              threadId,
              runId: source.id,
              nodeId: source.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: { ...recipe.failure, class: "usage_limit", resetAt },
            },
          },
        ]);
        if (row === "R4") {
          yield* dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`proof:queue:${row}`),
            threadId,
            messageId: MessageId.make(`proof:queue:${row}`),
            text: recipe.queueText,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* write([
            {
              id: EventId.make(`proof:held:${row}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...queued, status: "queued", queuePosition: 1, queueHeld: true },
            },
          ]);
        }
        let savedDue = null;
        if (row === "R2" || row === "R5") {
          const candidate = (yield* projections.getLimitRecoveryCandidates({
            now,
            autoResume: true,
            snooze: false,
          })).find((c) => c.id === threadId)!;
          const arm = limitRecoveryCommand(candidate, true, DateTime.toEpochMillis(now), false);
          if (arm?.type !== "thread.metadata.update" || !arm.limitRecovery)
            throw new Error("Missing initial arm");
          log("automatic-arm-service", arm);
          yield* orchestrator.autoArmLimitRecovery({
            commandId: arm.commandId,
            threadId,
            limitRecovery: arm.limitRecovery,
          });
          const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
            (t) => t.id === threadId,
          )!;
          savedDue = limitRecoveryCommand(shell, true, Date.parse(resetAt), false);
        }
        NodeFS.writeFileSync(
          manifestPath,
          JSON.stringify({ row, threadId, sourceRunId: source.id, resetAt, savedDue }),
        );
      }
      if (stage === "wake" || stage === "finish") {
        let now = yield* DateTime.now;
        if (stage === "wake")
          yield* dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`proof:wake:${row}`),
            threadId,
            messageId: MessageId.make(`proof:wake:${row}`),
            text: recipe.wakeText,
            notification: recipe.wakeNotification as {
              source: { kind: "background_task" };
              outcome: "completed";
              summary: string;
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "provider",
          });
        const wake = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        now = yield* DateTime.now;
        if (row === "R4") {
          yield* write([
            {
              id: EventId.make("proof:running:R4"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...wake, status: "running", startedAt: now, completedAt: null },
            },
          ]);
          const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          const command = {
            type: "message.dispatch" as const,
            commandId: CommandId.make("proof:manual:R4:active-offline"),
            messageId: MessageId.make("proof:manual:R4:active-offline"),
            threadId,
            manualContinuationOfRunId: source.id,
            text: recipe.manualText,
            attachments: [],
            dispatchMode: { type: "start_immediately" as const },
            createdBy: "user" as const,
            creationSource: "web" as const,
          };
          log("active-wake-command", command);
          log(
            "active-wake-rejection (harness only)",
            yield* orchestrator.dispatch(command).pipe(Effect.exit),
          );
        }
        const base = {
          threadId,
          runId: wake.id,
          nodeId: wake.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        yield* write([
          {
            id: EventId.make(`proof:notice:${row}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...base,
              id: TurnItemId.make(`proof:notice:${row}`),
              ordinal: 2,
              ...(row === "R5"
                ? {
                    type: "assistant_message" as const,
                    messageId: MessageId.make(`proof:output:${row}`),
                    text: "Finished the remaining implementation and verified the result.",
                    streaming: false,
                  }
                : { type: "system_notice" as const, message: "No further work is needed." }),
            },
          },
          {
            id: EventId.make(`proof:checkpoint:${row}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...base,
              id: TurnItemId.make(`proof:checkpoint:${row}`),
              ordinal: 3,
              type: "checkpoint",
              checkpointId: CheckpointId.make(`proof:checkpoint:${row}`),
              scopeId: CheckpointScopeId.make(`proof:scope:${row}`),
              files: [],
            },
          },
          {
            id: EventId.make(`proof:completed:${row}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...wake, status: "completed", startedAt: now, completedAt: now },
          },
        ]);
      }
      const now = yield* DateTime.now;
      log("offline-observables", {
        projection: yield* orchestrator.getThreadProjection(threadId),
        shell: (yield* orchestrator.getShellSnapshot()).threads.find((t) => t.id === threadId),
        candidate:
          (yield* projections.getLimitRecoveryCandidates({
            now,
            autoResume: true,
            snooze: false,
          })).find((t) => t.id === threadId) ?? null,
      });
      log(
        "all-ordered-stored-events",
        yield* Stream.runCollect(
          (yield* ApplicationEvents.OrchestrationEventStore).readAgentEvents({ threadId }),
        ),
      );
    }).pipe(Effect.provide(layers), Effect.scoped),
  );
}
