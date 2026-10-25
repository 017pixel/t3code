// @effect-diagnostics nodeBuiltinImport:off - real member servers and ES256 DPoP keys need Node HTTP and crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  formatMeshModeLimit,
  MESH_MODE_LIMIT_HEADER,
  type MeshMemberView,
  type MeshSnapshot,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { computeDpopAccessTokenHash, computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../mcp/ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as ProjectHandlers from "../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadHandlers from "../mcp/toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MeshForwarding from "./MeshForwarding.ts";
import * as MeshForwardingAuth from "./MeshForwardingAuth.ts";
import * as MeshMcpClient from "./MeshMcpClient.ts";
import * as MeshOwners from "./MeshOwners.ts";
import type * as MeshServices from "./Services.ts";
import * as MeshTestkit from "./testkit.ts";

const X = EnvironmentId.make("env-x");
const Y = EnvironmentId.make("env-y");
const Z = EnvironmentId.make("env-z");
const LABELS: Record<string, string> = { [X]: "laptop", [Y]: "box", [Z]: "vps" };

const codex = ProviderInstanceId.make("codex");
const REPO = "github.com/t3/app";
const EPOCH = "2026-01-01T00:00:00.000Z";

const project = (id: string, repositoryKey: string | null): Project => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/projects/${id}`,
  repositoryIdentity:
    repositoryKey === null
      ? null
      : {
          canonicalKey: repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${repositoryKey}.git`,
          },
        },
  defaultModelSelection: { instanceId: codex, model: "gpt-5" },
  scripts: [],
  createdAt: EPOCH,
  updatedAt: EPOCH,
  deletedAt: null,
});

const thread = (
  id: string,
  projectId: string,
  runtimeMode: RuntimeMode = "full-access",
): OrchestrationV2ThreadShell => ({
  ...McpToolAccessTestkit.liveThreadShell(ThreadId.make(id), { runtimeMode }),
  projectId: ProjectId.make(projectId),
});

const member = (environmentId: EnvironmentId, online: boolean): MeshMemberView => ({
  environmentId,
  label: LABELS[environmentId]!,
  machineKind: null,
  serverVersion: "0.0.0-test",
  online,
  capabilities: { meshMember: true, meshAgents: true },
  connectHostname: null,
  directEndpoints: [],
  captainEligible: false,
});

const snapshotFor = (
  self: EnvironmentId,
  online: Partial<Record<EnvironmentId, boolean>>,
): MeshSnapshot => ({
  selfEnvironmentId: self,
  captain: null,
  pin: null,
  members: [X, Y, Z].map((id) => member(id, id === self || online[id] === true)),
});

interface Seen {
  readonly tool: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly input: unknown;
}

/** One machine's fake domain state; the mesh, auth and MCP paths around it are real. */
interface MachineState {
  readonly environmentId: EnvironmentId;
  readonly threads: Map<ThreadId, OrchestrationV2ThreadShell>;
  readonly projects: Array<Project>;
  readonly searchRows: Array<ThreadSearch.ThreadSearchHit>;
  readonly models: Array<string>;
  readonly seen: Array<Seen>;
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  /** Clone destinations and the repository cloned there. */
  readonly clones: Map<string, string>;
  /** Bearer tokens of agents running on this machine. */
  readonly callers: Map<string, McpInvocationContext.McpInvocationScope>;
}

const machineState = (environmentId: EnvironmentId): MachineState => ({
  environmentId,
  threads: new Map(),
  projects: [],
  searchRows: [],
  models: ["gpt-5"],
  seen: [],
  launches: [],
  clones: new Map(),
  callers: new Map(),
});

const threadCaller = (
  state: MachineState,
  token: string,
  shell: OrchestrationV2ThreadShell,
): void => {
  state.threads.set(shell.id, shell);
  state.callers.set(token, {
    environmentId: state.environmentId,
    requestNamespace: `provider-session:${token}`,
    thread: { threadId: shell.id, providerSessionId: token, providerInstanceId: codex },
    client: undefined,
    capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
    issuedAt: 0,
  });
};

const clientCaller = (state: MachineState, token: string, access: "read-only" | RuntimeMode) =>
  state.callers.set(token, {
    environmentId: state.environmentId,
    requestNamespace: `client:${token}`,
    thread: undefined,
    client: { sessionId: token, label: "Outside agent", access },
    capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
    issuedAt: 0,
  });

const capabilitiesResult = (state: MachineState) => ({
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  providers: [
    {
      providerInstanceId: codex,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: null,
      models: state.models.map((id) => ({ id })),
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
});

const layerDomain = (state: MachineState) =>
  Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(state.threads.get(threadId) ?? null),
      getProjectThreadRecords: ({ threadId }) => {
        const shell = state.threads.get(threadId);
        return shell === undefined
          ? Effect.fail(
              new ThreadManagement.ThreadManagementThreadNotFoundError({
                projectId: ProjectId.make("project:unknown"),
                threadId,
              }),
            )
          : Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell) as never);
      },
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      capabilities: (scope) =>
        Effect.sync(() => {
          state.seen.push({ tool: "orchestrator_capabilities", scope, input: {} });
          return capabilitiesResult(state);
        }),
      waitForThread: (scope, input) =>
        Effect.sync(() => {
          state.seen.push({ tool: "t3_thread_wait", scope, input });
          return {
            threadId: input.threadId,
            runId: input.runId ?? RunId.make("run:latest"),
            status: "running" as const,
            timedOut: true,
          };
        }),
    }),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(Option.fromNullishOr(state.projects.find(({ id }) => id === projectId))),
      snapshot: Effect.sync(() => ({ projects: state.projects, updatedAt: EPOCH })),
      create: (input) =>
        Effect.sync(() => {
          const created = {
            ...project(input.projectId, state.clones.get(input.workspaceRoot) ?? null),
            title: input.title,
            workspaceRoot: input.workspaceRoot,
          };
          state.projects.push(created);
          return created;
        }),
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({
      searchThreads: (input) =>
        Effect.succeed({
          matches: state.searchRows.filter(
            (row) => input.projectId === undefined || row.projectId === input.projectId,
          ),
        }),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (launch) =>
        Effect.sync(() => {
          state.launches.push(launch);
          return {
            threadId: launch.threadId!,
            projection: {
              thread: {
                id: launch.threadId,
                title: launch.title,
                projectId: launch.projectId,
                modelSelection: launch.modelSelection,
              },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Effect.sync(() => {
          state.clones.set(input.destinationPath, input.repository!);
          return {
            cwd: input.destinationPath,
            remoteUrl: `https://${input.repository}.git`,
            repository: null,
          };
        }),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(state.environmentId),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(state.environmentId),
    }),
    ServerSettings.layerTest(),
    PlatformNodeCrypto.layer,
    FetchHttpClient.layer,
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mesh-forwarding-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** A member's DPoP key, signing a fresh proof for every request it sends. */
const makeMeshKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" }) as {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
  };
  const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    thumbprint: computeDpopJwkThumbprint(jwk),
    proof: (input: { method: string; url: string; token: string }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const signed = `${base64({ typ: "dpop+jwt", alg: "ES256", jwk })}.${base64({
            htm: input.method,
            htu: input.url,
            jti: NodeCrypto.randomUUID(),
            iat: Math.floor(now / 1000),
            ath: computeDpopAccessTokenHash(input.token),
          })}`;
          const signature = NodeCrypto.sign("sha256", Buffer.from(signed), {
            key: privateKey,
            dsaEncoding: "ieee-p1363",
          }).toString("base64url");
          return `${signed}.${signature}`;
        }),
      ),
  };
};

interface Running {
  readonly state: MachineState;
  readonly baseUrl: string;
  readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly key: ReturnType<typeof makeMeshKey>;
  readonly membership: Effect.Success<ReturnType<typeof MeshTestkit.makeMembership>>;
  /** Forget cached sessions, as a renewal does; the next call redeems a new one. */
  readonly renewSessions: Effect.Effect<void>;
}

/**
 * Starts one member: its own `/mcp`, `mesh.owns` route, session store and mesh services, on a real
 * port. `peers` fills in as the other members start, the way the relay snapshot names them.
 */
const startMachine = Effect.fn("test.startMachine")(function* (
  state: MachineState,
  peers: Map<EnvironmentId, Running>,
) {
  const key = makeMeshKey();
  const membership = yield* MeshTestkit.makeMembership({
    snapshot: snapshotFor(state.environmentId, { [Y]: true, [X]: true }),
  });
  const cached = new Map<EnvironmentId, MeshServices.MeshSession>();
  const credentials = MeshTestkit.layerCredentials({
    session: (environmentId) =>
      Effect.gen(function* () {
        const existing = cached.get(environmentId);
        if (existing !== undefined) return existing;
        const target = peers.get(environmentId)!;
        const issued = yield* target.auth
          .issueMeshMemberSession({
            meshCaller: state.environmentId,
            proofKeyThumbprint: key.thumbprint,
          })
          .pipe(Effect.orDie);
        const session: MeshServices.MeshSession = {
          environmentId,
          token: issued.token,
          expiresAt: DateTime.toUtc(issued.expiresAt),
          route: { kind: "lan", httpBaseUrl: target.baseUrl },
          connectUrl: null,
          authorizationHeaders: ({ method, url }) =>
            key
              .proof({ method, url, token: issued.token })
              .pipe(Effect.map((dpop) => ({ authorization: `DPoP ${issued.token}`, dpop }))),
        };
        cached.set(environmentId, session);
        return session;
      }),
  });
  const layerMesh = MeshForwarding.layer.pipe(
    Layer.provide(Layer.mergeAll(MeshOwners.layer, MeshMcpClient.layer)),
    Layer.provide(Layer.mergeAll(membership.layer, credentials)),
  );
  const layerApp = Layer.mergeAll(
    McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
    McpHttpServer.toolkitRegistration(ThreadToolkit, ThreadHandlers.layer),
    McpHttpServer.toolkitRegistration(ProjectToolkit, ProjectHandlers.layer),
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerMcpTransport),
    Layer.merge(MeshOwners.layerOwnsRoute),
    Layer.provide(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) =>
          Effect.succeed(
            state.callers.get(token)?.thread === undefined
              ? undefined
              : (state.callers.get(token) as McpInvocationContext.McpThreadInvocationScope),
          ),
      }),
    ),
    Layer.provide(
      Layer.succeed(McpHttpServer.McpClientAuthenticator, {
        authenticate: (request) => {
          const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
          const scope = state.callers.get(token);
          return Effect.succeed(scope?.client === undefined ? undefined : scope);
        },
      }),
    ),
    Layer.provide(MeshForwardingAuth.layerMcpMeshAuthenticator),
    Layer.provide(layerMesh),
  );
  const layerAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
  );
  const context = yield* HttpRouter.serve(layerApp, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(layerAuth),
    Layer.provideMerge(layerDomain(state)),
    Layer.build,
  );
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
  const running: Running = {
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
    key,
    membership,
    renewSessions: Effect.sync(() => cached.clear()),
  };
  peers.set(state.environmentId, running);
  return running;
});

const startMesh = Effect.fn("test.startMesh")(function* () {
  const peers = new Map<EnvironmentId, Running>();
  const x = yield* startMachine(machineState(X), peers);
  const y = yield* startMachine(machineState(Y), peers);
  const z = yield* startMachine(machineState(Z), peers);
  return { x, y, z };
});

const ToolFailure = Schema.fromJsonString(
  Schema.Struct({ code: Schema.String, message: Schema.String }),
);
const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});

const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const decodeToolFailure = Schema.decodeUnknownEffect(ToolFailure);

type Outcome =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** An agent on `machine` calling its own `/mcp` with its bearer token. */
const callTool = Effect.fn("test.callTool")(function* (
  machine: Running,
  token: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const raw = yield* mcpToolSession({
    endpoint: `${machine.baseUrl}/mcp`,
    authorization: `Bearer ${token}`,
    clientName: "mesh-test",
  }).pipe(
    Effect.flatMap((session) => session.call(tool, args)),
    Effect.scoped,
    Effect.orDie,
  );
  const result = yield* decodeToolResult(raw).pipe(Effect.orDie);
  if (result.isError !== true) {
    return { ok: true, value: result.structuredContent as Record<string, unknown> } as Outcome;
  }
  const failure = yield* decodeToolFailure(result.content[0]?.text).pipe(Effect.orDie);
  return { ok: false, ...failure } as Outcome;
});

/** A raw mesh request to `machine`'s `/mcp`, for checks the client would never send. */
const rawMeshInitialize = Effect.fn("test.rawMeshInitialize")(function* (
  machine: Running,
  headers: (url: string) => Effect.Effect<Record<string, string>>,
) {
  const url = `${machine.baseUrl}/mcp`;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          ...(yield* headers(url)),
        }),
        HttpClientRequest.bodyJsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        }),
      ),
    )
    .pipe(Effect.orDie);
  return { status: response.status, body: yield* response.text.pipe(Effect.orDie) };
}, Effect.provide(FetchHttpClient.layer));

const seenOn = (machine: Running, tool: string) =>
  machine.state.seen.filter((entry) => entry.tool === tool);

describe("mesh agent tools across two real servers", () => {
  it.effect("forwards a call by thread id and keeps an omitted id local", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      y.state.threads.set(ThreadId.make("thread:on-y"), thread("thread:on-y", "project:y"));

      const remote = yield* callTool(x, "agent-x", "t3_thread_configuration", {
        threadId: "thread:on-y",
      });
      expect(remote).toEqual({
        ok: true,
        value: expect.objectContaining({ threadId: "thread:on-y" }),
      });

      const local = yield* callTool(x, "agent-x", "orchestrator_capabilities", {});
      expect(local.ok).toBe(true);
      expect(seenOn(x, "orchestrator_capabilities")).toHaveLength(1);
      expect(seenOn(y, "orchestrator_capabilities")).toHaveLength(0);
      expect(local.ok && local.value.machines).toEqual([
        { environmentId: X, label: "laptop", online: true, self: true },
        { environmentId: Y, label: "box", online: true, self: false },
        { environmentId: Z, label: "vps", online: false, self: false },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("finds the owner, refuses two owners, and names members that did not answer", () =>
    Effect.gen(function* () {
      const { x, y, z } = yield* startMesh();
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      y.state.threads.set(ThreadId.make("thread:twin"), thread("thread:twin", "project:y"));
      z.state.threads.set(ThreadId.make("thread:twin"), thread("thread:twin", "project:z"));
      yield* x.membership.setSnapshot(snapshotFor(X, { [Y]: true, [Z]: true }));

      const ambiguous = yield* callTool(x, "agent-x", "t3_thread_configuration", {
        threadId: "thread:twin",
      });
      expect(ambiguous).toMatchObject({ ok: false, code: "owner_ambiguous" });
      expect(!ambiguous.ok && ambiguous.message).toContain("box, vps");

      const missing = yield* callTool(x, "agent-x", "t3_thread_configuration", {
        threadId: "thread:nowhere",
      });
      expect(missing).toMatchObject({ ok: false, code: "owner_not_found" });
    }).pipe(Effect.scoped),
  );

  it.effect("names offline members for a missing id, and stays local with no other member", () =>
    Effect.gen(function* () {
      const { x } = yield* startMesh();
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      yield* x.membership.setSnapshot(snapshotFor(X, {}));

      const offline = yield* callTool(x, "agent-x", "t3_thread_configuration", {
        threadId: "thread:nowhere",
      });
      expect(offline).toMatchObject({ ok: false, code: "owner_not_found" });
      expect(!offline.ok && offline.message).toContain("box, vps");

      yield* x.membership.setSnapshot({ ...snapshotFor(X, {}), members: [member(X, true)] });
      const alone = yield* callTool(x, "agent-x", "t3_thread_configuration", {
        threadId: "thread:nowhere",
      });
      expect(alone).toMatchObject({ ok: false, code: "thread_not_found" });
    }).pipe(Effect.scoped),
  );

  it.effect("narrows modes to the caller, and refuses a read-only client before forwarding", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x", "approval-required"));
      clientCaller(x.state, "reader", "read-only");
      y.state.threads.set(ThreadId.make("thread:wide"), thread("thread:wide", "project:y"));

      const send = yield* callTool(x, "agent-x", "t3_thread_send", {
        threadId: "thread:wide",
        message: "Go.",
      });
      expect(send).toMatchObject({ ok: false, code: "runtime_mode_escalation_denied" });
      expect(!send.ok && send.message).toMatch(/^On box: /);

      const wait = yield* callTool(x, "agent-x", "t3_thread_wait", {
        threadId: "thread:wide",
        timeoutMs: 10,
      });
      expect(wait.ok).toBe(true);
      const [seen] = seenOn(y, "t3_thread_wait");
      expect(seen?.scope.mesh).toMatchObject({
        sourceEnvironmentId: X,
        modeLimit: { runtimeMode: "approval-required", interactionMode: "default" },
        source: { kind: "thread", threadId: "thread:x-caller" },
      });
      expect(seen?.scope.requestNamespace).toBe(`mesh:${X}`);

      const refused = yield* callTool(x, "reader", "t3_thread_send", {
        threadId: "thread:wide",
        message: "Go.",
      });
      expect(refused).toMatchObject({ ok: false, code: "capability_denied" });
      expect(seenOn(y, "t3_thread_wait")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a mesh call without a mode limit, and a token without its key", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      const issued = yield* y.auth
        .issueMeshMemberSession({ meshCaller: X, proofKeyThumbprint: x.key.thumbprint })
        .pipe(Effect.orDie);
      const limit = {
        [MESH_MODE_LIMIT_HEADER]: formatMeshModeLimit({
          runtimeMode: "auto",
          interactionMode: "default",
        }),
      };
      const signedBy = (key: ReturnType<typeof makeMeshKey>) => (url: string) =>
        key
          .proof({ method: "POST", url, token: issued.token })
          .pipe(Effect.map((dpop) => ({ authorization: `DPoP ${issued.token}`, dpop })));

      const admitted = yield* rawMeshInitialize(y, (url) =>
        signedBy(x.key)(url).pipe(Effect.map((headers) => ({ ...headers, ...limit }))),
      );
      expect(admitted.status).toBe(200);

      const noLimit = yield* rawMeshInitialize(y, signedBy(x.key));
      expect(noLimit.status).toBe(400);
      expect(noLimit.body).toContain("mesh_mode_limit_required");

      const thief = makeMeshKey();
      const stolen = yield* rawMeshInitialize(y, (url) =>
        signedBy(thief)(url).pipe(Effect.map((headers) => ({ ...headers, ...limit }))),
      );
      expect(stolen.status).toBe(401);

      const asBearer = yield* rawMeshInitialize(y, () =>
        Effect.succeed({ authorization: `Bearer ${issued.token}`, ...limit }),
      );
      expect(asBearer.status).toBe(401);
    }).pipe(Effect.scoped),
  );

  it.effect("a retried remote launch returns the same thread after a session renewal", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      x.state.projects.push(project("project:x", REPO));
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      y.state.projects.push(project("project:y-other", "github.com/t3/other"));
      y.state.projects.push(project("project:y", REPO));

      const launch = {
        machine: "box",
        clientRequestId: "launch-1",
        title: "Remote",
        message: "Hi",
      };
      const first = yield* callTool(x, "agent-x", "t3_thread_launch", launch);
      yield* x.renewSessions;
      const retry = yield* callTool(x, "agent-x", "t3_thread_launch", launch);

      expect(first).toMatchObject({ ok: true, value: { projectId: "project:y" } });
      expect(retry.ok && retry.value.threadId).toBe(first.ok && first.value.threadId);
      expect(y.state.launches.map((entry) => entry.commandId)).toEqual([
        y.state.launches[0]!.commandId,
        y.state.launches[0]!.commandId,
      ]);
      expect(y.state.launches[0]).toMatchObject({
        projectId: "project:y",
        modelSelection: { instanceId: codex, model: "gpt-5" },
        meshOrigin: { environmentId: X, threadId: "thread:x-caller" },
      });
      expect(x.state.launches).toHaveLength(0);

      const local = yield* callTool(x, "agent-x", "t3_thread_launch", {
        clientRequestId: "launch-1",
        title: "Local",
      });
      expect(local.ok && local.value.threadId).not.toBe(first.ok && first.value.threadId);
      expect(x.state.launches[0]?.meshOrigin).toBeUndefined();
      const localRetry = yield* callTool(x, "agent-x", "t3_thread_launch", {
        clientRequestId: "launch-1",
        title: "Local",
      });
      expect(localRetry.ok && localRetry.value.threadId).toBe(local.ok && local.value.threadId);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a remote launch with no matching project, naming candidates", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      x.state.projects.push(project("project:x", REPO));
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      y.state.projects.push(project("project:y-other", "github.com/t3/other"));

      const refused = yield* callTool(x, "agent-x", "t3_thread_launch", {
        machine: Y,
        title: "Remote",
      });
      expect(refused).toMatchObject({ ok: false, code: "invalid_request" });
      expect(!refused.ok && refused.message).toContain("project:y-other");

      y.state.projects.push(project("project:y-a", REPO), project("project:y-b", REPO));
      const ambiguous = yield* callTool(x, "agent-x", "t3_thread_launch", {
        machine: Y,
        title: "Remote",
      });
      expect(ambiguous).toMatchObject({ ok: false, code: "invalid_request" });
      for (const part of ["project:y-a", "/projects/project:y-a", "project:y-b"]) {
        expect(!ambiguous.ok && ambiguous.message).toContain(part);
      }

      const attachments = yield* callTool(x, "agent-x", "t3_thread_launch", {
        machine: Y,
        title: "Remote",
        attachments: [
          {
            type: "image",
            id: "pending-upload-a",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      });
      expect(attachments.ok).toBe(false);
      expect(y.state.launches).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("forwards a long wait in pieces of at most 50 s on the run it picked", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      y.state.threads.set(ThreadId.make("thread:busy"), thread("thread:busy", "project:y"));

      const wait = yield* callTool(x, "agent-x", "t3_thread_wait", {
        threadId: "thread:busy",
        timeoutMs: 120_000,
      });
      expect(wait).toMatchObject({ ok: true, value: { timedOut: true, runId: "run:latest" } });
      expect(seenOn(y, "t3_thread_wait").map(({ input }) => input)).toEqual([
        { threadId: "thread:busy", timeoutMs: 50_000 },
        { threadId: "thread:busy", runId: "run:latest", timeoutMs: 50_000 },
        { threadId: "thread:busy", runId: "run:latest", timeoutMs: 20_000 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect('lists projects on every machine for "all", with offline members marked', () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      x.state.projects.push(project("project:x", REPO));
      y.state.projects.push(project("project:y", REPO));

      const all = yield* callTool(x, "agent-x", "t3_project_list", { machine: "all" });
      expect(all).toMatchObject({
        ok: true,
        value: {
          sections: [
            {
              machine: { label: "laptop" },
              online: true,
              result: { projects: [{ id: "project:x" }] },
            },
            {
              machine: { label: "box" },
              online: true,
              result: { projects: [{ id: "project:y" }] },
            },
            { machine: { label: "vps" }, online: false },
          ],
        },
      });

      const plain = yield* callTool(x, "agent-x", "t3_project_list", {});
      expect(plain).toMatchObject({ ok: true, value: { projects: [{ id: "project:x" }] } });
    }).pipe(Effect.scoped),
  );

  it.effect("searches this repository on every machine and merges rows by score", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      x.state.projects.push(project("project:x", REPO));
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));
      y.state.projects.push(
        project("project:y", REPO),
        project("project:y-other", "github.com/t3/other"),
      );
      const row = (
        threadId: string,
        projectId: string,
        source: "title" | "user",
        score: number,
      ) => ({
        threadId: ThreadId.make(threadId),
        projectId: ProjectId.make(projectId),
        title: threadId,
        source,
        score,
        ...(source === "title" ? {} : { snippet: "…" }),
      });
      x.state.searchRows.push(
        row("x-title", "project:x", "title", 2),
        row("x-message", "project:x", "user", 1),
      );
      y.state.searchRows.push(
        row("y-title", "project:y", "title", 5),
        row("y-other-repo", "project:y-other", "title", 9),
      );

      const search = yield* callTool(x, "agent-x", "t3_thread_search", { query: "mesh" });
      expect(search.ok && search.value.matches).toEqual([
        expect.objectContaining({
          threadId: "y-title",
          machine: { environmentId: Y, label: "box" },
        }),
        expect.objectContaining({ threadId: "x-title" }),
        expect.objectContaining({ threadId: "x-message" }),
      ]);
      expect(search.ok && search.value).not.toHaveProperty("unansweredMachines");

      const all = yield* callTool(x, "agent-x", "t3_thread_search", {
        query: "mesh",
        machine: "all",
      });
      expect(all).toEqual(search);
    }).pipe(Effect.scoped),
  );

  it.effect("an inbound mesh call runs locally and never forwards again", () =>
    Effect.gen(function* () {
      const { x, y, z } = yield* startMesh();
      yield* y.membership.setSnapshot(snapshotFor(Y, { [X]: true, [Z]: true }));
      z.state.threads.set(ThreadId.make("thread:on-z"), thread("thread:on-z", "project:z"));
      const issued = yield* y.auth
        .issueMeshMemberSession({ meshCaller: X, proofKeyThumbprint: x.key.thumbprint })
        .pipe(Effect.orDie);

      // X calling Y the way MeshMcpClient does, for an id only Z has.
      const raw = yield* mcpToolSession({
        endpoint: `${y.baseUrl}/mcp`,
        clientName: "mesh-test",
        requestHeaders: ({ method, url }) =>
          x.key.proof({ method, url, token: issued.token }).pipe(
            Effect.map((dpop) => ({
              authorization: `DPoP ${issued.token}`,
              dpop,
              [MESH_MODE_LIMIT_HEADER]: "full-access/default",
            })),
          ),
      }).pipe(
        Effect.flatMap((session) =>
          session.call("t3_thread_configuration", { threadId: "thread:on-z" }),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      const result = yield* decodeToolResult(raw).pipe(Effect.orDie);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("thread_not_found");
    }).pipe(Effect.scoped),
  );
  it.effect("clones and registers a project on another machine, then launches there", () =>
    Effect.gen(function* () {
      const { x, y } = yield* startMesh();
      x.state.projects.push(project("project:x", REPO));
      threadCaller(x.state, "agent-x", thread("thread:x-caller", "project:x"));

      const clone = yield* callTool(x, "agent-x", "t3_project_clone", {
        machine: "box",
        repository: REPO,
        destinationPath: "/srv/app",
      });
      expect(clone).toMatchObject({ ok: true, value: { cwd: "/srv/app" } });
      const created = yield* callTool(x, "agent-x", "t3_project_create", {
        machine: "box",
        title: "app",
        workspaceRoot: "/srv/app",
      });
      expect(created).toMatchObject({ ok: true, value: { workspaceRoot: "/srv/app" } });
      expect(x.state.projects.map(({ id }) => id)).toEqual(["project:x"]);

      const launch = yield* callTool(x, "agent-x", "t3_thread_launch", {
        machine: "box",
        title: "Remote",
      });
      expect(launch.ok && launch.value.projectId).toBe(created.ok && created.value.id);
      expect(y.state.launches).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
