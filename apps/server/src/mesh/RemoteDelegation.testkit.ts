// Real orchestrator in memory plus a scripted remote member, for remote delegate_task tests.
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type MeshSnapshot,
  type MeshTaskStateResponse,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ThreadMeshOrigin,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type RepositoryIdentity,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderTurnStartServiceTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as MeshTaskState from "./MeshTaskState.ts";
import * as MeshServices from "./Services.ts";
import * as MeshTestkit from "./testkit.ts";

export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");

const repositoryIdentity = {
  canonicalKey: "github.com/t3/app",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:t3/app.git" },
} satisfies RepositoryIdentity;

export const memberEnvironmentId = EnvironmentId.make("environment:box");
export const memberThreadId = ThreadId.make("thread:on-box");
export const memberRunId = RunId.make("run:on-box");
export const memberProjectId = ProjectId.make("project:on-box");

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-mesh-remote-delegation-",
});

const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("remote delegation tests open no provider sessions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const enrichment = {
  repositoryIdentity,
  faviconPath: null,
  repositoryIdentityResolved: true,
};

/** Orchestrator, thread management, projects and stores on one in-memory database. */
export const layerOrchestration = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () => Effect.succeed(enrichment),
      request: () => Effect.void,
      getAvailable: () => Effect.succeed(enrichment),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(layerProviderInstanceRegistry),
  Layer.provideMerge(layerPlatformTest),
);

/** A thread whose agent turn is running, in a project that exists. */
export const seedRunningThread = Effect.fn("RemoteDelegationTestkit.seedRunningThread")(
  function* (input: {
    readonly name: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly userMessageId?: MessageId;
    readonly meshOrigin?: OrchestrationV2ThreadMeshOrigin;
  }) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { name, threadId, projectId } = input;
    const runId = RunId.make(`run:${name}`);
    const rootNodeId = NodeId.make(`node:${name}:root`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${name}:create`),
      threadId,
      projectId,
      title: input.title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(input.meshOrigin === undefined ? {} : { meshOrigin: input.meshOrigin }),
    });
    const scope = {
      threadId,
      driver,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
    };
    yield* eventSink.write({
      commandId: CommandId.make(`command:${name}:seed`),
      events: [
        {
          ...scope,
          id: EventId.make(`event:${name}:provider-thread`),
          type: "provider-thread.updated",
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          ...scope,
          id: EventId.make(`event:${name}:root`),
          type: "node.updated",
          runId,
          nodeId: rootNodeId,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          ...scope,
          id: EventId.make(`event:${name}:run`),
          type: "run.updated",
          runId,
          nodeId: rootNodeId,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: input.userMessageId ?? MessageId.make(`message:${name}:user`),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    return { threadId, projectId, runId, rootNodeId };
  },
);

/** A parent thread whose agent turn is running, as when it calls delegate_task. */
export const seedParent = Effect.fn("RemoteDelegationTestkit.seedParent")(function* (name: string) {
  const projects = yield* ProjectService.ProjectService;
  const projectId = ProjectId.make(`project:${name}`);
  yield* projects.create({
    commandId: CommandId.make(`command:${name}:project`),
    projectId,
    title: "Remote delegation",
    workspaceRoot: `/workspace/${name}`,
  });
  return yield* seedRunningThread({
    name,
    threadId: ThreadId.make(`thread:${name}`),
    projectId,
    title: "Remote delegation parent",
  });
});

/** Ends a seeded thread's run with an assistant reply, as a provider turn would. */
export const completeRun = Effect.fn("RemoteDelegationTestkit.completeRun")(function* (
  thread: Effect.Success<ReturnType<typeof seedRunningThread>>,
  text: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const { runs } = yield* orchestrator.getThreadRecords(thread.threadId, ["runs"]);
  const run = runs.find((candidate) => candidate.id === thread.runId);
  if (run === undefined) return yield* Effect.die(`run ${thread.runId} is missing`);
  const scope = {
    threadId: thread.threadId,
    runId: thread.runId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
  };
  yield* eventSink.write({
    events: [
      {
        ...scope,
        id: EventId.make(`event:${thread.runId}:reply`),
        type: "message.updated",
        nodeId: thread.rootNodeId,
        payload: {
          id: MessageId.make(`message:${thread.runId}:reply`),
          threadId: thread.threadId,
          runId: thread.runId,
          nodeId: thread.rootNodeId,
          role: "assistant",
          text,
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
        id: EventId.make(`event:${thread.runId}:completed`),
        type: "run.updated",
        payload: { ...run, status: "completed", completedAt: now },
      },
    ],
  });
});

/** Records a remote task the way delegate_task does, before any network call. */
export const requestRemoteTask = Effect.fn("RemoteDelegationTestkit.requestRemoteTask")(function* (
  parent: Effect.Success<ReturnType<typeof seedParent>>,
  options: { readonly completionWake?: "always" | "settled_only" } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const result = yield* orchestrator.dispatch({
    type: "delegated_task.remote.request",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make(`command:${parent.threadId}:remote-request`),
    parentThreadId: parent.threadId,
    parentRunId: parent.runId,
    parentNodeId: parent.rootNodeId,
    task: "Run the test suite on the box.",
    modelSelection,
    environmentId: memberEnvironmentId,
    label: "box",
    launch: {
      repositoryKey: repositoryIdentity.canonicalKey,
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    completionWake: options.completionWake ?? "always",
  });
  const event = result.storedEvents.find((stored) => stored.event.type === "subagent.updated");
  if (event?.event.nodeId == null) return yield* Effect.die("no remote task was recorded");
  return event.event.nodeId;
});

export const readTask = Effect.fn("RemoteDelegationTestkit.readTask")(function* (
  parentThreadId: ThreadId,
  taskId: NodeId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const records = yield* orchestrator.getThreadRecords(parentThreadId, [
    "subagents",
    "runs",
    "messages",
    "nodes",
    "turnItems",
  ]);
  const task = records.subagents.find((candidate) => candidate.id === taskId);
  if (task === undefined) return yield* Effect.die(`task ${taskId} is missing`);
  const item = records.turnItems.find(
    (candidate) => candidate.type === "subagent" && candidate.subagentId === taskId,
  );
  const node = records.nodes.find((candidate) => candidate.id === taskId);
  return { ...records, task, item, node };
});

/** A project on the scripted member; `app` is its checkout of the parent's repository. */
export const memberProject = (id: ProjectId, workspaceRoot: string) => ({
  id,
  title: "app",
  workspaceRoot,
  repositoryIdentity,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  deletedAt: null,
});

export interface MemberCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly options: MeshServices.MeshToolCallOptions;
}

const runningState: MeshTaskStateResponse = {
  workState: "working",
  status: "running",
  hasPendingQuestion: false,
  pendingQuestionRequestId: null,
  pendingApproval: null,
  result: null,
  settled: false,
};

/**
 * A member that answers MCP tools and `mesh.taskState` from refs the test sets. Every tool call
 * lands in `calls`; `t3_thread_wait` then blocks until the test offers to `waitReleases`.
 */
export const makeMember = Effect.fn("RemoteDelegationTestkit.makeMember")(function* () {
  const calls = yield* Queue.unbounded<MemberCall>();
  const waitReleases = yield* Queue.unbounded<void>();
  const state = yield* Ref.make<MeshTaskStateResponse>(runningState);
  const unreachable = yield* Ref.make(false);
  const projects = yield* Ref.make([memberProject(memberProjectId, "/srv/app")]);
  const unreachableError = new MeshServices.MeshMemberUnreachableError({
    environmentId: memberEnvironmentId,
  });
  const snapshot: MeshSnapshot = {
    selfEnvironmentId: EnvironmentId.make("environment:laptop"),
    captain: null,
    pin: null,
    members: [
      {
        environmentId: memberEnvironmentId,
        label: "box",
        machineKind: null,
        serverVersion: "0.0.0-test",
        online: true,
        capabilities: { meshMember: true, meshAgents: true },
        connectHostname: null,
        directEndpoints: [],
        captainEligible: false,
      },
    ],
  };
  const membership = yield* MeshTestkit.makeMembership({ snapshot });

  const layerMcpClient = MeshTestkit.layerMcpClient((environmentId, tool, args, options) =>
    Effect.gen(function* () {
      yield* Queue.offer(calls, { tool, args, options });
      if (yield* Ref.get(unreachable)) return yield* unreachableError;
      switch (tool) {
        case "t3_project_list":
          return { projects: yield* Ref.get(projects), nextCursor: null };
        case "orchestrator_capabilities":
          return {
            providers: [
              {
                providerInstanceId: modelSelection.instanceId,
                models: [{ id: modelSelection.model }],
              },
            ],
          };
        case "t3_thread_launch":
          return {
            threadId: memberThreadId,
            projectId: memberProjectId,
            modelSelection,
            runId: memberRunId,
            status: "running",
          };
        case "t3_thread_wait":
          yield* Queue.take(waitReleases);
          return { threadId: args.threadId, runId: memberRunId, status: "running", timedOut: true };
        case "t3_thread_interrupt":
          return { threadId: args.threadId, runId: memberRunId, status: "interrupt_requested" };
        default:
          return yield* new MeshServices.MeshRemoteToolError({
            environmentId,
            toolName: tool,
            code: "invalid_request",
            message: `The test member has no ${tool}.`,
          });
      }
    }),
  );

  const layerTaskStates = Layer.succeed(
    MeshTaskState.MeshTaskStateClient,
    MeshTaskState.MeshTaskStateClient.of({
      read: () =>
        Ref.get(unreachable).pipe(
          Effect.flatMap((down) => (down ? Effect.fail(unreachableError) : Ref.get(state))),
        ),
    }),
  );

  return {
    calls,
    waitReleases,
    layer: Layer.mergeAll(layerMcpClient, layerTaskStates, membership.layer),
    setState: (next: Partial<MeshTaskStateResponse>) =>
      Ref.set(state, { ...runningState, ...next }),
    setUnreachable: (down: boolean) => Ref.set(unreachable, down),
    setProjects: (next: ReadonlyArray<ReturnType<typeof memberProject>>) =>
      Ref.set(projects, [...next]),
    /** Takes calls until `tool`, returning it; earlier calls are dropped. */
    takeCall: (tool: string) =>
      Effect.gen(function* () {
        while (true) {
          const call = yield* Queue.take(calls);
          if (call.tool === tool) return call;
        }
      }),
  };
});
