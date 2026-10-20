import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadImportInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2Command,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Toolkit from "effect/ai/Toolkit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import * as AttachmentStore from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as OrchestratorHandlers from "../../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import * as ProjectHandlers from "../../mcp/toolkits/project/handlers.ts";
import type { CallerLimits } from "../../mcp/threadAccess.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadImportService from "../../orchestration-v2/ThreadImportService.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { layerProjectService } from "../../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as PeerForwarding from "../PeerForwarding.ts";
import * as PeerLinks from "../PeerLinks.ts";
import * as PeerMcpClient from "../PeerMcpClient.ts";
import * as HandoffGit from "./HandoffGit.ts";
import * as HandoffImport from "./HandoffImport.ts";
import * as ThreadHandoff from "./ThreadHandoff.ts";

const decodeFailure = Schema.decodeUnknownEffect(OrchestratorMcpFailure);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const sourceId = EnvironmentId.make("source");
const destinationId = EnvironmentId.make("destination");
const history = [
  { role: "user" as const, text: "Investigate the login race.", createdAt: "2026-10-01T10:00:00Z" },
  {
    role: "assistant" as const,
    text: "The cookie arrives after the redirect.",
    createdAt: "2026-10-01T10:01:00Z",
  },
  ...Array.from({ length: 10 }, (_, index) => ({
    role: "user" as const,
    text: `Additional investigation detail ${index + 1}.`,
    createdAt: `2026-10-01T10:${String(index + 2).padStart(2, "0")}:00Z`,
  })),
];
const decodeImport = Schema.decodeUnknownEffect(OrchestratorMcpThreadImportInput);
const descriptor = (environmentId: EnvironmentId): ExecutionEnvironmentDescriptor => ({
  environmentId,
  label: environmentId,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: {
    repositoryIdentity: true,
    mcpModeLimitHeader: true,
    linkFence: true,
    threadImport: true,
    threadHandoff: true,
  },
});
const git = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
  return (yield* (yield* VcsProcess.VcsProcess).run({
    operation: "ThreadHandoff.test",
    command: "git",
    cwd,
    args,
    env: {
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })).stdout.trim();
});
const checkout = Effect.fnUntraced(function* (cwd: string) {
  return {
    head: yield* git(cwd, ["rev-parse", "HEAD"]),
    staged: yield* git(cwd, ["diff", "--cached"]),
    status: yield* git(cwd, ["status", "--porcelain"]),
    refs: yield* git(cwd, ["show-ref"]),
  };
});

const makeEnvironment = Effect.fnUntraced(function* (
  id: EnvironmentId,
  cwd: string,
  coldProjectMetadata = false,
) {
  const turns: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const openedSessions: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput> = [];
  const ensuredThreads: Array<ProviderAdapter.ProviderAdapterV2EnsureThreadInput> = [];
  const forkedThreads: Array<ProviderAdapter.ProviderAdapterV2ForkThreadInput> = [];
  const started = yield* Queue.unbounded<{
    turn: ProviderAdapter.ProviderAdapterV2TurnInput;
    finish: Effect.Effect<void>;
  }>();
  const driver = ProviderDriverKind.make("codex");
  const instanceId = modelSelection.instanceId;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        openedSessions.push(input);
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
            cwd: input.runtimePolicy.cwd ?? cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.sync(() => {
              ensuredThreads.push(threadInput);
              const { threadId } = threadInput;
              return {
                id: ProviderThreadId.make(`provider:${threadId}`),
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
              };
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              turns.push(turn);
              const providerTurn = {
                id: ProviderTurnId.make(`turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: turn.attemptId, strength: "strong" as const },
                ordinal: turn.providerTurnOrdinal,
                startedAt: now,
                completedAt: null,
              };
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...providerTurn, status: "running" },
              });
              yield* Queue.offer(started, {
                turn,
                finish: PubSub.publishAll(events, [
                  {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: { ...providerTurn, status: "completed", completedAt: now },
                  },
                  {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: providerTurn.id,
                    runOrdinal: turn.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  },
                ]).pipe(Effect.asVoid),
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unexpected runtime request"),
          readThreadSnapshot: () => Effect.die("unexpected snapshot"),
          rollbackThread: () => Effect.die("unexpected rollback"),
          forkThread: (fork) =>
            Effect.sync(() => {
              forkedThreads.push(fork);
              return {
                ...fork.sourceProviderThread,
                id: ProviderThreadId.make(`provider:${fork.targetThreadId}`),
                appThreadId: fork.targetThreadId,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: {
                  driver,
                  nativeId: fork.targetThreadId,
                  strength: "strong" as const,
                },
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                forkedFrom: {
                  providerThreadId: fork.sourceProviderThread.id,
                  ...(fork.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: fork.providerTurnId }),
                },
              };
            }),
        };
      }),
  };
  const database = Sqlite.layerMemory;
  const settings = ServerSettings.layerTest();
  const config = ServerConfig.layerTest(cwd, { prefix: `t3-handoff-${id}-` });
  const replay = ProviderReplayHarness.layerWithRegistry(
    { name: id },
    ProviderAdapterRegistry.layerSingle(adapter),
    { databaseLayer: database, runEffectWorker: false },
  );
  const stores = Layer.mergeAll(
    ProjectStore.layer,
    ProjectionStore.layer,
    CommandReceiptStore.layer,
    EffectOutbox.layer,
  ).pipe(Layer.provide(database));
  const threads = ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(replay, stores, settings)),
  );
  const projects = layerProjectService.pipe(
    Layer.provide(
      (coldProjectMetadata
        ? Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
            invalidate: () => Effect.void,
            // Keep optional metadata cold so background completion cannot hide discovery failures.
            getAvailable: () =>
              Effect.succeed({
                repositoryIdentity: null,
                repositoryIdentityResolved: false,
                faviconPath: null,
              }),
          })
        : ProjectEnrichment.layer
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            RepositoryIdentityResolver.layer,
            Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(database),
    Layer.provide(settings),
    Layer.provide(config),
  );
  const core = yield* Layer.mergeAll(
    threads,
    replay,
    stores,
    projects,
    settings,
    config,
    GitVcsDriver.layer.pipe(Layer.provide(config)),
    RepositoryIdentityResolver.layer,
  ).pipe(Layer.build);
  const imports = Context.get(
    yield* ThreadImportService.layer.pipe(Layer.provide(Layer.succeedContext(core)), Layer.build),
    ThreadImportService.ThreadImportService,
  );
  const projectId = ProjectId.make(`project:${id}`);
  const projectService = Context.get(core, ProjectService.ProjectService);
  yield* projectService.create({
    commandId: CommandId.make(`create:${id}`),
    projectId,
    title: id,
    workspaceRoot: cwd,
  });
  const management = Context.get(core, ThreadManagement.ThreadManagementService);
  const worker = Context.get(core, EffectWorker.OrchestrationEffectWorkerV2);
  const runState = (threadId: ThreadId, status: "running" | "completed", runId: string) =>
    management.streamStoredEventsFrom({ threadId, eventType: "run.updated" }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          (event.payload.status === status ||
            (status === "completed" && event.payload.status === "waiting")),
      ),
      Stream.runHead,
    );
  const nextTurn = Effect.gen(function* () {
    yield* worker.drain();
    const current = yield* Queue.take(started);
    yield* runState(current.turn.threadId, "running", current.turn.runId);
    const terminal = current.finish.pipe(
      Effect.andThen(runState(current.turn.threadId, "completed", current.turn.runId)),
      Effect.asVoid,
    );
    return { ...current, terminal, finish: terminal.pipe(Effect.andThen(worker.drain())) };
  });
  return {
    core,
    imports,
    projectId,
    projects: projectService,
    management,
    worker,
    turns,
    openedSessions,
    ensuredThreads,
    forkedThreads,
    nextTurn,
    settings: Context.get(core, ServerSettings.ServerSettingsService),
  };
});

const makeFixture = Effect.fnUntraced(function* (coldProjectMetadata = false) {
  yield* TestClock.setTime(Date.parse("2026-10-19T12:00:00.000Z"));
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoff-test-" });
  const sourceRepo = `${root}/source`;
  const receiverRepo = `${root}/receiver`;
  yield* git(root, ["init", "--quiet", "--initial-branch=main", sourceRepo]);
  yield* fs.writeFileString(`${sourceRepo}/app.txt`, "base\n");
  yield* git(sourceRepo, ["add", "."]);
  yield* git(sourceRepo, ["commit", "--quiet", "-m", "base"]);
  yield* git(root, ["clone", "--quiet", sourceRepo, receiverRepo]);
  yield* git(sourceRepo, ["checkout", "--quiet", "-b", "fix/login"]);
  yield* fs.writeFileString(`${sourceRepo}/app.txt`, "committed\n");
  yield* git(sourceRepo, ["commit", "--quiet", "-am", "unpushed"]);
  yield* fs.writeFileString(`${sourceRepo}/app.txt`, "staged\n");
  yield* git(sourceRepo, ["add", "app.txt"]);
  yield* fs.writeFileString(`${sourceRepo}/app.txt`, "working\n");
  yield* fs.writeFileString(`${sourceRepo}/notes.txt`, "findings\n");
  yield* fs.writeFileString(`${receiverRepo}/app.txt`, "receiver staging\n");
  yield* git(receiverRepo, ["add", "app.txt"]);
  if (coldProjectMetadata) {
    const origin = "https://example.com/team/handoff.git";
    yield* git(sourceRepo, ["remote", "add", "origin", origin]);
    yield* git(receiverRepo, ["remote", "set-url", "origin", origin]);
  }
  const source = yield* makeEnvironment(sourceId, sourceRepo);
  const receiver = yield* makeEnvironment(destinationId, receiverRepo, coldProjectMetadata);
  const seeded = yield* source.imports.importThread({
    source: { environmentId: sourceId, threadId: ThreadId.make("seed"), handoffId: "seed" },
    projectId: source.projectId,
    worktreePath: sourceRepo,
    title: "Login race",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    linkOrigin: undefined,
    messages: history,
  });
  const threadId = seeded.threadId;
  const remote = {
    descriptor: descriptor(destinationId),
    loseReply: false,
    beforeImportFailure: null as OrchestratorMcpFailure | null,
    refuseImport: false,
    discardUploads: false,
    afterApply: Effect.void,
    afterAcceptance: Effect.void,
    access: "full-access" as "full-access" | "read-only",
  };
  const payloads: Array<Record<string, unknown>> = [];
  const applyEntries: Array<Parameters<HandoffGit.HandoffGit["Service"]["apply"]>[0]> = [];
  const applied: Array<Parameters<HandoffGit.HandoffGit["Service"]["apply"]>[0]> = [];
  const packed: string[] = [];
  const realGit = Context.get(yield* Layer.build(HandoffGit.layer), HandoffGit.HandoffGit);
  const receiverGit = {
    ...realGit,
    apply: (input: Parameters<typeof realGit.apply>[0]) =>
      Effect.sync(() => applyEntries.push(input)).pipe(
        Effect.andThen(realGit.apply(input)),
        Effect.tap(() =>
          Effect.gen(function* () {
            applied.push(input);
            yield* remote.afterApply;
            if (remote.refuseImport)
              yield* receiver.settings
                .updateSettings({
                  providerInstances: {
                    [modelSelection.instanceId]: {
                      driver: ProviderDriverKind.make("codex"),
                      enabled: false,
                    },
                  },
                })
                .pipe(Effect.orDie);
          }),
        ),
      ),
  };
  const receiverFsCalls: string[] = [];
  const receiving = yield* HandoffImport.layer.pipe(
    Layer.provide(
      Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        exists: (path) =>
          Effect.sync(() => receiverFsCalls.push(`exists:${path}`)).pipe(
            Effect.andThen(fs.exists(path)),
          ),
        realPath: (path) =>
          Effect.sync(() => receiverFsCalls.push(`realPath:${path}`)).pipe(
            Effect.andThen(fs.realPath(path)),
          ),
        makeDirectory: (path, options) =>
          Effect.sync(() => receiverFsCalls.push(`mkdir:${path}`)).pipe(
            Effect.andThen(fs.makeDirectory(path, options)),
          ),
      }),
    ),
    Layer.provide(Layer.succeed(HandoffGit.HandoffGit, receiverGit)),
    Layer.provide(
      Layer.succeed(ThreadImportService.ThreadImportService, {
        ...receiver.imports,
        importThread: (input) =>
          receiver.imports.importThread(input).pipe(Effect.tap(() => remote.afterAcceptance)),
      }),
    ),
    Layer.provideMerge(Layer.succeedContext(receiver.core)),
    Layer.build,
  );
  const handlers = yield* McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
    Layer.provide(Layer.succeedContext(receiving)),
    Layer.build,
  );
  const toolkit = yield* Toolkit.make(
    ProjectToolkit.tools.t3_thread_import,
    ProjectToolkit.tools.t3_project_list,
    ProjectToolkit.tools.t3_project_read,
  ).pipe(Effect.provide(handlers));
  const attachmentId = AttachmentStore.createPendingAttachmentId("bundle");
  const config = Context.get(receiver.core, ServerConfig.ServerConfig);
  const bundlePath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${attachmentId}.bundle`,
  })!;
  const replies: Array<unknown> = [];
  const receiverScope = (limits: CallerLimits): McpInvocationContext.McpInvocationScope => ({
    environmentId: destinationId,
    requestNamespace: "linked-source",
    thread: undefined,
    client: {
      sessionId: "link-source",
      label: "source",
      access: remote.access,
      linked: true,
      narrowedTo: limits,
    },
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });
  const receive = (
    tool: "t3_thread_import" | "t3_project_list" | "t3_project_read",
    input: Record<string, unknown>,
    limits: CallerLimits = { runtimeMode: "approval-required", interactionMode: "plan" },
  ) =>
    toolkit
      .handle(tool, input)
      .pipe(
        Effect.flatMap(Stream.runLast),
        Effect.provide(receiving),
        Effect.provideService(McpInvocationContext.McpInvocationContext, receiverScope(limits)),
        Effect.map(Option.getOrThrow),
      );
  const peer: PeerMcpClient.PeerMcpClient["Service"] = {
    call: (input) =>
      Effect.gen(function* () {
        if (input.tool === "t3_attachment_prepare_upload")
          // oxlint-disable-next-line t3code/no-inline-schema-compile -- Each forwarded tool supplies its own result schema.
          return yield* Schema.decodeUnknownEffect(input.success)({
            attachmentId,
            relativeUrl: "/upload",
            expiresAt: Date.parse("2099-01-01T00:00:00Z"),
          }).pipe(Effect.orDie);
        if (
          input.tool !== "t3_project_list" &&
          input.tool !== "t3_project_read" &&
          input.tool !== "t3_thread_import"
        )
          return yield* Effect.die(`Unexpected forwarded tool: ${input.tool}`);
        if (input.tool === "t3_thread_import") payloads.push(structuredClone(input.arguments));
        if (input.tool === "t3_thread_import" && remote.beforeImportFailure !== null)
          return yield* remote.beforeImportFailure;
        const reply = yield* receive(input.tool, input.arguments, input.limits).pipe(Effect.orDie);
        if (input.tool === "t3_thread_import") replies.push(reply.encodedResult);
        if (reply.isFailure)
          return yield* Effect.flatMap(
            decodeFailure(reply.encodedResult).pipe(Effect.orDie),
            Effect.fail,
          );
        if (input.tool === "t3_thread_import" && remote.loseReply)
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Connection closed after acceptance.",
          });
        // oxlint-disable-next-line t3code/no-inline-schema-compile -- Each forwarded tool supplies its own result schema.
        return yield* Schema.decodeUnknownEffect(input.success)(reply.encodedResult).pipe(
          Effect.orDie,
        );
      }),
  };
  const now = yield* DateTime.now;
  const link = {
    environmentId: destinationId,
    label: "destination",
    urls: ["http://peer.test"],
    access: "full-access" as const,
    linkedAt: now,
    expiresAt: DateTime.add(now, { days: 1 }),
    lastReachedAt: now,
    lastError: null,
  };
  const uploads: Uint8Array[] = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "GET")
        return HttpClientResponse.fromWeb(request, Response.json(remote.descriptor));
      assert.equal(request.url, "http://peer.test/upload");
      assert.equal(request.body._tag, "Uint8Array");
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("expected bundle bytes");
      yield* fs
        .makeDirectory(bundlePath.slice(0, bundlePath.lastIndexOf("/")), { recursive: true })
        .pipe(Effect.orDie);
      uploads.push(request.body.body.slice());
      if (!remote.discardUploads)
        yield* fs.writeFile(bundlePath, request.body.body).pipe(Effect.orDie);
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
    }),
  );
  const sourceDependencies = Layer.mergeAll(
    Layer.succeedContext(source.core),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(sourceId),
      getDescriptor: Effect.succeed(descriptor(sourceId)),
    }),
    Layer.succeed(PeerMcpClient.PeerMcpClient, peer),
    Layer.mock(PeerLinks.PeerLinks)({
      list: Effect.succeed([{ ...link, status: "reachable" }]),
      get: () => Effect.succeed(Option.some(link)),
      resolve: () => Effect.succeed({ link, url: link.urls[0]!, token: "test" }),
      recordOutcome: () => Effect.void,
    }),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(HandoffGit.HandoffGit, {
      ...realGit,
      pack: (input) =>
        Effect.sync(() => packed.push(input.handoffId)).pipe(Effect.andThen(realGit.pack(input))),
    }),
  );
  const handoffLayer = ThreadHandoff.layer.pipe(
    Layer.provide(PeerForwarding.layer),
    Layer.provide(sourceDependencies),
  );
  const handoffScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const handoff = Context.get(
    yield* Layer.buildWithScope(handoffLayer, handoffScope),
    ThreadHandoff.ThreadHandoff,
  );
  const disposeHandoff = Scope.close(handoffScope, Exit.void);
  const start = { threadId, environmentId: destinationId, projectId: receiver.projectId };
  const own = {
    callerThreadId: threadId,
    environmentId: destinationId,
    projectId: receiver.projectId,
  };
  const read = () => source.management.getThreadProjection(threadId);
  const send = (
    id: string,
    dispatchMode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"] = {
      type: "start_immediately",
    },
    attachments: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["attachments"] = [],
  ) =>
    source.management.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}`),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text: id,
      attachments,
      dispatchMode,
      createdBy: "user",
      creationSource: "web",
    });
  return {
    source,
    receiver,
    threadId,
    root,
    sourceRepo,
    receiverRepo,
    remote,
    payloads,
    replies,
    uploads,
    receive,
    receiving: Context.get(receiving, HandoffImport.HandoffImport),
    receiverFsCalls,
    applyEntries,
    applied,
    packed,
    handoff,
    handoffLayer,
    disposeHandoff,
    start,
    own,
    read,
    send,
    bundlePath,
  };
});
const fixture = makeFixture();
const native = Layer.mergeAll(VcsProcess.layer, NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const assertFenced = Effect.fnUntraced(function* (
  send: ReturnType<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>,
) {
  const result = yield* send.pipe(Effect.result);
  assert.equal(result._tag, "Failure", "a fenced source must refuse the native command");
  if (result._tag !== "Failure") return;
  const error = result.failure;
  assert.oneOf(error._tag, ["OrchestratorDispatchError", "OrchestratorCommandRejectedError"]);
  if (
    error._tag === "OrchestratorDispatchError" ||
    error._tag === "OrchestratorCommandRejectedError"
  )
    assert.match(String(error.cause), /handoff|moving|moved|departing|departed/i);
});

it.effect(
  "moves native history and Git work once, stamps the receiver, and seals source sends",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const attachmentId = AttachmentStore.createAttachmentId(f.threadId, "txt")!;
      const sourceConfig = Context.get(f.source.core, ServerConfig.ServerConfig);
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: sourceConfig.attachmentsDir,
        relativePath: `${attachmentId}.txt`,
      })!;
      yield* fs.writeFileString(attachmentPath, "local attachment");
      yield* f.send("last source turn", { type: "start_immediately" }, [
        {
          type: "file",
          id: attachmentId,
          name: "local.txt",
          mimeType: "text/plain",
          sizeBytes: 16,
        },
      ]);
      const sourceTurn = yield* f.source.nextTurn;
      assert.equal(sourceTurn.turn.message.attachments.length, 1);
      yield* sourceTurn.finish;
      yield* TestClock.adjust("1 millis");
      yield* f.send("failed workspace preparation", {
        type: "defer_start",
        workspaceStrategy: { type: "root" },
      });
      const preparation = (yield* f.read()).runs.at(-1)!;
      yield* f.source.management.dispatch({
        type: "prepared-run.fail",
        commandId: CommandId.make("fail-preparation"),
        threadId: f.threadId,
        runId: preparation.id,
        failure: {
          class: "validation_error",
          message: "Setup failed",
          code: null,
          retryable: false,
        },
      });
      yield* f.source.worker.drain();
      const relatedThreadId = ThreadId.make("related-fork");
      yield* f.source.management.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("related-fork"),
        sourceThreadId: f.threadId,
        targetThreadId: relatedThreadId,
        sourcePoint: { type: "run", runId: sourceTurn.turn.runId },
        createdBy: "user",
        creationSource: "web",
      });
      const sourceBefore = yield* f.read();
      assert.isNotEmpty(sourceBefore.providerSessions);
      const before = yield* checkout(f.sourceRepo);
      const receiverBefore = yield* checkout(f.receiverRepo);
      const moved = yield* f.handoff.start(f.start);
      assert.equal(moved.state, "departed");
      if (moved.state !== "departed") return yield* Effect.die("handoff did not depart");
      assert.deepInclude((yield* f.read()).thread.handoff, {
        state: "departed",
        threadId: moved.threadId,
        handoffId: moved.handoffId,
      });
      yield* assertFenced(f.send("must not run here"));
      const checkpoint = sourceBefore.checkpoints.find(
        (item) => item.runId === sourceTurn.turn.runId,
      )!;
      assert.isDefined(checkpoint);
      const fenced = yield* f.read();
      const commands: OrchestrationV2Command[] = [
        {
          type: "prepared-run.retry",
          commandId: CommandId.make("fenced-retry"),
          threadId: f.threadId,
          runId: preparation.id,
        },
        {
          type: "checkpoint.rollback",
          commandId: CommandId.make("fenced-rollback"),
          threadId: f.threadId,
          checkpointId: checkpoint.id,
          scopeId: checkpoint.scopeId,
          restoreFiles: true,
        },
        {
          type: "delegated_task.request",
          commandId: CommandId.make("fenced-delegate"),
          parentThreadId: f.threadId,
          parentRunId: sourceTurn.turn.runId,
          parentNodeId: sourceTurn.turn.rootNodeId,
          task: "Continue investigation",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          createdBy: "agent",
          creationSource: "mcp",
        },
        {
          type: "provider.switch",
          commandId: CommandId.make("fenced-provider"),
          threadId: f.threadId,
          modelSelection: { ...modelSelection, model: "gpt-5.4-mini" },
        },
        {
          type: "thread.merge_back",
          commandId: CommandId.make("fenced-merge"),
          sourceThreadId: relatedThreadId,
          targetThreadId: f.threadId,
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        },
        {
          type: "thread.fork",
          commandId: CommandId.make("fenced-fork"),
          sourceThreadId: f.threadId,
          targetThreadId: ThreadId.make("forbidden-fork"),
          sourcePoint: { type: "run", runId: sourceTurn.turn.runId },
          createdBy: "user",
          creationSource: "web",
        },
      ];
      const outbox = Context.get(f.source.core, EffectOutbox.EffectOutboxV2);
      for (const command of commands) {
        yield* assertFenced(f.source.management.dispatch(command));
        assert.isEmpty(yield* outbox.listByCommandId(command.commandId));
        assert.deepEqual(yield* f.read(), fenced);
      }
      yield* f.source.worker.drain();
      assert.equal(f.source.turns.length, 1);
      assert.isNull(yield* f.source.management.getThreadShell(ThreadId.make("forbidden-fork")));

      const turn = yield* f.receiver.nextTurn;
      const imported = yield* f.receiver.management.getThreadProjection(moved.threadId);
      assert.deepEqual(
        imported.messages
          .filter((message) => message.runId === null)
          .map(({ role, text, createdAt }) => ({
            role,
            text,
            createdAt: DateTime.formatIso(createdAt),
          })),
        sourceBefore.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map(({ role, text, createdAt }) => ({
            role,
            text,
            createdAt: DateTime.formatIso(createdAt),
          })),
      );
      for (const message of sourceBefore.messages)
        assert.include(turn.turn.message.text, message.text);
      const continuation = imported.messages.find((message) => message.runId === turn.turn.runId);
      assert.isDefined(continuation);
      assert.isNotEmpty(continuation!.text.trim());
      assert.include(turn.turn.message.text, `User message:\n${continuation!.text}`);
      assert.equal(imported.runs.length, 1);
      assert.equal(turn.turn.runtimePolicy.cwd, imported.thread.worktreePath);
      assert.deepInclude(turn.turn.runtimePolicy, {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      assert.deepInclude(imported.thread, {
        historyOrigin: "v1_import",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        linkOrigin: { sessionId: "link-source", label: "source", access: "full-access" },
      });
      assert.isTrue(imported.messages.every((message) => message.attachments.length === 0));
      assert.equal(imported.providerSessions.length, 1);
      // Session IDs are environment-local; fresh runtime creation proves independence.
      for (const [environment, projection, runtimeTurn] of [
        [f.source, sourceBefore, sourceTurn.turn],
        [f.receiver, imported, turn.turn],
      ] as const) {
        assert.equal(environment.openedSessions.length, 1);
        assert.equal(environment.ensuredThreads.length, 1);
        const opened = environment.openedSessions[0]!;
        const ensured = environment.ensuredThreads[0]!;
        assert.equal(opened.threadId, projection.thread.id);
        assert.equal(opened.runtimePolicy.cwd, projection.thread.worktreePath);
        assert.isUndefined(opened.resumeFromSession);
        assert.isUndefined(opened.initialNativeThreadId);
        assert.equal(ensured.threadId, projection.thread.id);
        assert.equal(ensured.runtimePolicy.cwd, projection.thread.worktreePath);
        assert.equal(ensured.existingProviderThread?.appThreadId, projection.thread.id);
        assert.isNull(ensured.existingProviderThread?.nativeThreadRef);
        assert.equal(runtimeTurn.providerThread.appThreadId, projection.thread.id);
        assert.deepEqual(runtimeTurn.providerThread.nativeThreadRef, {
          driver: ProviderDriverKind.make("codex"),
          nativeId: projection.thread.id,
          strength: "strong",
        });
        assert.equal(projection.providerSessions[0]!.id, opened.providerSessionId);
        assert.equal(projection.providerSessions[0]!.cwd, opened.runtimePolicy.cwd);
        assert.deepInclude(
          projection.providerThreads.find(({ id }) => id === runtimeTurn.providerThread.id),
          {
            appThreadId: projection.thread.id,
            providerSessionId: opened.providerSessionId,
            nativeThreadRef: runtimeTurn.providerThread.nativeThreadRef,
          },
        );
      }
      assert.isFalse(
        imported.providerThreads.some((thread) =>
          sourceBefore.providerThreads.some(
            (source) =>
              source.id === thread.id ||
              (source.nativeThreadRef !== null &&
                source.nativeThreadRef.nativeId === thread.nativeThreadRef?.nativeId),
          ),
        ),
      );
      assert.equal(
        yield* fs.readFileString(`${imported.thread.worktreePath}/app.txt`),
        "working\n",
      );
      assert.equal(
        yield* fs.readFileString(`${imported.thread.worktreePath}/notes.txt`),
        "findings\n",
      );
      assert.equal(
        yield* git(imported.thread.worktreePath!, ["log", "-1", "--format=%s"]),
        "unpushed",
      );
      assert.deepEqual(yield* checkout(f.sourceRepo), before);
      const receiverAfter = yield* checkout(f.receiverRepo);
      assert.deepEqual(
        { head: receiverAfter.head, staged: receiverAfter.staged, status: receiverAfter.status },
        { head: receiverBefore.head, staged: receiverBefore.staged, status: receiverBefore.status },
      );
      yield* turn.finish;
      yield* f.handoff.start(f.start).pipe(Effect.result);
      yield* f.handoff.settle(f.threadId);
      yield* f.receiver.worker.drain();
      assert.equal(f.receiver.turns.length, 1);
      assert.equal(f.applyEntries.length, 1);
      assert.equal(
        (yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        })).length,
        1,
      );
      assert.equal((yield* f.read()).runs.length, sourceBefore.runs.length);
    }).pipe(Effect.provide(native)),
);

it.effect(
  "rejects unavailable and busy moves, then retains the explicit pending project across the terminal boundary",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const otherRepo = `${f.root}/explicit-receiver`;
      yield* git(f.root, ["clone", "--quiet", f.receiverRepo, otherRepo]);
      const otherProject = ProjectId.make("project:explicit-receiver");
      yield* f.receiver.projects.create({
        commandId: CommandId.make("create:explicit-receiver"),
        projectId: otherProject,
        title: "Explicit receiver",
        workspaceRoot: otherRepo,
      });
      const explicit = { ...f.own, projectId: otherProject };
      f.remote.descriptor = {
        ...f.remote.descriptor,
        capabilities: { repositoryIdentity: true, mcpModeLimitHeader: true, linkFence: true },
      };
      const unavailable = (yield* f.handoff.options(f.threadId)).find(
        (option) => option.environmentId === destinationId,
      );
      assert.isDefined(unavailable);
      assert.isNotNull(unavailable!.reason);
      yield* f.handoff.start(f.start).pipe(Effect.flip);
      assert.isEmpty(f.packed);
      assert.isEmpty(f.applyEntries);
      f.remote.descriptor = {
        ...descriptor(destinationId),
        environmentId: EnvironmentId.make("wrong-peer"),
      };
      yield* f.handoff.start(f.start).pipe(Effect.flip);
      assert.isEmpty(f.packed);
      f.remote.descriptor = descriptor(destinationId);
      const receiverRequest = {
        source: { environmentId: sourceId, threadId: f.threadId, handoffId: "permission-check" },
        projectId: f.receiver.projectId,
        title: "Permissions",
        modelSelection,
        messages: history,
      };
      f.remote.access = "read-only";
      const denied = yield* f.receive("t3_thread_import", receiverRequest);
      assert.isTrue(denied.isFailure);
      assert.deepInclude(denied.encodedResult, { code: "capability_denied" });
      f.remote.access = "full-access";
      const elevated = yield* f.receive("t3_thread_import", {
        ...receiverRequest,
        runtimeMode: "full-access",
      });
      assert.isTrue(elevated.isFailure);
      assert.deepInclude(elevated.encodedResult, { code: "runtime_mode_escalation_denied" });
      assert.isEmpty(f.applyEntries);
      const fs = yield* FileSystem.FileSystem;
      const receiverConfig = Context.get(f.receiver.core, ServerConfig.ServerConfig);
      const beforeValidation = yield* fs.readDirectory(receiverConfig.worktreesDir);
      const uploadLookup = vi.spyOn(AttachmentStore, "resolveAttachmentPathById");
      yield* Effect.addFinalizer(() => Effect.sync(() => uploadLookup.mockRestore()));
      const bundleInput = {
        ...receiverRequest,
        runtimeMode: "approval-required" as const,
        interactionMode: "plan" as const,
        linkOrigin: { sessionId: "link-source", label: "source", access: "full-access" as const },
        bundle: {
          attachmentId: AttachmentStore.createPendingAttachmentId("bundle"),
          branch: "feature",
          tip: "a".repeat(40),
          snapshot: "b".repeat(64),
          repository: { canonicalKey: null, sourceRoot: f.sourceRepo },
        },
      };
      yield* decodeImport(bundleInput);
      for (const input of [
        { ...bundleInput, source: { ...bundleInput.source, handoffId: "../escape" } },
        { ...bundleInput, bundle: { ...bundleInput.bundle, tip: "abc1234" } },
        { ...bundleInput, bundle: { ...bundleInput.bundle, branch: "/feature" } },
      ]) {
        const error = yield* f.receiving.importThread(input).pipe(Effect.flip);
        assert.deepInclude(error, { _tag: "HandoffImportRefusedError", reason: "invalid-bundle" });
        assert.isEmpty(uploadLookup.mock.calls);
        assert.isEmpty(f.receiverFsCalls);
        assert.isEmpty(f.applyEntries);
        assert.deepEqual(yield* fs.readDirectory(receiverConfig.worktreesDir), beforeValidation);
      }
      const nativeInvalid = {
        ...bundleInput,
        bundle: { ...bundleInput.bundle, branch: "/feature" },
      };
      yield* decodeImport(nativeInvalid);
      const invalidReply = yield* f.receive("t3_thread_import", nativeInvalid);
      assert.isTrue(invalidReply.isFailure);
      assert.deepInclude(invalidReply.encodedResult, { code: "invalid_request" });
      assert.isEmpty(uploadLookup.mock.calls);
      assert.isEmpty(f.receiverFsCalls);
      assert.isEmpty(f.applyEntries);
      const missingUpload = yield* f.receiving.importThread(bundleInput).pipe(Effect.flip);
      assert.deepInclude(missingUpload, {
        _tag: "HandoffImportRefusedError",
        reason: "missing-upload",
      });
      assert.equal(uploadLookup.mock.calls.length, 1);
      uploadLookup.mockRestore();
      assert.isFalse(f.receiverFsCalls.some((call) => call.startsWith("mkdir:")));
      const opaque = yield* f.receive("t3_thread_import", {
        ...receiverRequest,
        projectId: otherProject,
        source: { ...receiverRequest.source, handoffId: "handoff:opaque" },
      });
      assert.isFalse(opaque.isFailure);
      const busy = yield* f.source.imports.importThread({
        source: { environmentId: sourceId, threadId: f.threadId, handoffId: "busy-fixture" },
        projectId: f.source.projectId,
        worktreePath: f.sourceRepo,
        title: "Busy source",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        linkOrigin: undefined,
        messages: [],
      });
      const prepare = {
        type: "message.dispatch" as const,
        threadId: busy.threadId,
        commandId: CommandId.make("prepare"),
        messageId: MessageId.make("prepare"),
        text: "preparing",
        attachments: [],
        dispatchMode: { type: "defer_start" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      yield* f.source.management.dispatch(prepare);
      const preparing = (yield* f.source.management.getThreadProjection(busy.threadId)).runs.at(
        -1,
      )!;
      assert.equal(preparing.status, "preparing");
      yield* f.handoff.start({ ...f.start, threadId: busy.threadId }).pipe(Effect.flip);
      yield* f.source.management.dispatch({
        ...prepare,
        commandId: CommandId.make("queued"),
        messageId: MessageId.make("queued"),
        text: "held queue",
        dispatchMode: { type: "queue_after_active" },
      });
      yield* f.source.management.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("hold-preparing"),
        threadId: busy.threadId,
        runId: preparing.id,
        holdQueue: true,
      });
      yield* f.source.worker.drain();
      assert.isNull((yield* f.source.management.getThreadShell(busy.threadId))!.activeRunId);
      assert.equal(
        (yield* f.source.management.getThreadProjection(busy.threadId)).runs.at(-1)?.status,
        "queued",
      );
      yield* f.handoff.start({ ...f.start, threadId: busy.threadId }).pipe(Effect.flip);
      assert.isEmpty(f.packed);
      yield* f.send("waiting");
      const waiting = yield* f.source.nextTurn;
      assert.equal((yield* f.read()).runs.at(-1)?.status, "running");
      yield* f.handoff.start(f.start).pipe(Effect.flip);
      yield* waiting.terminal;
      assert.equal((yield* f.read()).runs.at(-1)?.status, "waiting");
      yield* f.handoff.start(f.start).pipe(Effect.flip);
      yield* f.source.worker.drain();
      assert.isEmpty(f.packed);
      yield* f.send("running before request");
      const active = yield* f.source.nextTurn;
      yield* f.handoff
        .start({ ...explicit, projectId: ProjectId.make("does-not-exist") })
        .pipe(Effect.flip);
      assert.isNull((yield* f.read()).thread.handoff ?? null);
      yield* f.send("steering before request", {
        type: "steer_active",
        targetRunId: active.turn.runId,
      });
      yield* f.source.worker.drain();
      const beforeMessage = (yield* f.read()).messages.find(
        (message) => message.id === MessageId.make("message:steering before request"),
      )!;
      const pending = yield* f.handoff.start(explicit);
      assert.equal(pending.state, "pending");
      assert.deepInclude((yield* f.read()).thread.handoff, { projectId: otherProject });
      const boundary = Option.getOrThrow(
        yield* f.source.management.streamStoredEventsFrom({ threadId: f.threadId }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.metadata-updated" &&
              event.payload.handoff?.handoffId === pending.handoffId,
          ),
          Stream.runHead,
        ),
      );
      if (pending.state !== "pending") return yield* Effect.die("expected pending handoff");
      assert.equal(pending.requestCommandId, boundary.commandId);
      const beforeEvent = Option.getOrThrow(
        yield* f.source.management
          .streamStoredEventsFrom({ threadId: f.threadId, eventType: "message.updated" })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "message.updated" && event.payload.id === beforeMessage.id,
            ),
            Stream.runHead,
          ),
      );
      assert.isBelow(beforeEvent.sequence, boundary.sequence);
      assert.equal(
        DateTime.toEpochMillis(beforeMessage.createdAt),
        DateTime.toEpochMillis(boundary.event.occurredAt),
      );
      yield* f.handoff.settle(f.threadId);
      assert.equal((yield* f.read()).thread.handoff?.state, "pending");
      assert.isEmpty(f.packed);
      yield* f.handoff.start_();
      yield* active.terminal;
      assert.equal((yield* f.read()).thread.handoff?.state, "pending");
      yield* f.source.worker.drain();
      yield* f.source.management.streamStoredEventsFrom({ threadId: f.threadId }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "thread.metadata-updated" && event.payload.handoff?.state === "departed",
        ),
        Stream.runHead,
      );
      assert.equal(f.payloads[0]?.projectId, otherProject);
      const received = yield* f.receiver.nextTurn;
      const imported = yield* f.receiver.management.getThreadProjection(received.turn.threadId);
      assert.equal(imported.thread.projectId, otherProject);
      assert.equal(f.applyEntries[0]?.repoRoot, otherRepo);
      assert.isEmpty(
        yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        }),
      );
      yield* received.finish;
    }).pipe(Effect.provide(native)),
);

it.effect(
  "pauses promotion while pending and resumes after cancellation or same-tick instructions without stale clears",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.send("first");
      const first = yield* f.source.nextTurn;
      yield* f.send("already queued", { type: "queue_after_active" });
      const a = yield* f.handoff.start(f.own);
      assert.equal(a.state, "pending");
      yield* first.finish;
      assert.equal(f.source.turns.length, 1);
      assert.equal((yield* f.read()).runs.at(-1)?.status, "queued");
      const pendingProjection = yield* f.read();
      if (a.state !== "pending") return yield* Effect.die("expected pending handoff");
      for (const [index, changed] of [
        { environmentId: sourceId },
        { projectId: f.source.projectId },
        { label: "another destination" },
      ].entries()) {
        const commandId = CommandId.make(`changed-identity:${index}`);
        yield* assertFenced(
          f.source.management.dispatch({
            type: "thread.handoff.update",
            commandId,
            threadId: f.threadId,
            expected: { state: "pending", handoffId: a.handoffId },
            handoff: { ...a, ...changed, state: "departing" },
          }),
        );
        assert.isEmpty(
          yield* Context.get(f.source.core, EffectOutbox.EffectOutboxV2).listByCommandId(commandId),
        );
        assert.deepEqual(yield* f.read(), pendingProjection);
      }
      yield* assertFenced(
        f.source.management.dispatch({
          type: "thread.handoff.update",
          commandId: CommandId.make("wrong-expected-state"),
          threadId: f.threadId,
          expected: { state: "departing", handoffId: a.handoffId },
          handoff: { ...a, state: "departing" },
        }),
      );
      assert.deepEqual(yield* f.read(), pendingProjection);
      yield* f.handoff.cancel({ threadId: f.threadId, handoffId: a.handoffId });
      const second = yield* f.source.nextTurn;
      assert.include(second.turn.message.text, "already queued");
      const b = yield* f.handoff.start(f.own);
      assert.notEqual(b.handoffId, a.handoffId);
      yield* f.handoff.cancel({ threadId: f.threadId, handoffId: a.handoffId }).pipe(Effect.result);
      assert.equal((yield* f.read()).thread.handoff?.handoffId, b.handoffId);
      yield* f.handoff.cancel({ threadId: f.threadId, handoffId: b.handoffId });
      assert.isNull((yield* f.read()).thread.handoff ?? null);
      const beforeWrongRequest = yield* f.read();
      yield* assertFenced(
        f.source.management.dispatch({
          type: "thread.handoff.update",
          commandId: CommandId.make("actual-request-command"),
          threadId: f.threadId,
          callerThreadId: f.threadId,
          expected: null,
          handoff: { ...a, requestCommandId: CommandId.make("wrong-request-command") },
        }),
      );
      assert.deepEqual(yield* f.read(), beforeWrongRequest);
      yield* f.send("queued before third request", { type: "queue_after_active" });
      const c = yield* f.handoff.start(f.own);
      assert.notEqual(c.handoffId, b.handoffId);
      const boundary = Option.getOrThrow(
        yield* f.source.management.streamStoredEventsFrom({ threadId: f.threadId }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.metadata-updated" &&
              event.payload.handoff?.handoffId === c.handoffId,
          ),
          Stream.runHead,
        ),
      );
      yield* f.send("instructions after request", {
        type: "steer_active",
        targetRunId: second.turn.runId,
      });
      const after = Option.getOrThrow(
        yield* f.source.management
          .streamStoredEventsFrom({ threadId: f.threadId, eventType: "message.updated" })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "message.updated" &&
                event.payload.id === MessageId.make("message:instructions after request"),
            ),
            Stream.runHead,
          ),
      );
      assert.isAbove(after.sequence, boundary.sequence);
      assert.equal(
        DateTime.toEpochMillis(after.event.occurredAt),
        DateTime.toEpochMillis(boundary.event.occurredAt),
      );
      assert.isNull((yield* f.read()).thread.handoff ?? null);
      yield* second.finish;
      const third = yield* f.source.nextTurn;
      assert.include(third.turn.message.text, "queued before third request");
      yield* third.finish;
      assert.isEmpty(f.payloads);
      assert.isEmpty(f.packed);
    }).pipe(Effect.provide(native)),
);

it.effect(
  "rolls back a returned Git lease on definitive native refusal for new and fast-forwarded branches",
  () =>
    Effect.gen(function* () {
      for (const existingBranch of [false, true]) {
        const f = yield* fixture;
        if (existingBranch) yield* git(f.receiverRepo, ["branch", "fix/login", "HEAD"]);
        const before = yield* checkout(f.receiverRepo);
        const worktrees = yield* git(f.receiverRepo, ["worktree", "list", "--porcelain"]);
        f.remote.refuseImport = true;
        if (existingBranch) {
          yield* f.send("running before refused move");
          const active = yield* f.source.nextTurn;
          yield* f.send("queued before refused move", { type: "queue_after_active" });
          yield* f.handoff.start(f.own);
          yield* active.finish;
          assert.equal((yield* f.read()).runs.at(-1)?.status, "queued");
          yield* f.handoff.settle(f.threadId);
        } else yield* f.handoff.start(f.start).pipe(Effect.result);
        assert.equal(f.applyEntries.length, 1);
        assert.equal(
          f.applied.length,
          1,
          "the refusal must happen after real Git.apply returned its lease",
        );
        assert.deepInclude(f.replies[0], { code: "invalid_request" });
        assert.match(
          String((f.replies[0] as { message: string }).message),
          /provider.*disabled|disabled.*provider/i,
        );
        const failed = (yield* f.read()).thread.handoff;
        assert.equal(failed?.state, "failed");
        assert.match(
          failed?.state === "failed" ? failed.lastError : "",
          /provider.*disabled|disabled.*provider/i,
        );
        assert.deepEqual(yield* checkout(f.receiverRepo), before);
        assert.equal(yield* git(f.receiverRepo, ["worktree", "list", "--porcelain"]), worktrees);
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(f.applied[0]!.worktreePath));
        assert.isEmpty(
          yield* f.receiver.management.listProjectThreads({
            projectId: f.receiver.projectId,
            includeSubagents: false,
          }),
        );
        if (existingBranch) {
          const resumed = yield* f.source.nextTurn;
          assert.include(resumed.turn.message.text, "queued before refused move");
          yield* resumed.finish;
          const forkId = ThreadId.make("fork-after-failed-move");
          yield* f.source.management.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-after-failed-move"),
            sourceThreadId: f.threadId,
            targetThreadId: forkId,
            sourcePoint: { type: "run", runId: resumed.turn.runId },
            createdBy: "user",
            creationSource: "web",
          });
          assert.isNull((yield* f.source.management.getThreadProjection(forkId)).thread.handoff);
          assert.equal((yield* f.read()).thread.handoff?.state, "failed");
        }
        yield* f.send("continue locally after refusal");
        const continued = yield* f.source.nextTurn;
        assert.include(continued.turn.message.text, "continue locally after refusal");
        yield* continued.finish;
      }
    }).pipe(Effect.provide(native)),
);

it.effect(
  "recovers lost acceptance with immutable identity and payload before consumed-upload lookup or Git",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.remote.loseReply = true;
      yield* f.handoff
        .start({ ...f.start, continuationPrompt: "Continue the login investigation." })
        .pipe(Effect.result);
      const departing = (yield* f.read()).thread.handoff;
      assert.equal(departing?.state, "departing");
      yield* assertFenced(f.send("forbidden while uncertain"));
      const first = yield* f.receiver.nextTurn;
      yield* first.finish;
      const imported = yield* f.receiver.management.getThreadProjection(first.turn.threadId);
      assert.deepInclude(f.replies[0], {
        threadId: first.turn.threadId,
        runId: first.turn.runId,
        created: true,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${imported.thread.worktreePath}/notes.txt`,
        "destination continued working\n",
      );
      yield* fs.writeFileString(
        `${f.sourceRepo}/app.txt`,
        "source checkout changed after packing\n",
      );
      yield* fs.remove(f.bundlePath, { force: true });
      f.remote.discardUploads = true;
      yield* f.handoff.settle(f.threadId);
      assert.deepInclude((yield* f.read()).thread.handoff, {
        state: "departing",
        handoffId: departing!.handoffId,
      });
      assert.isFalse(yield* fs.exists(f.bundlePath));
      f.remote.loseReply = false;
      yield* f.disposeHandoff;
      const recovered = Context.get(
        yield* Layer.build(Layer.fresh(f.handoffLayer)),
        ThreadHandoff.ThreadHandoff,
      );
      yield* Effect.all([recovered.settle(f.threadId), recovered.settle(f.threadId)], {
        concurrency: "unbounded",
      });
      assert.deepInclude((yield* f.read()).thread.handoff, {
        state: "departed",
        handoffId: departing!.handoffId,
        threadId: first.turn.threadId,
      });
      yield* assertFenced(f.send("still forbidden after recovery"));
      assert.isAtLeast(f.payloads.length, 2);
      const semantic = (payload: Record<string, unknown>) => {
        const { attachmentId: _locator, ...bundle } = payload.bundle as Record<string, unknown>;
        return { ...payload, bundle };
      };
      for (const payload of f.payloads)
        assert.deepEqual(semantic(payload), semantic(f.payloads[0]!));
      for (const bytes of f.uploads) assert.deepEqual(bytes, f.uploads[0]);
      for (const reply of f.replies.slice(1))
        assert.deepInclude(reply, {
          threadId: first.turn.threadId,
          runId: first.turn.runId,
          created: false,
        });
      assert.equal(
        f.packed.length,
        1,
        "recovery must retain the original bundle despite later source edits",
      );
      assert.equal(f.applyEntries.length, 1, "replay must not even enter Git.apply");
      assert.equal(
        yield* fs.readFileString(`${imported.thread.worktreePath}/notes.txt`),
        "destination continued working\n",
      );
      yield* f.receiver.worker.drain();
      assert.deepEqual(
        yield* f.receiver.management.getThreadProjection(first.turn.threadId),
        imported,
      );
      assert.equal(f.receiver.turns.length, 1);
      assert.equal(
        (yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        })).length,
        1,
      );
    }).pipe(Effect.provide(native)),
);

it.effect(
  "retains accepted work across cancellation but rolls back interruption before acceptance",
  () =>
    Effect.gen(function* () {
      for (const accepted of [false, true]) {
        const f = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gate = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        if (accepted) f.remote.afterAcceptance = gate;
        else f.remote.afterApply = gate;
        const before = yield* checkout(f.receiverRepo);
        const worktreesBefore = yield* git(f.receiverRepo, ["worktree", "list", "--porcelain"]);
        const caller = yield* f.handoff.start(f.start).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.equal(f.applied.length, 1, "the real Git lease must exist before interruption");
        const path = f.applied[0]!.worktreePath;
        assert.isTrue(yield* fs.exists(path));
        assert.equal((yield* f.read()).thread.handoff?.state, "departing");
        yield* assertFenced(f.send("forbidden at interruption gate"));
        const threads = yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        });
        assert.equal(threads.length, accepted ? 1 : 0);
        const committed = accepted
          ? yield* f.receiver.management.getThreadProjection(threads[0]!.id)
          : null;
        if (committed !== null) {
          assert.equal(committed.thread.worktreePath, path);
          assert.equal(committed.runs.length, 1);
          assert.isNotEmpty(committed.messages);
          yield* fs.writeFileString(`${path}/notes.txt`, "receiver edit before cancellation\n");
        }
        // Request interruption synchronously while the real import's return is held at the gate.
        yield* Effect.sync(() => caller.interruptUnsafe());
        yield* Deferred.succeed(release, undefined);
        const exit = yield* Fiber.await(caller);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) assert.isTrue(exit.cause.reasons.some(Cause.isInterruptReason));
        if (committed === null) {
          assert.isFalse(yield* fs.exists(path));
          assert.deepEqual(yield* checkout(f.receiverRepo), before);
          assert.equal(
            yield* git(f.receiverRepo, ["worktree", "list", "--porcelain"]),
            worktreesBefore,
          );
          assert.isEmpty(
            yield* f.receiver.management.listProjectThreads({
              projectId: f.receiver.projectId,
              includeSubagents: false,
            }),
          );
          continue;
        }
        assert.isTrue(yield* fs.exists(path));
        assert.equal(
          yield* git(f.receiverRepo, ["rev-parse", "refs/heads/fix/login"]),
          f.applied[0]!.tip,
        );
        assert.deepEqual(
          yield* f.receiver.management.getThreadProjection(committed.thread.id),
          committed,
        );
        assert.equal((yield* f.read()).thread.handoff?.state, "departing");
        yield* assertFenced(f.send("forbidden until accepted replay"));
        const continuation = yield* f.receiver.nextTurn;
        assert.equal(continuation.turn.runId, committed.runs[0]!.id);
        yield* continuation.finish;
        const completed = yield* f.receiver.management.getThreadProjection(committed.thread.id);
        f.remote.discardUploads = true;
        yield* f.handoff.settle(f.threadId);
        assert.deepInclude((yield* f.read()).thread.handoff, {
          state: "departed",
          threadId: committed.thread.id,
        });
        yield* f.receiver.worker.drain();
        assert.equal(f.receiver.turns.length, 1);
        assert.equal(f.applyEntries.length, 1);
        assert.deepEqual(
          yield* f.receiver.management.getThreadProjection(committed.thread.id),
          completed,
        );
        assert.equal(
          yield* fs.readFileString(`${path}/notes.txt`),
          "receiver edit before cancellation\n",
        );
      }
    }).pipe(Effect.provide(native)),
);

it.effect(
  "retries a quiet uncertain move through start with the same identity without restarting",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.remote.loseReply = true;
      yield* f.handoff
        .start({ ...f.start, continuationPrompt: "Keep the original request." })
        .pipe(Effect.result);
      const departing = (yield* f.read()).thread.handoff!;
      assert.equal(departing.state, "departing");
      assert.isEmpty(f.source.turns);
      const continuation = yield* f.receiver.nextTurn;
      yield* continuation.finish;
      const accepted = yield* f.receiver.management.getThreadProjection(continuation.turn.threadId);
      const retry = { ...f.start, handoffId: departing.handoffId };
      for (const changed of [
        { ...retry, handoffId: "stale-handoff" },
        { ...retry, environmentId: EnvironmentId.make("other-peer") },
        { ...retry, projectId: ProjectId.make("other-project") },
        { ...retry, continuationPrompt: "Replace the original request." },
      ]) {
        assert.equal((yield* f.handoff.start(changed).pipe(Effect.result))._tag, "Failure");
        assert.deepEqual((yield* f.read()).thread.handoff, departing);
        assert.equal(f.payloads.length, 1);
      }
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${f.sourceRepo}/app.txt`, "changed after ambiguous reply\n");
      yield* fs.writeFileString(
        `${accepted.thread.worktreePath}/notes.txt`,
        "accepted receiver edit\n",
      );
      yield* fs.remove(f.bundlePath, { force: true });
      f.remote.discardUploads = true;
      f.remote.loseReply = false;
      yield* f.receiver.settings.updateSettings({
        providerInstances: {
          [modelSelection.instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
      });
      const result = yield* f.handoff.start(retry).pipe(Effect.result);
      assert.equal(
        result._tag,
        "Success",
        "a restored peer must be reachable through the supported same-ID retry",
      );
      assert.deepInclude((yield* f.read()).thread.handoff, {
        state: "departed",
        handoffId: departing.handoffId,
        threadId: continuation.turn.threadId,
      });
      assert.deepInclude(f.replies.at(-1), {
        threadId: continuation.turn.threadId,
        runId: continuation.turn.runId,
        created: false,
      });
      assert.equal(f.payloads.length, 2);
      assert.deepEqual(f.payloads[1], f.payloads[0]);
      assert.equal(f.uploads.length, 2);
      assert.deepEqual(f.uploads[1], f.uploads[0]);
      assert.equal(f.packed.length, 1);
      assert.equal(f.applyEntries.length, 1);
      const acknowledged = yield* f.handoff.start(retry);
      assert.deepEqual(acknowledged, (yield* f.read()).thread.handoff);
      assert.equal(
        f.payloads.length,
        2,
        "a departed retry only acknowledges the accepted identity",
      );
      yield* assertFenced(f.send("no source turn after same-ID retry"));
      yield* f.receiver.worker.drain();
      assert.deepEqual(
        yield* f.receiver.management.getThreadProjection(continuation.turn.threadId),
        accepted,
      );
      assert.equal(f.receiver.turns.length, 1);
      assert.equal(
        (yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        })).length,
        1,
      );
      assert.equal(
        yield* fs.readFileString(`${accepted.thread.worktreePath}/notes.txt`),
        "accepted receiver edit\n",
      );
    }).pipe(Effect.provide(native)),
);

it.effect(
  "releases queued work when same-ID retry is definitively refused after an ambiguous preacceptance failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* git(f.receiverRepo, ["branch", "fix/login", "HEAD"]);
      const before = yield* checkout(f.receiverRepo);
      const worktrees = yield* git(f.receiverRepo, ["worktree", "list", "--porcelain"]);
      yield* f.send("active before ambiguous move");
      const active = yield* f.source.nextTurn;
      yield* f.send("queued behind ambiguous move", { type: "queue_after_active" });
      const pending = yield* f.handoff.start(f.own);
      f.remote.beforeImportFailure = new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Connection closed before receiver delivery.",
      });
      yield* active.finish;
      yield* f.handoff.settle(f.threadId);
      assert.deepInclude((yield* f.read()).thread.handoff, {
        state: "departing",
        handoffId: pending.handoffId,
      });
      assert.equal((yield* f.read()).runs.at(-1)?.status, "queued");
      assert.equal(f.payloads.length, 1);
      assert.isEmpty(f.replies);
      assert.isEmpty(f.applyEntries);
      assert.isEmpty(
        yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        }),
      );
      const retry = { ...f.start, handoffId: pending.handoffId };
      f.remote.beforeImportFailure = new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Wire validation refused before acceptance lookup.",
      });
      yield* f.handoff.start(retry).pipe(Effect.result);
      assert.equal(f.payloads.length, 2, "retry must reach the pre-lookup transport refusal");
      assert.equal((yield* f.read()).thread.handoff?.state, "departing");
      assert.equal((yield* f.read()).runs.at(-1)?.status, "queued");
      assert.isEmpty(f.applyEntries);
      f.remote.beforeImportFailure = null;
      f.remote.access = "read-only";
      yield* f.handoff.start(retry).pipe(Effect.result);
      assert.equal(f.payloads.length, 3);
      assert.equal(
        f.replies.length,
        1,
        "the real protected handler must refuse the read-only caller",
      );
      assert.equal((yield* f.read()).thread.handoff?.state, "departing");
      assert.equal((yield* f.read()).runs.at(-1)?.status, "queued");
      assert.isEmpty(f.applyEntries);
      f.remote.access = "full-access";
      f.remote.refuseImport = true;
      yield* f.handoff.start(retry).pipe(Effect.result);
      assert.equal(
        f.applied.length,
        1,
        "same-ID retry must reach the real receiver and acquire a Git lease before refusal",
      );
      assert.match(
        String((f.replies.at(-1) as { message: string }).message),
        /provider.*disabled|disabled.*provider/i,
      );
      assert.deepEqual(yield* checkout(f.receiverRepo), before);
      assert.equal(yield* git(f.receiverRepo, ["worktree", "list", "--porcelain"]), worktrees);
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(f.applied[0]!.worktreePath));
      assert.isEmpty(
        yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        }),
      );
      const failed = (yield* f.read()).thread.handoff;
      assert.equal(
        failed?.state,
        "failed",
        "definitive nonacceptance must release a previously uncertain source",
      );
      assert.equal(failed?.handoffId, pending.handoffId);
      assert.equal(f.packed.length, 1);
      for (const payload of f.payloads) assert.deepEqual(payload, f.payloads[0]);
      for (const bytes of f.uploads) assert.deepEqual(bytes, f.uploads[0]);
      const resumed = yield* f.source.nextTurn;
      assert.include(resumed.turn.message.text, "queued behind ambiguous move");
      yield* resumed.finish;
      const payloadCount = f.payloads.length;
      assert.equal(
        (yield* f.handoff.start(retry).pipe(Effect.result))._tag,
        "Failure",
        "a failed handoff ID cannot mint another move",
      );
      assert.equal(f.payloads.length, payloadCount);
      assert.deepEqual((yield* f.read()).thread.handoff, failed);
    }).pipe(Effect.provide(native)),
);

it.effect(
  "moves a native fork with inherited history through its fork point and its own followup",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.send("source decision at fork point");
      const boundary = yield* f.source.nextTurn;
      yield* boundary.finish;
      yield* TestClock.adjust("1 millis");
      const sourceHandoff = (yield* f.read()).thread.handoff;
      assert.isNull(sourceHandoff ?? null);
      const forkId = ThreadId.make("move-visible-fork");
      yield* f.source.management.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("move-visible-fork"),
        sourceThreadId: f.threadId,
        targetThreadId: forkId,
        sourcePoint: { type: "run", runId: boundary.turn.runId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* f.send("later source secret excluded from fork");
      const later = yield* f.source.nextTurn;
      yield* later.finish;
      yield* TestClock.adjust("1 millis");
      yield* f.source.management.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fork-followup"),
        threadId: forkId,
        messageId: MessageId.make("fork-followup"),
        text: "fork own followup",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const followup = yield* f.source.nextTurn;
      assert.equal(followup.turn.threadId, forkId);
      yield* followup.finish;
      const fork = yield* f.source.management.getThreadProjection(forkId);
      assert.equal(fork.thread.lineage.relationshipToParent, "fork");
      assert.deepEqual(fork.thread.forkedFrom, {
        type: "run",
        threadId: f.threadId,
        runId: boundary.turn.runId,
      });
      assert.equal(f.source.forkedThreads.length, 1);
      assert.equal(
        f.source.forkedThreads[0]!.providerTurnId,
        ProviderTurnId.make(`turn:${boundary.turn.attemptId}`),
      );
      assert.equal(fork.contextTransfers[0]?.resolution?.strategy, "native_fork");
      const expected = [
        ...history.map(({ role, text }) => ({ role, text })),
        { role: "user", text: "source decision at fork point" },
        { role: "user", text: "fork own followup" },
      ];
      assert.deepEqual(
        fork.visibleTurnItems.flatMap(({ item }) =>
          item.type === "user_message" || item.type === "assistant_message"
            ? [{ role: item.type === "user_message" ? "user" : "assistant", text: item.text }]
            : [],
        ),
        expected,
      );
      const moved = yield* f.handoff.start({ ...f.start, threadId: forkId });
      assert.equal(moved.state, "departed");
      if (moved.state !== "departed") return yield* Effect.die("fork did not depart");
      const continuation = yield* f.receiver.nextTurn;
      const imported = yield* f.receiver.management.getThreadProjection(moved.threadId);
      assert.deepEqual(
        imported.messages
          .filter((message) => message.runId === null)
          .map(({ role, text }) => ({ role, text })),
        expected,
        "destination history must include the visible inherited prefix and fork-local followup",
      );
      for (const { text } of expected) assert.include(continuation.turn.message.text, text);
      assert.notInclude(continuation.turn.message.text, "later source secret excluded from fork");
      assert.equal(imported.runs.length, 1);
      assert.strictEqual((yield* f.read()).thread.handoff, sourceHandoff);
      yield* continuation.finish;
    }).pipe(Effect.provide(native)),
);

it.effect(
  "requires explicit current-ID abandonment to release uncertain queued work and preserves the accepted copy",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.send("active before abandoned move");
      const active = yield* f.source.nextTurn;
      yield* f.send("queued behind abandoned move", { type: "queue_after_active" });
      const pending = yield* f.handoff.start(f.own);
      f.remote.loseReply = true;
      yield* active.finish;
      yield* f.handoff.settle(f.threadId);
      const departing = (yield* f.read()).thread.handoff;
      assert.deepInclude(departing, { state: "departing", handoffId: pending.handoffId });
      const continuation = yield* f.receiver.nextTurn;
      yield* continuation.finish;
      const accepted = yield* f.receiver.management.getThreadProjection(continuation.turn.threadId);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${accepted.thread.worktreePath}/notes.txt`,
        "preserve abandoned destination copy\n",
      );
      const artifact = `${Context.get(f.source.core, ServerConfig.ServerConfig).stateDir}/handoffs/${pending.handoffId}`;
      assert.isTrue(yield* fs.exists(`${artifact}/request.json`));
      f.remote.beforeImportFailure = new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Peer permanently unavailable.",
      });
      const cancel = { threadId: f.threadId, handoffId: pending.handoffId };
      for (const request of [cancel, { ...cancel, handoffId: "stale-handoff", abandon: true }]) {
        assert.equal((yield* f.handoff.cancel(request).pipe(Effect.result))._tag, "Failure");
        assert.deepEqual((yield* f.read()).thread.handoff, departing);
        assert.equal((yield* f.read()).runs.at(-1)?.status, "queued");
        assert.isTrue(yield* fs.exists(`${artifact}/request.json`));
      }
      yield* assertFenced(f.send("ordinary cancel must keep the fence"));
      const abandon = { ...cancel, abandon: true };
      const result = yield* f.handoff.cancel(abandon).pipe(Effect.result);
      assert.equal(
        result._tag,
        "Success",
        "explicit current-ID abandonment must offer local recovery without the peer",
      );
      const failed = (yield* f.read()).thread.handoff;
      assert.equal(failed?.state, "failed");
      assert.equal(failed?.handoffId, pending.handoffId);
      assert.match(
        failed?.state === "failed" ? failed.lastError : "",
        /destination.*(?:may|might).*(?:copy|accept)/i,
      );
      assert.isFalse(yield* fs.exists(artifact));
      const resumed = yield* f.source.nextTurn;
      assert.include(resumed.turn.message.text, "queued behind abandoned move");
      yield* resumed.finish;
      assert.equal(
        f.payloads.length,
        1,
        "abandonment must not require contacting the unavailable peer",
      );
      assert.deepEqual(
        yield* f.receiver.management.getThreadProjection(continuation.turn.threadId),
        accepted,
      );
      assert.equal(f.receiver.turns.length, 1);
      assert.equal(
        (yield* f.receiver.management.listProjectThreads({
          projectId: f.receiver.projectId,
          includeSubagents: false,
        })).length,
        1,
      );
      assert.equal(
        yield* fs.readFileString(`${accepted.thread.worktreePath}/notes.txt`),
        "preserve abandoned destination copy\n",
      );
    }).pipe(Effect.provide(native)),
);

it.effect("releases queued work on the first native refusal of a mismatched repository", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const wrongRepo = `${f.root}/unrelated`;
    const wrongProjectId = ProjectId.make("project:unrelated");
    yield* git(f.root, ["init", "--quiet", "--initial-branch=main", wrongRepo]);
    yield* git(wrongRepo, ["commit", "--quiet", "--allow-empty", "-m", "unrelated"]);
    yield* f.receiver.projects.create({
      commandId: CommandId.make("create-unrelated-project"),
      projectId: wrongProjectId,
      title: "Unrelated repository",
      workspaceRoot: wrongRepo,
    });
    const before = yield* checkout(wrongRepo);
    const worktrees = yield* git(wrongRepo, ["worktree", "list", "--porcelain"]);
    yield* f.send("active before wrong-repository move");
    const active = yield* f.source.nextTurn;
    yield* f.send("queued behind wrong-repository move", { type: "queue_after_active" });
    const pending = yield* f.handoff.start({ ...f.own, projectId: wrongProjectId });
    yield* active.finish;
    assert.equal((yield* f.read()).runs.at(-1)?.status, "queued");
    yield* f.handoff.settle(f.threadId);
    assert.equal(f.payloads.length, 1);
    assert.equal(f.replies.length, 1);
    const refusal = yield* decodeFailure(f.replies[0]);
    assert.equal(refusal.code, "invalid_request");
    assert.match(refusal.message, /different repository/i);
    assert.isEmpty(f.applyEntries, "repository refusal must precede Git.apply");
    assert.isEmpty(
      yield* f.receiver.management.listProjectThreads({
        projectId: wrongProjectId,
        includeSubagents: false,
      }),
    );
    assert.deepEqual(yield* checkout(wrongRepo), before);
    assert.equal(yield* git(wrongRepo, ["worktree", "list", "--porcelain"]), worktrees);
    expect.soft(refusal.handoffNotAccepted).toEqual({
      source: {
        environmentId: sourceId,
        threadId: f.threadId,
        handoffId: pending.handoffId,
      },
      projectId: wrongProjectId,
    });
    const failed = (yield* f.read()).thread.handoff;
    assert.equal(failed?.state, "failed", "proven repository refusal must release the source");
    assert.equal(failed?.handoffId, pending.handoffId);
    assert.match(failed?.state === "failed" ? failed.lastError : "", /different repository/i);
    const resumed = yield* f.source.nextTurn;
    assert.include(resumed.turn.message.text, "queued behind wrong-repository move");
    yield* resumed.finish;
    assert.isEmpty(f.receiver.turns);
  }).pipe(Effect.provide(native)),
);

it.effect(
  "exposes the departing handoff identity through native MCP thread read after a lost reply",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.remote.loseReply = true;
      assert.equal((yield* f.handoff.start(f.start).pipe(Effect.result))._tag, "Failure");
      const departing = (yield* f.read()).thread.handoff!;
      assert.equal(departing.state, "departing");
      const continuation = yield* f.receiver.nextTurn;
      yield* continuation.finish;
      const dependencies = Layer.mergeAll(
        Layer.succeedContext(f.source.core),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const services = yield* OrchestratorMcpService.layer.pipe(
        Layer.provideMerge(dependencies),
        Layer.build,
      );
      const handlers = yield* McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
        Layer.provide(Layer.succeedContext(services)),
        Layer.build,
      );
      const toolkit = yield* Toolkit.make(OrchestratorToolkit.tools.t3_thread_read).pipe(
        Effect.provide(handlers),
      );
      const reply = yield* toolkit.handle("t3_thread_read", { threadId: f.threadId }).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.provide(services),
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: sourceId,
          requestNamespace: "handoff-recovery-client",
          thread: undefined,
          client: { sessionId: "handoff-recovery", label: "Recovery", access: "full-access" },
          capabilities: new Set(["orchestration"] as const),
          issuedAt: 0,
        }),
        Effect.map(Option.getOrThrow),
      );
      assert.isFalse(reply.isFailure);
      assert.deepNestedInclude(reply.encodedResult, {
        "thread.handoff.state": "departing",
        "thread.handoff.handoffId": departing.handoffId,
        "thread.handoff.environmentId": destinationId,
        "thread.handoff.projectId": f.receiver.projectId,
      });
    }).pipe(Effect.provide(native)),
);

it.effect("finds the unique matching handoff project while optional metadata is cold", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture(true);
    const listed = yield* f.receive("t3_project_list", { limit: 100 });
    assert.isFalse(listed.isFailure);
    assert.deepNestedInclude(listed.encodedResult, {
      "projects[0].id": f.receiver.projectId,
      "projects[0].repositoryIdentity": null,
      nextCursor: null,
    });
    expect.soft(yield* f.handoff.options(f.threadId)).toEqual([
      {
        environmentId: destinationId,
        label: "destination",
        projectId: f.receiver.projectId,
        reason: null,
      },
    ]);
    const identity = yield* Context.get(
      f.receiver.core,
      RepositoryIdentityResolver.RepositoryIdentityResolver,
    ).resolve(f.receiverRepo);
    assert.equal(identity?.canonicalKey, "example.com/team/handoff");
  }).pipe(Effect.provide(native)),
);
