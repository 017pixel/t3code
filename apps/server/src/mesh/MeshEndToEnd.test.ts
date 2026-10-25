// @effect-diagnostics nodeBuiltinImport:off - real member servers, the relay mint key, and ES256 DPoP keys need Node HTTP and crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type HostPowerSnapshot,
  MESH_VIA_PATH,
  MeshCloseCode,
  type MeshSnapshot,
  meshViaBasePath,
  NodeId,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import { computeDpopAccessTokenHash, computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NetAddress from "effect/net/NetAddress";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as ConnectReachability from "../cloud/ConnectReachability.ts";
import * as CloudManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../mcp/ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as ProjectHandlers from "../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadHandlers from "../mcp/toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MeshForwarding from "./MeshForwarding.ts";
import * as MeshForwardingAuth from "./MeshForwardingAuth.ts";
import { meshRelayCredential, startMeshRelay } from "./MeshRelay.testkit.ts";
import * as MeshServer from "./MeshServer.ts";
import * as MeshServices from "./Services.ts";
import {
  completeRun,
  layerOrchestration,
  modelSelection,
  readTask,
  seedParent,
  seedRunningThread,
} from "./RemoteDelegation.testkit.ts";

const RELAY_ISSUER = "https://relay.mesh.test";
const CLOUD_USER = "user_mesh";
const mintKey = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

interface MachineSpec {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** What cloudflared reports for the managed tunnel; the relay builds the Connect URL from it. */
  readonly connectHostname: string;
  /** Only a member whose tunnel answers can be captain. */
  readonly tunnelReady: boolean;
}

const LAPTOP: MachineSpec = {
  environmentId: EnvironmentId.make("environment:laptop"),
  label: "laptop",
  connectHostname: "laptop.connect.invalid",
  tunnelReady: false,
};
const BOX: MachineSpec = {
  environmentId: EnvironmentId.make("environment:box"),
  label: "box",
  connectHostname: "box.connect.invalid",
  tunnelReady: false,
};
const CAPTAIN: MachineSpec = {
  environmentId: EnvironmentId.make("environment:captain"),
  label: "captain",
  connectHostname: "captain.connect.invalid",
  tunnelReady: true,
};

/** The relay's managed endpoint URL for a tunnel hostname, as client bootstraps carry it. */
const connectUrl = (spec: MachineSpec) => `https://${spec.connectHostname}`;

const power: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "unknown",
  stale: false,
  updatedAt: DateTime.makeUnsafe(0),
};

const descriptorOf = (spec: MachineSpec): ExecutionEnvironmentDescriptor => ({
  environmentId: spec.environmentId,
  label: spec.label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.2.3",
  capabilities: {
    repositoryIdentity: true,
    meshMember: true,
    meshAgents: true,
    meshGateway: true,
  },
});

/** An ES256 key that signs a fresh DPoP proof per request, as a client or member does. */
const makeDpopKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
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

type SeededThread = Effect.Success<ReturnType<typeof seedRunningThread>>;

/**
 * Launches create a real thread here with a running turn, standing in for the provider. The
 * thread keeps the launch's `meshOrigin`; a retried launch returns the thread it already made.
 */
const layerSeededLaunches = (seeded: Map<ThreadId, SeededThread>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const context = yield* Effect.context<Orchestrator.OrchestratorV2 | EventSink.EventSinkV2>();
      const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);
      return Layer.mock(ThreadLaunch.ThreadLaunchService)({
        checkWorktreeBase: () => Effect.void,
        launch: (input) =>
          Effect.gen(function* () {
            const threadId = input.threadId ?? ThreadId.make(input.commandId);
            const resumed = seeded.has(threadId);
            if (!resumed) {
              const thread = yield* seedRunningThread({
                name: threadId,
                threadId,
                projectId: input.projectId,
                title: input.title,
                ...(input.initialMessage === undefined
                  ? {}
                  : { userMessageId: input.initialMessage.messageId }),
                ...(input.meshOrigin === undefined ? {} : { meshOrigin: input.meshOrigin }),
              });
              seeded.set(threadId, thread);
            }
            return {
              threadId,
              projection: yield* orchestrator.getThreadProjection(threadId),
              resumed,
            };
          }).pipe(Effect.provide(context), Effect.orDie),
      });
    }),
  );

/** A route standing in for any member API a client calls: it names the session it accepted. */
const layerWhoamiRoute = HttpRouter.add(
  "GET",
  "/api/test/whoami",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* environmentAuth.authenticateHttpRequest(request).pipe(
      Effect.map((session) => HttpServerResponse.text(session.subject)),
      Effect.orElseSucceed(() => HttpServerResponse.text("unauthorized", { status: 401 })),
    );
  }),
);

/**
 * One machine: its own database and orchestrator, auth, secrets, real mesh services on the relay,
 * real `/mcp` with the orchestrator, thread and project tools, and the mesh routes, on a real port.
 */
const startMachine = Effect.fn("test.startMachine")(function* (
  spec: MachineSpec,
  relayUrl: string,
) {
  // The listener first, so the hello can name this machine's LAN address.
  const listener = yield* Layer.build(
    NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
  );
  const address = Context.get(listener, HttpServer.HttpServer).address;
  if (!NetAddress.isInetAddress(address)) return yield* Effect.die("expected a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const domain = yield* Layer.build(layerOrchestration);
  const base = yield* Layer.build(
    EnvironmentAuth.layer.pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: `t3-mesh-e2e-${spec.label}-` }),
      ),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(spec.environmentId),
        }),
      ),
      Layer.provideMerge(PlatformNodeCrypto.layer),
      Layer.provide(Layer.succeedContext(domain)),
    ),
  );
  const secrets = Context.get(base, ServerSecretStore.ServerSecretStore);
  const encode = (value: string) => new TextEncoder().encode(value);
  yield* secrets.set(RELAY_URL_SECRET, encode(relayUrl));
  yield* secrets.set(RELAY_ISSUER_SECRET, encode(RELAY_ISSUER));
  yield* secrets.set(
    RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
    encode(meshRelayCredential(spec.environmentId)),
  );
  yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, encode(mintKey.publicKey));
  yield* secrets.set(CLOUD_LINKED_USER_ID, encode(CLOUD_USER));

  // Leaving the mesh is a settings change, so mesh settings stream their changes.
  // A default model lets a mesh caller, which has no thread of its own here, launch threads.
  const settingsRef = yield* SubscriptionRef.make<ServerSettingsValue>({
    ...DEFAULT_SERVER_SETTINGS,
    defaultModelSelection: modelSelection,
  });
  const settingsChanges = SubscriptionRef.changes(settingsRef).pipe(Stream.drop(1));
  const agents = new Map<string, McpInvocationContext.McpThreadInvocationScope>();
  const seeded = new Map<ThreadId, SeededThread>();

  const layerMachine = Layer.mergeAll(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: SubscriptionRef.get(settingsRef),
      updateSettings: (patch) =>
        SubscriptionRef.updateAndGet(settingsRef, (current) =>
          applyServerSettingsPatch(current, patch),
        ),
      streamChanges: settingsChanges,
      subscribeChanges: Effect.succeed(settingsChanges),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(spec.environmentId),
      getDescriptor: Effect.succeed(descriptorOf(spec)),
    }),
    Layer.mock(HostPowerMonitor.HostPowerMonitor)({
      snapshot: Effect.succeed(power),
      streamChanges: Stream.never,
    }),
    Layer.mock(ConnectReachability.ConnectReachability)({
      latest: spec.tunnelReady
        ? Effect.succeedSome({
            status: "reachable",
            checkedAt: "2026-10-24T12:00:00.000Z",
            readyConnections: 1,
            protocol: "http2",
          })
        : Effect.succeedNone,
    }),
    Layer.mock(CloudManagedEndpointRuntime.CloudManagedEndpointRuntime)({
      inspectConnector: Effect.succeed({
        readyConnections: 1,
        hostname: spec.connectHostname,
        protocol: "http2",
      }),
      readinessChanged: Stream.never,
    }),
    Layer.mock(DirectEndpoints.DirectEndpoints)({
      resolve: () => Effect.succeed([{ kind: "lan", httpBaseUrl: `${baseUrl}/` }]),
    }),
    Layer.mock(CloudLink.CloudLink)({ linkChanges: Stream.never }),
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: (token) => Effect.succeed(agents.get(token)),
    }),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    ThreadSearch.layer,
    layerSeededLaunches(seeded),
    FetchHttpClient.layer,
  );

  const layerApp = Layer.mergeAll(
    McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
    McpHttpServer.toolkitRegistration(ThreadToolkit, ThreadHandlers.layer),
    McpHttpServer.toolkitRegistration(ProjectToolkit, ProjectHandlers.layer),
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerMcpTransport),
    Layer.merge(MeshServer.layerRoutes),
    Layer.merge(
      HttpRouter.add(
        "GET",
        "/.well-known/t3/environment",
        HttpServerResponse.jsonUnsafe({ environmentId: spec.environmentId }),
      ),
    ),
    Layer.merge(layerWhoamiRoute),
    // As server.ts wires them: the MCP server reads the mesh services built above it.
    Layer.provide(MeshForwardingAuth.layerMcpMeshAuthenticator),
    Layer.provide(MeshForwarding.layerWhenMeshAvailable),
    Layer.provide(OrchestratorMcpService.layer),
  );

  const app = yield* Layer.build(
    HttpRouter.serve(layerApp, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(MeshServer.layer),
      Layer.provideMerge(layerMachine),
      Layer.provide(Layer.succeedContext(Context.merge(domain, base))),
      Layer.provide(Layer.succeedContext(listener)),
    ),
  );
  const context = Context.merge(Context.merge(domain, base), app);
  return {
    spec,
    baseUrl,
    agents,
    seeded,
    auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
    sessions: Context.get(context, SessionStore.SessionStore),
    membership: Context.get(context, MeshServices.MeshMembership),
    credentials: Context.get(context, MeshServices.MeshCredentials),
    orchestrator: Context.get(context, Orchestrator.OrchestratorV2),
    projects: Context.get(context, ProjectService.ProjectService),
    /** Runs `effect` against this machine's services, as its own code would. */
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layerOrchestration>>) =>
      effect.pipe(Effect.provide(domain)),
  };
});
type Machine = Effect.Success<ReturnType<typeof startMachine>>;

const firstSnapshotWhere = (machine: Machine, predicate: (snapshot: MeshSnapshot) => boolean) =>
  machine.membership.snapshots.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const allOnline = (snapshot: MeshSnapshot) =>
  snapshot.members.length === 3 &&
  snapshot.members.every((member) => member.online) &&
  snapshot.captain === CAPTAIN.environmentId;

/**
 * Three machines on one relay running the relay's own mesh object, which picks the only member
 * with a ready tunnel as captain, each having seen the others join.
 */
const startMesh = Effect.fn("test.startMesh")(function* () {
  const relay = yield* startMeshRelay({
    issuer: RELAY_ISSUER,
    cloudUserId: CLOUD_USER,
    mintPrivateKey: mintKey.privateKey,
  });
  const laptop = yield* startMachine(LAPTOP, relay.url);
  const box = yield* startMachine(BOX, relay.url);
  const captain = yield* startMachine(CAPTAIN, relay.url);
  for (const machine of [laptop, box, captain]) {
    yield* firstSnapshotWhere(machine, allOnline);
  }
  return { relay, laptop, box, captain };
});

/** An agent thread on `machine` whose turn is running, reachable by `token` on its `/mcp`. */
const seedAgent = Effect.fn("test.seedAgent")(function* (machine: Machine, token: string) {
  const parent = yield* machine.run(seedParent(`agent-${machine.spec.label}`));
  machine.agents.set(token, {
    environmentId: machine.spec.environmentId,
    requestNamespace: `provider-session:${token}`,
    thread: {
      threadId: parent.threadId,
      providerSessionId: token,
      providerInstanceId: modelSelection.instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
    issuedAt: 0,
  });
  return parent;
});

/** A checkout of the agent's repository on `machine`. */
const seedProject = (machine: Machine, name: string) =>
  machine.projects.create({
    commandId: CommandId.make(`command:${name}:project`),
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    workspaceRoot: `/srv/${name}`,
  });

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

/** An agent on `machine` calling its own `/mcp`; fails the test on a tool error. */
const callTool = Effect.fn("test.callTool")(function* (
  machine: Machine,
  token: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const raw = yield* mcpToolSession({
    endpoint: `${machine.baseUrl}/mcp`,
    authorization: `Bearer ${token}`,
    clientName: "mesh-e2e",
  }).pipe(
    Effect.flatMap((session) => session.call(tool, args)),
    Effect.scoped,
    Effect.orDie,
  );
  const result = yield* decodeToolResult(raw).pipe(Effect.orDie);
  if (result.isError === true) {
    return yield* Effect.die(`${tool} failed: ${result.content[0]?.text ?? "no detail"}`);
  }
  return result.structuredContent as Record<string, unknown>;
});

const send = Effect.fn("test.send")(function* (request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(Effect.orDie);
  return { status: response.status, text: yield* response.text.pipe(Effect.orDie) };
}, Effect.provide(FetchHttpClient.layer));

/** A Connect sign-in on `machine`: the `cloud-connect` session a relay bootstrap exchanges for. */
const connectSession = Effect.fn("test.connectSession")(function* (
  machine: Machine,
  key: ReturnType<typeof makeDpopKey>,
) {
  const link = yield* machine.auth.createPairingLink({
    scopes: AuthStandardClientScopes,
    subject: EnvironmentAuth.cloudConnectBootstrapSubject(CLOUD_USER),
    proofKeyThumbprint: key.thumbprint,
  });
  const exchanged = yield* machine.auth.exchangeBootstrapCredentialForAccessToken(
    link.credential,
    undefined,
    { deviceType: "mobile", os: "iOS", browser: "T3 Code", ipAddress: "192.168.1.40" },
    { proofKeyThumbprint: key.thumbprint },
  );
  return exchanged.access_token;
});

describe("mesh v1 end to end", () => {
  it.effect("an agent on one machine launches, reads, searches and delegates on another", () =>
    Effect.gen(function* () {
      const { laptop, box } = yield* startMesh();
      const parent = yield* seedAgent(laptop, "agent-laptop");
      yield* seedProject(box, "box-app");

      // Grant and redeem: the relay grants laptop a session on box, redeemed directly at box.
      const session = yield* laptop.credentials.session(BOX.environmentId);
      expect(session.route).toEqual({ kind: "lan", httpBaseUrl: `${box.baseUrl}/` });
      expect(session.connectUrl).toBe(`${connectUrl(BOX)}/`);
      expect((yield* box.sessions.verify(session.token)).meshCaller).toBe(LAPTOP.environmentId);

      const launched = yield* callTool(laptop, "agent-laptop", "t3_thread_launch", {
        machine: "box",
        clientRequestId: "launch-1",
        title: "Mesh check",
        message: "Check the mesh.",
      });
      const remoteThreadId = ThreadId.make(String(launched.threadId));
      expect(launched.projectId).toBe("project:box-app");
      const shell = yield* box.orchestrator.getThreadShell(remoteThreadId);
      expect(shell?.meshOrigin).toEqual({
        environmentId: LAPTOP.environmentId,
        threadId: parent.threadId,
      });
      expect(yield* laptop.orchestrator.getThreadShell(remoteThreadId)).toBeNull();

      const read = yield* callTool(laptop, "agent-laptop", "t3_thread_read", {
        threadId: remoteThreadId,
      });
      expect(JSON.stringify(read)).toContain(remoteThreadId);

      const search = yield* callTool(laptop, "agent-laptop", "t3_thread_search", {
        query: "Mesh check",
      });
      expect(search.matches).toContainEqual(
        expect.objectContaining({
          threadId: remoteThreadId,
          machine: { environmentId: BOX.environmentId, label: "box" },
        }),
      );

      const delegated = yield* callTool(laptop, "agent-laptop", "delegate_task", {
        task: "Run the suite on the box.",
        machine: "box",
      });
      expect(delegated).toMatchObject({
        childEnvironmentId: BOX.environmentId,
        status: "running",
      });
      const taskId = String(delegated.taskId);
      const child = box.seeded.get(ThreadId.make(String(delegated.childThreadId)));
      if (child === undefined) return yield* Effect.die("the task's thread is not on box");

      // The provider's turn ends on box; laptop's follower reads it and completes the task.
      const afterSequence = yield* laptop.orchestrator.getThreadEventSequence(parent.threadId);
      yield* box.run(completeRun(child, "All 412 tests pass."));
      yield* laptop.orchestrator
        .streamStoredEventsFrom({
          threadId: parent.threadId,
          afterSequence,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === taskId &&
              stored.event.payload.status === "completed",
          ),
          Stream.runHead,
        );
      const { task, runs } = yield* laptop.run(readTask(parent.threadId, NodeId.make(taskId)));
      expect(task.result).toBe("All 412 tests pass.");
      expect(task.completionDelivery?.state).toBe("claimed");
      expect(
        runs.find((run) => run.id === parent.runId)?.delegatedCompletion?.delivery?.taskIds,
      ).toEqual([taskId]);
    }).pipe(Effect.scoped),
  );

  it.effect("a client reaches a member through the captain with a proof for its Connect URL", () =>
    Effect.gen(function* () {
      const { box, captain } = yield* startMesh();
      const client = makeDpopKey();
      const captainToken = yield* connectSession(captain, client);
      const boxToken = yield* connectSession(box, client);

      const mintUrl = `${captain.baseUrl}${MESH_VIA_PATH}`;
      const minted = yield* send(
        HttpClientRequest.post(mintUrl).pipe(
          HttpClientRequest.setHeaders({
            authorization: `DPoP ${captainToken}`,
            dpop: yield* client.proof({ method: "POST", url: mintUrl, token: captainToken }),
          }),
        ),
      );
      expect(minted.status).toBe(200);
      const via = JSON.parse(minted.text) as { handle: string; routes: Array<string> };
      expect(via.routes).toContain(BOX.environmentId);

      const whoami = (signedFor: string) =>
        Effect.gen(function* () {
          return yield* send(
            HttpClientRequest.get(
              `${captain.baseUrl}${meshViaBasePath(via.handle, BOX.environmentId)}/api/test/whoami`,
            ).pipe(
              HttpClientRequest.setHeaders({
                authorization: `DPoP ${boxToken}`,
                dpop: yield* client.proof({
                  method: "GET",
                  url: `${signedFor}/api/test/whoami`,
                  token: boxToken,
                }),
              }),
            ),
          );
        });
      // The captain reaches box over LAN and sends box's Connect hostname as Host, so a proof
      // for the Connect URL from the client's bootstrap verifies at box.
      expect(yield* whoami(connectUrl(BOX))).toEqual({ status: 200, text: "cloud-connect" });
      expect((yield* whoami(captain.baseUrl)).status).toBe(401);
    }).pipe(Effect.scoped),
  );

  it.effect("leaving the mesh revokes mesh sessions on every member", () =>
    Effect.gen(function* () {
      const { relay, laptop, box, captain } = yield* startMesh();
      const laptopOnBox = yield* laptop.credentials.session(BOX.environmentId);
      const boxOnLaptop = yield* box.credentials.session(LAPTOP.environmentId);
      const captainOnLaptop = yield* captain.credentials.session(LAPTOP.environmentId);

      const closes = yield* relay.subscribeCloses;
      yield* laptop.membership.setEnabled(false);
      // The relay removes a member that closes with `left` at once, with no grace.
      expect(yield* PubSub.take(closes)).toEqual({
        environmentId: LAPTOP.environmentId,
        code: MeshCloseCode.left,
      });
      expect((yield* relay.view).members.map((member) => member.environmentId)).toEqual([
        BOX.environmentId,
        CAPTAIN.environmentId,
      ]);
      for (const machine of [box, captain]) {
        yield* firstSnapshotWhere(machine, (snapshot) =>
          snapshot.members.every((member) => member.environmentId !== LAPTOP.environmentId),
        );
      }

      const revoked = (sessions: SessionStore.SessionStore["Service"], token: string) =>
        sessions.verify(token).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
      expect(yield* revoked(box.sessions, laptopOnBox.token)).toBe("SessionTokenRevokedError");
      expect(yield* revoked(laptop.sessions, boxOnLaptop.token)).toBe("SessionTokenRevokedError");
      expect(yield* revoked(laptop.sessions, captainOnLaptop.token)).toBe(
        "SessionTokenRevokedError",
      );
    }).pipe(Effect.scoped),
  );
});
