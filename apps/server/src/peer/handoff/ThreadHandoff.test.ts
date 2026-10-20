import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpFailure,
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

import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ProjectHandlers from "../../mcp/toolkits/project/handlers.ts";
import type { CallerLimits } from "../../mcp/threadAccess.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadImportService from "../../orchestration-v2/ThreadImportService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { layerProjectService } from "../../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
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
];
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

const makeEnvironment = Effect.fnUntraced(function* (id: EnvironmentId, cwd: string) {
  const turns: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
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
          ensureThread: ({ threadId }) =>
            Effect.succeed({
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
          forkThread: () => Effect.die("unexpected fork"),
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
  ).pipe(Layer.provide(database));
  const threads = ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(replay, stores, settings)),
  );
  const projects = layerProjectService.pipe(
    Layer.provide(
      ProjectEnrichment.layer.pipe(
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
    nextTurn,
    settings: Context.get(core, ServerSettings.ServerSettingsService),
  };
});

const fixture = Effect.gen(function* () {
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
  const source = yield* makeEnvironment(sourceId, sourceRepo);
  const receiver = yield* makeEnvironment(destinationId, receiverRepo);
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
    refuseImport: false,
    discardUploads: false,
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
  const receiving = yield* HandoffImport.layer.pipe(
    Layer.provide(Layer.succeed(HandoffGit.HandoffGit, receiverGit)),
    Layer.provide(Layer.succeed(ThreadImportService.ThreadImportService, receiver.imports)),
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
  const attachmentId = createPendingAttachmentId("bundle");
  const config = Context.get(receiver.core, ServerConfig.ServerConfig);
  const bundlePath = resolveAttachmentPathById({
    attachmentsDir: config.attachmentsDir,
    attachmentId,
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
const native = Layer.mergeAll(VcsProcess.layer, NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const assertFenced = Effect.fnUntraced(function* (
  send: ReturnType<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>,
) {
  const result = yield* send.pipe(Effect.result);
  assert.equal(result._tag, "Failure", "a moved source must refuse native message dispatch");
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
      const attachmentId = createAttachmentId(f.threadId, "txt")!;
      const sourceConfig = Context.get(f.source.core, ServerConfig.ServerConfig);
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: sourceConfig.attachmentsDir,
        attachmentId,
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
      assert.isFalse(
        imported.providerSessions.some((session) =>
          sourceBefore.providerSessions.some((source) => source.id === session.id),
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
      yield* f.handoff.cancel({ threadId: f.threadId, handoffId: a.handoffId });
      const second = yield* f.source.nextTurn;
      assert.include(second.turn.message.text, "already queued");
      const b = yield* f.handoff.start(f.own);
      assert.notEqual(b.handoffId, a.handoffId);
      yield* f.handoff.cancel({ threadId: f.threadId, handoffId: a.handoffId }).pipe(Effect.result);
      assert.equal((yield* f.read()).thread.handoff?.handoffId, b.handoffId);
      yield* f.handoff.cancel({ threadId: f.threadId, handoffId: b.handoffId });
      assert.isNull((yield* f.read()).thread.handoff ?? null);
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
        yield* f.handoff.start(f.start).pipe(Effect.result);
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
