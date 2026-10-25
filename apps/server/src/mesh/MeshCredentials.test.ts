// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no Ed25519 key generation.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layerServer takes a Node server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MESH_GRANT_JWT_TYPE,
  MESH_GRANT_SCOPE,
  MESH_SESSION_PATH,
  type MeshMemberView,
  type ServerDirectEndpoint,
} from "@t3tools/contracts";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import { assert, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as NetAddress from "effect/net/NetAddress";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { TestClock } from "effect/testing";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MeshCredentials from "./MeshCredentials.ts";
import * as MeshMcpClient from "./MeshMcpClient.ts";
import * as MeshSessionHttp from "./MeshSessionHttp.ts";
import * as MeshServices from "./Services.ts";
import * as MeshTestkit from "./testkit.ts";

const RELAY_ISSUER = "https://relay.mesh.test";
const CLOUD_USER = "user_mesh";
const CALLER = EnvironmentId.make("env-caller");
const mintKey = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const encode = (value: string) => new TextEncoder().encode(value);

const layerServerEnvironment = Layer.effect(
  ServerEnvironment.ServerEnvironment,
  Effect.gen(function* () {
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    return ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: identity.getEnvironmentId,
      getDescriptor: Effect.die("unused"),
    });
  }),
);

/** The services of one member: its own database, secrets, identity, and settings. */
const layerMemberServices = (prefix: string) =>
  MeshSessionHttp.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        MeshTestkit.makeMembership({
          snapshot: {
            selfEnvironmentId: EnvironmentId.make("env-target"),
            members: [memberView(CALLER, [])],
            captain: null,
            pin: null,
          },
        }).pipe(Effect.map((membership) => membership.layer)),
      ),
    ),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(layerServerEnvironment),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

const listen = Effect.fn("test.listen")(function* (
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
) {
  const context = yield* Layer.build(
    NodeHttpServer.layerServer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
  );
  const server = Context.get(context, HttpServer.HttpServer);
  yield* server.serve(app);
  if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die("no TCP address");
  return `http://127.0.0.1:${server.address.port}/`;
});

const descriptorResponse = (environmentId: string) =>
  HttpServerResponse.jsonUnsafe({ environmentId });

const JsonRpcMessage = Schema.Struct({
  id: Schema.optional(Schema.String),
  method: Schema.String,
});
const decodeJsonRpcMessage = Schema.decodeUnknownEffect(JsonRpcMessage);

/** Just enough MCP for `mcpToolSession`: every tool answers `{ ok: true }` to a mesh session. */
const fakeMcp = (auth: EnvironmentAuth.EnvironmentAuth["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateMeshMember(request).pipe(Effect.option);
    if (Option.isNone(session)) return HttpServerResponse.empty({ status: 401 });
    if (request.method !== "POST") return HttpServerResponse.empty();
    const message = yield* request.json.pipe(Effect.flatMap(decodeJsonRpcMessage), Effect.orDie);
    if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
    return HttpServerResponse.jsonUnsafe({
      jsonrpc: "2.0",
      id: message.id,
      result:
        message.method === "tools/call"
          ? { content: [], structuredContent: { ok: true } }
          : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } },
    });
  });

/** Pipes TCP to `target`, like an address on a network; `die` drops it and every connection. */
const startTcpRelay = Effect.fn("test.startTcpRelay")(function* (target: string) {
  const { hostname, port } = new URL(target);
  const sockets = new Set<NodeNet.Socket>();
  let dead = false;
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const created = NodeNet.createServer((socket) => {
        if (dead) return socket.destroy();
        const upstream = NodeNet.connect(Number(port), hostname);
        for (const end of [socket, upstream]) {
          sockets.add(end);
          end.on("error", () => end.destroy());
          end.on("close", () => sockets.delete(end));
        }
        socket.pipe(upstream).pipe(socket);
      });
      created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
    }),
    (server) => Effect.sync(() => server.close()),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    die: Effect.sync(() => {
      dead = true;
      for (const socket of sockets) socket.destroy();
    }),
  };
});

/** A real member: the descriptor and `POST /api/mesh/session`, backed by its own auth. */
const startMember = Effect.fn("test.startMember")(function* (prefix: string) {
  const context = yield* Layer.build(layerMemberServices(prefix));
  const secrets = Context.get(context, ServerSecretStore.ServerSecretStore);
  yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, encode(mintKey.publicKey));
  yield* secrets.set(RELAY_ISSUER_SECRET, encode(RELAY_ISSUER));
  yield* secrets.set(CLOUD_LINKED_USER_ID, encode(CLOUD_USER));
  const environmentId = yield* Context.get(context, ServerEnvironment.ServerEnvironment)
    .getEnvironmentId;
  const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
  const app = yield* HttpRouter.toHttpEffect(
    Layer.mergeAll(
      HttpRouter.add("GET", "/.well-known/t3/environment", descriptorResponse(environmentId)),
      HttpRouter.add("*", "/mcp", fakeMcp(auth)),
      MeshSessionHttp.routeLayer,
    ),
  );
  const url = yield* listen(app.pipe(Effect.provide(context), Effect.orDie));
  return {
    environmentId,
    url,
    auth,
    sessions: Context.get(context, SessionStore.SessionStore),
    settings: Context.get(context, ServerSettings.ServerSettingsService),
  };
});
type Member = Effect.Success<ReturnType<typeof startMember>>;

/** Answers the descriptor as another environment and records every request it gets. */
const startImpostor = Effect.fn("test.startImpostor")(function* () {
  const requests: Array<string> = [];
  const url = yield* listen(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      requests.push(`${request.method} ${request.url}`);
      return descriptorResponse("env-someone-else");
    }),
  );
  return { url, requests };
});

const signGrant = Effect.fn("test.signGrant")(function* (input: {
  readonly targetEnvironmentId: EnvironmentId;
  readonly jkt: string;
}) {
  const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
  return yield* signRelayJwt({
    privateKey: mintKey.privateKey,
    typ: MESH_GRANT_JWT_TYPE,
    payload: {
      iss: RELAY_ISSUER,
      sub: CLOUD_USER,
      aud: input.targetEnvironmentId,
      meshCaller: CALLER,
      scope: MESH_GRANT_SCOPE,
      cnf: { jkt: input.jkt },
      jti: NodeCrypto.randomUUID(),
      iat,
      exp: iat + 60,
    },
  }).pipe(Effect.orDie);
});

const memberView = (
  environmentId: EnvironmentId,
  directEndpoints: ReadonlyArray<ServerDirectEndpoint>,
): MeshMemberView => ({
  environmentId,
  label: "box",
  machineKind: null,
  serverVersion: "1.0.0",
  online: true,
  capabilities: { meshMember: true },
  connectHostname: null,
  directEndpoints,
  captainEligible: false,
});

/** This machine's credentials, with a relay that grants anything to the caller. */
const startCaller = Effect.fn("test.startCaller")(function* (
  members: ReadonlyArray<MeshMemberView>,
) {
  const membership = yield* MeshTestkit.makeMembership({
    snapshot: { members, captain: null, pin: null, selfEnvironmentId: CALLER },
    requestGrant: signGrant,
  });
  const network = yield* Ref.make("192.168.1.20");
  const context = yield* Layer.build(
    MeshMcpClient.layer.pipe(
      Layer.provideMerge(MeshCredentials.layer),
      Layer.provide(membership.layer),
      Layer.provide(Layer.succeed(MeshCredentials.MeshNetworkFingerprint, Ref.get(network))),
      Layer.provideMerge(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mesh-caller-" })),
        ),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeServices.layer),
    ),
  );
  return {
    credentials: Context.get(context, MeshServices.MeshCredentials),
    mcp: Context.get(context, MeshServices.MeshMcpClient),
    secrets: Context.get(context, ServerSecretStore.ServerSecretStore),
    setNetwork: (fingerprint: string) => Ref.set(network, fingerprint),
  };
});

/** A request to `path` on the member, signed the way a mesh caller signs it. */
const memberRequest = Effect.fn("test.memberRequest")(function* (
  session: MeshServices.MeshSession,
  member: Member,
  path: string,
  scheme: "DPoP" | "Bearer" = "DPoP",
) {
  const url = new URL(path, member.url);
  const headers = yield* session.authorizationHeaders({ method: "GET", url: url.href });
  return {
    method: "GET",
    url: path,
    cookies: {},
    headers: {
      host: url.host,
      dpop: headers.dpop,
      authorization: `${scheme} ${session.token}`,
    },
  } as never;
});

const lan = (member: { readonly url: string }): ServerDirectEndpoint => ({
  kind: "lan",
  httpBaseUrl: member.url,
});

it.layer(NodeServices.layer)("MeshCredentials", (it) => {
  it.effect("aborts stalled session bodies, bounds the retry, and releases the member lock", () =>
    Effect.gen(function* () {
      const member = EnvironmentId.make("env-member");
      const reads = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const signals: Array<AbortSignal | null | undefined> = [];
      const { credentials } = yield* startCaller([
        memberView(member, [{ kind: "lan", httpBaseUrl: "https://member.mesh.test/" }]),
      ]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, async (_url, init) => {
          if (init?.method === "GET") return Response.json({ environmentId: member });
          const reading = reads[signals.length];
          signals.push(init?.signal);
          if (reading === undefined) {
            return Response.json({ token: "recovered", expiresAt: "2100-01-01T00:00:00.000Z" });
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"token":'));
                init?.signal?.addEventListener("abort", () =>
                  controller.error(new Error("aborted")),
                );
              },
              pull() {
                Deferred.doneUnsafe(reading, Effect.void);
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }),
      );
      const session = yield* credentials.session(member).pipe(Effect.flip, Effect.forkChild);
      for (const [index, reading] of reads.entries()) {
        yield* Deferred.await(reading);
        yield* TestClock.adjust("10 seconds");
        assert.isTrue(signals[index]?.aborted);
      }
      assert.strictEqual((yield* Fiber.join(session))._tag, "MeshMemberUnreachableError");
      assert.strictEqual((yield* credentials.session(member)).token, "recovered");
      assert.lengthOf(signals, 3);
    }),
  );

  it.effect("aborts a stalled descriptor body before sending a grant", () =>
    Effect.gen(function* () {
      const member = EnvironmentId.make("env-member");
      const reading = yield* Deferred.make<void>();
      let signal: AbortSignal | null | undefined;
      const { credentials } = yield* startCaller([
        memberView(member, [{ kind: "lan", httpBaseUrl: "https://member.mesh.test/" }]),
      ]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, async (_url, init) => {
          assert.strictEqual(init?.method, "GET");
          signal = init?.signal;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"environmentId":'));
                signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
              },
              pull() {
                Deferred.doneUnsafe(reading, Effect.void);
              },
            }),
          );
        }),
      );
      const route = yield* credentials.route(member).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(reading);
      yield* TestClock.adjust("2500 millis");
      assert.isTrue(signal?.aborted);
      assert.strictEqual((yield* Fiber.join(route))._tag, "MeshMemberUnreachableError");
    }),
  );

  it.effect("redeems a grant at the member for a session that only the mesh endpoints accept", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-member-redeem-");
      const { credentials } = yield* startCaller([memberView(member.environmentId, [lan(member)])]);

      const session = yield* credentials.session(member.environmentId);
      assert.deepStrictEqual(session.route, { kind: "lan", httpBaseUrl: member.url });

      const accepted = yield* member.auth.authenticateHttpRequest(
        yield* memberRequest(session, member, "/api/mesh/owns"),
      );
      assert.strictEqual(accepted.meshCaller, CALLER);
      assert.deepStrictEqual(accepted.scopes, ["orchestration:read"]);

      const onMcp = yield* member.auth.authenticateMeshMember(
        yield* memberRequest(session, member, "/mcp"),
      );
      assert.strictEqual(onMcp.meshCaller, CALLER);
      const onVia = yield* Effect.flip(
        member.auth.authenticateMeshMember(yield* memberRequest(session, member, "/api/mesh/via")),
      );
      assert.strictEqual(onVia._tag, "ServerAuthInvalidCredentialError");

      const otherApi = yield* Effect.flip(
        member.auth.authenticateHttpRequest(
          yield* memberRequest(session, member, "/api/orchestration/threads"),
        ),
      );
      assert.strictEqual(otherApi._tag, "ServerAuthInvalidCredentialError");
      const socket = yield* Effect.flip(
        member.auth.authenticateWebSocketUpgrade(
          yield* memberRequest(session, member, "/ws"),
          "rpc",
        ),
      );
      assert.strictEqual(socket._tag, "ServerAuthInvalidCredentialError");
      const mcp = yield* Effect.flip(
        member.auth.authenticateMcpClient(yield* memberRequest(session, member, "/mcp", "Bearer")),
      );
      assert.strictEqual(mcp._tag, "ServerAuthInvalidCredentialError");

      // Hidden from the owner's session list and from "revoke other sessions".
      const listed = yield* member.auth.listSessions();
      assert.isFalse(listed.some((entry) => SessionStore.isMeshMemberSubject(entry.subject)));
      const owner = yield* member.auth.issueSession({ label: "owner" });
      yield* member.auth.revokeOtherSessionsExcept(owner.sessionId);
      const stillValid = yield* member.sessions.verify(session.token);
      assert.strictEqual(stillValid.meshCaller, CALLER);
    }),
  );

  it.effect("sends no credential to an address that answers as another environment", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-member-identity-");
      const impostor = yield* startImpostor();
      const { credentials } = yield* startCaller([
        memberView(member.environmentId, [
          lan(impostor),
          { kind: "tailnet", httpBaseUrl: member.url },
        ]),
      ]);

      const session = yield* credentials.session(member.environmentId);
      assert.deepStrictEqual(session.route, { kind: "tailnet", httpBaseUrl: member.url });
      assert.deepStrictEqual(impostor.requests, ["GET /.well-known/t3/environment"]);
      expect(impostor.requests).not.toContain(`POST ${MESH_SESSION_PATH}`);
    }),
  );

  it.effect(
    "reuses the session for 30 minutes, then renews it and the member revokes the old one",
    () =>
      Effect.gen(function* () {
        const member = yield* startMember("t3-mesh-member-renew-");
        const { credentials } = yield* startCaller([
          memberView(member.environmentId, [lan(member)]),
        ]);

        const first = yield* credentials.session(member.environmentId);
        yield* TestClock.adjust("29 minutes");
        assert.strictEqual((yield* credentials.session(member.environmentId)).token, first.token);

        yield* TestClock.adjust("2 minutes");
        const renewed = yield* credentials.session(member.environmentId);
        assert.notStrictEqual(renewed.token, first.token);
        const old = yield* Effect.flip(member.sessions.verify(first.token));
        assert.strictEqual(old._tag, "SessionTokenRevokedError");
        assert.strictEqual((yield* member.sessions.verify(renewed.token)).meshCaller, CALLER);
        assert.deepStrictEqual(yield* credentials.cachedSessions, [
          {
            environmentId: member.environmentId,
            route: renewed.route,
            expiresAt: renewed.expiresAt,
          },
        ]);
      }),
  );

  it.effect("a member that left revokes every mesh session and refuses new grants", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-member-leave-");
      const { credentials } = yield* startCaller([memberView(member.environmentId, [lan(member)])]);
      const session = yield* credentials.session(member.environmentId);

      // What leaving does on the member (MeshMembership.setEnabled(false)).
      yield* member.settings.updateSettings({ meshEnabled: false });
      yield* member.auth.revokeMeshMemberSessions();

      const revoked = yield* Effect.flip(member.sessions.verify(session.token));
      assert.strictEqual(revoked._tag, "SessionTokenRevokedError");
      yield* credentials.invalidate(member.environmentId);
      const refused = yield* Effect.flip(credentials.session(member.environmentId));
      assert.deepStrictEqual(
        refused,
        new MeshServices.MeshSessionRefusedError({
          environmentId: member.environmentId,
          status: 403,
        }),
      );
    }),
  );

  it.effect("makes its mesh key on the first session, not when it starts", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-member-key-");
      const { credentials, secrets } = yield* startCaller([
        memberView(member.environmentId, [lan(member)]),
      ]);
      assert.isTrue(Option.isNone(yield* secrets.get("mesh-dpop-p256-key")));
      yield* credentials.session(member.environmentId);
      assert.isTrue(Option.isSome(yield* secrets.get("mesh-dpop-p256-key")));
    }),
  );

  it.effect("walks the routes again after the chosen one stops answering", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-member-fallback-");
      const lanAddress = yield* startTcpRelay(member.url);
      const tailnet = { kind: "tailnet", httpBaseUrl: member.url } as const;
      const { credentials, mcp } = yield* startCaller([
        memberView(member.environmentId, [lan(lanAddress), tailnet]),
      ]);
      const call = mcp.callTool(
        member.environmentId,
        "t3_thread_read",
        {},
        { modeLimit: { runtimeMode: "full-access", interactionMode: "default" } },
      );

      assert.deepStrictEqual(yield* call, { ok: true });
      const [first] = yield* credentials.cachedSessions;
      assert.strictEqual(first?.route.kind, "lan");

      // The LAN address dies while the member still advertises it.
      yield* lanAddress.die;
      const failed = yield* call.pipe(
        Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "answered" }),
      );
      assert.strictEqual(failed, "MeshMemberUnreachableError");
      assert.deepStrictEqual(yield* call, { ok: true });
      const [after] = yield* credentials.cachedSessions;
      assert.deepStrictEqual(after?.route, tailnet);
    }),
  );

  it.effect("walks the routes again once this machine's network changes", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-member-network-");
      const lanAddress = yield* startTcpRelay(member.url);
      const tailnet = { kind: "tailnet", httpBaseUrl: member.url } as const;
      const { credentials, setNetwork } = yield* startCaller([
        memberView(member.environmentId, [lan(lanAddress), tailnet]),
      ]);
      assert.isTrue(Option.isNone(yield* credentials.cachedRoute(member.environmentId)));
      const initialRoute = yield* credentials.route(member.environmentId);
      assert.strictEqual(initialRoute.kind, "lan");
      assert.strictEqual(
        Option.getOrThrow(yield* credentials.cachedRoute(member.environmentId)),
        initialRoute,
      );

      // This machine joined another network, where the LAN address reaches nothing.
      yield* lanAddress.die;
      yield* setNetwork("10.0.0.7");
      assert.strictEqual((yield* credentials.route(member.environmentId)).kind, "lan");
      yield* TestClock.adjust("10 seconds");
      assert.deepStrictEqual(yield* credentials.route(member.environmentId), tailnet);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* credentials.cachedRoute(member.environmentId)),
        tailnet,
      );
    }),
  );
});
