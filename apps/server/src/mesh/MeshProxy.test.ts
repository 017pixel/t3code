// @effect-diagnostics nodeBuiltinImport:off -- the member fixtures are plain Node servers.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type MeshMemberView,
  type MeshRoute,
  type MeshSnapshot,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { TestClock } from "effect/testing";
import { WebSocket, WebSocketServer } from "ws";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MeshProxy from "./MeshProxy.ts";
import * as MeshServices from "./Services.ts";
import * as MeshTestkit from "./testkit.ts";

const SELF = EnvironmentId.make("env-captain");
const MEMBER = EnvironmentId.make("env-member");
const OTHER = EnvironmentId.make("env-other");
const MEMBER_HOST = "member.connect.test";

const memberView = (
  environmentId: EnvironmentId,
  overrides: Partial<MeshMemberView> = {},
): MeshMemberView => ({
  environmentId,
  label: environmentId,
  machineKind: null,
  serverVersion: "0.0.0-test",
  online: true,
  capabilities: { meshMember: true, meshGateway: true },
  connectHostname: environmentId === MEMBER ? MEMBER_HOST : `${environmentId}.connect.test`,
  directEndpoints: [],
  captainEligible: true,
  ...overrides,
});

const meshSnapshot = (
  captain: EnvironmentId | null,
  members: ReadonlyArray<MeshMemberView> = [memberView(SELF), memberView(MEMBER)],
): MeshSnapshot => ({ members, captain, pin: null, selfEnvironmentId: SELF });

const encodeText = (value: string) => new TextEncoder().encode(value);

const layerAuth = (prefix: string) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
  );

/** Settings whose change stream the test drives, as persisting `mesh.enabled` would. */
const makeSettings = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  return {
    layer: Layer.succeed(ServerSettings.ServerSettingsService, {
      streamChanges: Stream.fromPubSub(changes),
    } as unknown as ServerSettings.ServerSettingsService["Service"]),
    changed: PubSub.publish(changes, DEFAULT_SERVER_SETTINGS),
  };
});

/** A Connect link whose changes the test announces, as linking or unlinking would. */
const makeLink = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  return {
    layer: Layer.mock(CloudLink.CloudLink)({ linkChanges: Stream.fromPubSub(changes) }),
    changed: PubSub.publish(changes, undefined),
  };
});

/** Credentials whose route to each member the test sets; route calls and drops are recorded. */
const makeRoutes = Effect.gen(function* () {
  const routes = yield* Ref.make(new Map<EnvironmentId, MeshRoute>());
  const calls = yield* Queue.unbounded<EnvironmentId>();
  const forgotten = yield* Queue.unbounded<EnvironmentId>();
  const route: MeshServices.MeshCredentials["Service"]["route"] = (environmentId) =>
    Queue.offer(calls, environmentId).pipe(
      Effect.andThen(Ref.get(routes)),
      Effect.flatMap((current) => {
        const found = current.get(environmentId);
        return found === undefined
          ? Effect.fail(new MeshServices.MeshMemberUnreachableError({ environmentId }))
          : Effect.succeed(found);
      }),
    );
  return {
    layer: MeshTestkit.layerCredentials({
      route,
      cachedRoute: (environmentId) =>
        Ref.get(routes).pipe(
          Effect.map((current) => Option.fromNullishOr(current.get(environmentId))),
        ),
      forgetRoute: (environmentId) => Queue.offer(forgotten, environmentId),
    }),
    calls,
    forgotten,
    set: (environmentId: EnvironmentId, httpBaseUrl: string, kind: MeshRoute["kind"] = "lan") =>
      Ref.update(routes, (current) => new Map(current).set(environmentId, { kind, httpBaseUrl })),
  };
});

/** The test server's port on IPv4 loopback, which the `send` helper can split. */
const loopbackOrigin = (context: Context.Context<HttpServer.HttpServer>) => {
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (!("port" in address)) throw new Error("expected a TCP server");
  return `http://127.0.0.1:${address.port}`;
};

const startCaptain = Effect.fn("MeshProxyTest.startCaptain")(function* (
  snapshot: MeshSnapshot = meshSnapshot(SELF),
) {
  const membership = yield* MeshTestkit.makeMembership({ snapshot });
  const routes = yield* makeRoutes;
  const settings = yield* makeSettings;
  const link = yield* makeLink;
  const context = yield* Layer.build(
    HttpRouter.serve(MeshProxy.layerRoutes.pipe(Layer.provide(ServerHttp.layerHttpCompression)), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(MeshProxy.layer),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(membership.layer),
      Layer.provide(routes.layer),
      Layer.provide(settings.layer),
      Layer.provide(link.layer),
      Layer.provideMerge(layerAuth("t3-mesh-captain-test-")),
    ),
  );
  yield* Context.get(context, ServerSecretStore.ServerSecretStore).set(
    CLOUD_LINKED_USER_ID,
    encodeText("user-1"),
  );
  const origin = loopbackOrigin(context);
  const proxy = Context.get(context, MeshProxy.MeshProxy);
  const secrets = Context.get(context, ServerSecretStore.ServerSecretStore);
  const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
  const mint = proxy.mintVia({ subject: "cloud-connect" });
  return {
    origin,
    wsOrigin: origin.replace(/^http/, "ws"),
    membership,
    routes,
    settings,
    link,
    secrets,
    proxy,
    auth,
    via: (handle: string, environmentId: EnvironmentId = MEMBER) =>
      `${origin}/api/mesh/via/${handle}/${environmentId}`,
    mint,
  };
});

interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

/** A plain member: records requests, serves an asset and a large JSON body, echoes sockets. */
const startRawMember = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly server: NodeHttp.Server;
        readonly sockets: WebSocketServer;
        readonly requests: Array<RecordedRequest>;
        readonly connections: Array<{
          readonly request: NodeHttp.IncomingMessage;
          readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
        }>;
        readonly origin: string;
      }>((resolve) => {
        const requests: Array<RecordedRequest> = [];
        const connections: Array<{
          readonly request: NodeHttp.IncomingMessage;
          readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
        }> = [];
        const server = NodeHttp.createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const body = Buffer.concat(chunks);
            requests.push({
              method: request.method,
              url: request.url,
              headers: request.headers,
              body,
            });
            if (request.url?.startsWith("/api/assets/")) {
              response.writeHead(200, { "content-type": "image/png", "set-cookie": "member=1" });
              response.end(PNG);
              return;
            }
            response.writeHead(201, {
              "content-type": "application/json",
              "set-cookie": "member=1",
              "x-member": "yes",
            });
            response.end(
              JSON.stringify({
                length: body.length,
                sha256: NodeCrypto.createHash("sha256").update(body).digest("hex"),
                padding: "x".repeat(4096),
              }),
            );
          });
        });
        const sockets = new WebSocketServer({
          server,
          verifyClient: (info, callback) =>
            info.req.url?.startsWith("/api/refused-ws") ? callback(false, 401) : callback(true),
        });
        sockets.on("connection", (socket, request) => {
          connections.push({
            request,
            closed: new Promise((resolveClosed) =>
              socket.once("close", (code, reason) =>
                resolveClosed({ code, reason: reason.toString() }),
              ),
            ),
          });
          socket.on("message", (data, isBinary) => {
            const text = isBinary ? null : data.toString();
            if (text?.startsWith("close:")) socket.close(Number(text.slice(6)), "member bye");
            else socket.send(data, { binary: isBinary });
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") throw new Error("no port");
          resolve({
            server,
            sockets,
            requests,
            connections,
            origin: `http://127.0.0.1:${address.port}`,
          });
        });
      }),
  ),
  ({ server, sockets }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          for (const client of sockets.clients) client.terminate();
          sockets.close();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

interface Received {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}

const send = (
  url: string,
  init: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
  } = {},
) =>
  Effect.promise(
    () =>
      new Promise<Received>((resolve, reject) => {
        // Split by hand: a URL object would normalize the dot segments and `//` under test.
        const [, host, port, path] = /^http:\/\/([^:/]+):(\d+)(.*)$/.exec(url) ?? [];
        const request = NodeHttp.request(
          { host, port, path, method: init.method ?? "GET", headers: init.headers, agent: false },
          (response) => {
            const chunks: Array<Buffer> = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(init.body);
      }),
  );

const json = (received: Received): unknown => JSON.parse(received.body.toString());

interface Client {
  readonly socket: WebSocket;
  readonly next: () => Promise<{ readonly data: Buffer; readonly isBinary: boolean }>;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
}

const openClient = (url: string, protocols: ReadonlyArray<string> = []) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<Client>((resolve, reject) => {
          const socket = new WebSocket(url, [...protocols]);
          const buffered: Array<{ readonly data: Buffer; readonly isBinary: boolean }> = [];
          const waiting: Array<(message: { data: Buffer; isBinary: boolean }) => void> = [];
          socket.on("message", (data: Buffer, isBinary) => {
            const message = { data, isBinary };
            const waiter = waiting.shift();
            if (waiter) waiter(message);
            else buffered.push(message);
          });
          const closed = new Promise<{ code: number; reason: string }>((resolveClosed) =>
            socket.once("close", (code, reason) =>
              resolveClosed({ code, reason: reason.toString() }),
            ),
          );
          socket.once("open", () =>
            resolve({
              socket,
              closed,
              next: () => {
                const message = buffered.shift();
                return message
                  ? Promise.resolve(message)
                  : new Promise((resolveNext) => waiting.push(resolveNext));
              },
            }),
          );
          socket.once("unexpected-response", (_request, response) =>
            reject(new Error(`upgrade refused with ${response.statusCode}`)),
          );
          socket.once("error", reject);
        }),
    ),
    (client) => Effect.sync(() => client.socket.terminate()),
  );

const makeDpopKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  let proofCount = 0;
  return {
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    sign: (input: {
      readonly method: string;
      readonly url: string;
      readonly token: string;
      readonly iat: number;
    }) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
      const payload = encode({
        htm: input.method,
        htu: input.url,
        jti: `proof-${++proofCount}`,
        iat: input.iat,
        ath: computeDpopAccessTokenHash(input.token),
      });
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
};

/** A member that checks real sessions: HTTP whoami and an RPC socket upgrade. */
const memberAuthRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/whoami",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* auth.authenticateHttpRequest(request).pipe(
        Effect.map((session) => HttpServerResponse.text(session.sessionId)),
        Effect.orElseSucceed(() => HttpServerResponse.text("refused", { status: 401 })),
      );
    }),
  ),
  HttpRouter.add(
    "GET",
    "/ws",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateWebSocketUpgrade(request, "rpc").pipe(Effect.option);
      if (Option.isNone(session)) return HttpServerResponse.text("refused", { status: 401 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* request.upgrade;
          yield* socket.reader;
          const writer = yield* socket.writer;
          yield* writer.write(session.value.sessionId);
          yield* writer.write(new Socket.CloseEvent(1000));
        }),
      ).pipe(Effect.ignore);
      return HttpServerResponse.empty();
    }),
  ),
);

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("MeshProxy", (it) => {
  it.effect("keeps one handle across sessions and restarts and rotates it when leaving", () =>
    Effect.gen(function* () {
      const secretsContext = yield* Layer.build(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mesh-handle-test-" })),
        ),
      );
      yield* Context.get(secretsContext, ServerSecretStore.ServerSecretStore).set(
        CLOUD_LINKED_USER_ID,
        encodeText("user-1"),
      );
      const settings = yield* makeSettings;
      const link = yield* makeLink;
      const boot = Effect.fn("MeshProxyTest.boot")(function* (
        membership: MeshServices.MeshMembership["Service"],
      ) {
        const context = yield* Layer.build(
          MeshProxy.layer.pipe(
            Layer.provide(Layer.succeed(MeshServices.MeshMembership, membership)),
            Layer.provide(MeshTestkit.layerCredentials()),
            Layer.provide(settings.layer),
            Layer.provide(link.layer),
            Layer.provide(Layer.succeedContext(secretsContext)),
          ),
        );
        return Context.get(context, MeshProxy.MeshProxy);
      });

      const membership = yield* MeshTestkit.makeMembership({ snapshot: meshSnapshot(SELF) });
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const proxy = yield* boot(membership.service);
          const minted = yield* proxy.mintVia({ subject: "cloud-connect" });
          expect((yield* proxy.mintVia({ subject: "cloud-connect" })).handle).toBe(minted.handle);
          const refused = yield* Effect.flip(proxy.mintVia({ subject: "desktop-bootstrap" }));
          expect(refused._tag).toBe("MeshViaForbiddenError");
          return minted.handle;
        }),
      );

      // A restart with the same secret store keeps the handle.
      const proxy = yield* boot(membership.service);
      expect((yield* proxy.mintVia({ subject: "cloud-connect" })).handle).toBe(first);

      yield* membership.service.setEnabled(false);
      const left = yield* Effect.flip(proxy.mintVia({ subject: "cloud-connect" }));
      expect(left).toMatchObject({ _tag: "MeshViaNotCaptainError", captain: null });
      yield* membership.service.setEnabled(true);
      const rotated = (yield* proxy.mintVia({ subject: "cloud-connect" })).handle;
      expect(rotated).not.toBe(first);

      // An account change makes a new key for the new account.
      yield* Context.get(secretsContext, ServerSecretStore.ServerSecretStore).set(
        CLOUD_LINKED_USER_ID,
        encodeText("user-2"),
      );
      expect((yield* proxy.mintVia({ subject: "cloud-connect" })).handle).not.toBe(rotated);
      // Linking the first account again does not bring its old key back.
      yield* Context.get(secretsContext, ServerSecretStore.ServerSecretStore).set(
        CLOUD_LINKED_USER_ID,
        encodeText("user-1"),
      );
      expect((yield* proxy.mintVia({ subject: "cloud-connect" })).handle).not.toBe(rotated);
    }),
  );

  it.effect("mints over HTTP only for Connect sessions, and only while captain", () =>
    Effect.gen(function* () {
      const captain = yield* startCaptain();
      const mintWith = (token?: string) =>
        send(`${captain.origin}/api/mesh/via`, {
          method: "POST",
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
      const first = yield* captain.auth.issueSession({ subject: "cloud-connect" });
      const second = yield* captain.auth.issueSession({ subject: "cloud-connect" });
      const browser = yield* captain.auth.issueSession({ subject: "browser" });

      const minted = yield* mintWith(first.token);
      expect(minted.status).toBe(200);
      const body = json(minted) as { handle: string; routes: ReadonlyArray<string> };
      expect(json(yield* mintWith(second.token))).toEqual(body);
      expect((yield* mintWith()).status).toBe(401);
      const forbidden = yield* mintWith(browser.token);
      expect(forbidden.status).toBe(403);
      expect(json(forbidden)).toEqual({ _tag: "MeshViaForbiddenError" });

      yield* captain.membership.setSnapshot(meshSnapshot(OTHER));
      const gone = yield* mintWith(first.token);
      expect(gone.status).toBe(410);
      expect(json(gone)).toEqual({ _tag: "MeshViaNotCaptainError", captain: OTHER });
    }),
  );

  it.effect("probes every member when it becomes captain and lists the ones it reached", () =>
    Effect.gen(function* () {
      const captain = yield* startCaptain(meshSnapshot(OTHER));
      const second = EnvironmentId.make("env-second");
      yield* captain.routes.set(MEMBER, "http://192.0.2.1:3773");
      yield* captain.routes.set(second, "http://192.0.2.2:3773");
      yield* captain.membership.setSnapshot(
        meshSnapshot(SELF, [
          memberView(SELF),
          memberView(MEMBER),
          memberView(second),
          memberView(EnvironmentId.make("env-unreachable")),
          memberView(EnvironmentId.make("env-offline"), { online: false }),
          memberView(EnvironmentId.make("env-no-tunnel"), { connectHostname: null }),
        ]),
      );
      const probed = [
        yield* Queue.take(captain.routes.calls),
        yield* Queue.take(captain.routes.calls),
        yield* Queue.take(captain.routes.calls),
      ];
      expect(probed.toSorted()).toEqual([MEMBER, second, "env-unreachable"].toSorted());
      const minted = yield* captain.mint;
      expect([...minted.routes].toSorted()).toEqual([MEMBER, second].toSorted());
      // Minting retries the unreachable member, and never probes itself or unaddressable members.
      expect(yield* Queue.takeAll(captain.routes.calls)).toEqual(["env-unreachable"]);
    }),
  );

  it.effect("refuses bad handles and unknown members with 421 and never forwards odd paths", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain(
        meshSnapshot(SELF, [
          memberView(SELF),
          memberView(MEMBER),
          memberView(OTHER, { online: false }),
        ]),
      );
      yield* captain.routes.set(MEMBER, member.origin);
      yield* captain.routes.set(OTHER, member.origin);
      const { handle } = yield* captain.mint;

      const badHandle = yield* send(`${captain.via("not-the-handle")}/api/echo`);
      expect(badHandle.status).toBe(421);
      expect(json(badHandle)).toEqual({ _tag: "MeshViaRefusedError", reason: "bad-handle" });
      for (const environmentId of [SELF, OTHER, EnvironmentId.make("env-stranger")]) {
        const unknown = yield* send(`${captain.via(handle, environmentId)}/api/echo`);
        expect(unknown.status).toBe(421);
        expect(json(unknown)).toEqual({
          _tag: "MeshViaRefusedError",
          reason: "unknown-environment",
        });
      }
      for (const path of [
        "//evil.test/api/echo",
        "/https://evil.test/api/echo",
        "/",
        "/index.html",
        "/api/mesh/session",
        "/api/../index.html",
        "/api/%2e%2e/index.html",
      ]) {
        expect((yield* send(`${captain.via(handle)}${path}`)).status).toBe(404);
      }
      expect(member.requests).toEqual([]);
    }),
  );

  it.effect("forwards an upload and an asset unchanged, without cookies or client forwarding", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;
      const upload = NodeCrypto.randomBytes(256 * 1024);

      const uploaded = yield* send(`${captain.via(handle)}/api/upload?thread=t1&name=a%20b`, {
        method: "POST",
        body: upload,
        headers: {
          "content-type": "application/octet-stream",
          "accept-encoding": "gzip",
          authorization: "DPoP client-token",
          dpop: "client-proof",
          cookie: "t3_session=captain-session",
          "x-forwarded-for": "203.0.113.9",
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "http",
        },
      });
      expect(uploaded.status).toBe(201);
      expect(uploaded.headers["set-cookie"]).toBeUndefined();
      expect(uploaded.headers["x-member"]).toBe("yes");
      // The member did not compress, and the captain must not either.
      expect(uploaded.headers["content-encoding"]).toBeUndefined();
      expect(json(uploaded)).toMatchObject({
        length: upload.length,
        sha256: NodeCrypto.createHash("sha256").update(upload).digest("hex"),
      });
      const [received] = member.requests;
      expect(received?.method).toBe("POST");
      expect(received?.url).toBe("/api/upload?thread=t1&name=a%20b");
      expect(received?.headers).toMatchObject({
        host: MEMBER_HOST,
        "x-forwarded-proto": "https",
        authorization: "DPoP client-token",
        dpop: "client-proof",
        "accept-encoding": "gzip",
      });
      expect(received?.headers.cookie).toBeUndefined();
      expect(received?.headers["x-forwarded-for"]).toBeUndefined();
      expect(received?.headers["x-forwarded-host"]).toBeUndefined();

      const asset = yield* send(`${captain.via(handle)}/api/assets/a.png?sig=abc`, {
        headers: { "accept-encoding": "gzip" },
      });
      expect(asset.status).toBe(200);
      expect(asset.headers["content-type"]).toBe("image/png");
      expect(asset.headers["set-cookie"]).toBeUndefined();
      expect(asset.body.equals(PNG)).toBe(true);
      expect(member.requests[1]?.url).toBe("/api/assets/a.png?sig=abc");
    }),
  );

  it.effect("relays WebSocket text, binary and close codes both ways", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;
      const socketUrl = `${captain.via(handle).replace(/^http/, "ws")}/api/echo-ws?stream=1`;

      const client = yield* openClient(socketUrl, ["t3.v1"]);
      expect(client.socket.protocol).toBe("t3.v1");
      const upstream = member.connections[0];
      expect(upstream?.request.url).toBe("/api/echo-ws?stream=1");
      expect(upstream?.request.headers.host).toBe(MEMBER_HOST);
      expect(upstream?.request.headers["x-forwarded-proto"]).toBe("https");
      client.socket.send("hello");
      const text = yield* Effect.promise(() => client.next());
      expect(text).toMatchObject({ isBinary: false });
      expect(text.data.toString()).toBe("hello");
      client.socket.send(Uint8Array.of(1, 2, 3));
      const binary = yield* Effect.promise(() => client.next());
      expect(binary.isBinary).toBe(true);
      expect([...binary.data]).toEqual([1, 2, 3]);
      client.socket.send("close:4321");
      expect(yield* Effect.promise(() => client.closed)).toEqual({
        code: 4321,
        reason: "member bye",
      });

      const second = yield* openClient(socketUrl);
      second.socket.close(4555, "client bye");
      expect(yield* Effect.promise(() => member.connections[1]!.closed)).toEqual({
        code: 4555,
        reason: "client bye",
      });
    }),
  );

  it.effect("passes a member's refused upgrade through as its own answer", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;
      const status = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            const socket = new WebSocket(
              `${captain.via(handle).replace(/^http/, "ws")}/api/refused-ws`,
            );
            socket.on("error", () => undefined);
            socket.once("open", () => resolve(101));
            socket.once("unexpected-response", (_request, response) => {
              resolve(response.statusCode ?? 0);
              socket.terminate();
            });
          }),
      );
      // The member's 401 tells a ticket client to mint again; a 502 or 421 would not.
      expect(status).toBe(401);
    }),
  );

  it.effect("demotion closes forwarded sockets with captain-changed and answers 410", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;
      const client = yield* openClient(`${captain.via(handle).replace(/^http/, "ws")}/api/echo-ws`);

      yield* captain.membership.setSnapshot(meshSnapshot(OTHER));
      expect((yield* Effect.promise(() => client.closed)).code).toBe(4102);
      expect((yield* Effect.promise(() => member.connections[0]!.closed)).code).toBe(1001);
      const forwarded = yield* send(`${captain.via(handle)}/api/echo`);
      expect(forwarded.status).toBe(410);
      expect(json(forwarded)).toEqual({ _tag: "MeshViaNotCaptainError", captain: OTHER });
    }),
  );

  it.effect("leaving closes forwarded sockets and retires the handle", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;
      const client = yield* openClient(`${captain.via(handle).replace(/^http/, "ws")}/api/echo-ws`);

      yield* captain.membership.service.setEnabled(false);
      yield* captain.settings.changed;
      expect((yield* Effect.promise(() => client.closed)).code).toBe(4102);
      yield* captain.membership.service.setEnabled(true);
      expect((yield* captain.mint).handle).not.toBe(handle);
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(421);
    }),
  );

  it.effect("a member accepts proofs signed for its Connect URL on every captain route", () =>
    Effect.gen(function* () {
      const memberAuthContext = yield* Layer.build(layerAuth("t3-mesh-member-test-"));
      const serveMember = Layer.build(
        HttpRouter.serve(memberAuthRoutes, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
          ),
          Layer.provide(Layer.succeedContext(memberAuthContext)),
        ),
      ).pipe(Effect.map((context) => loopbackOrigin(context)));
      const lan = yield* serveMember;
      const tunnel = yield* serveMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, lan, "lan");
      const { handle } = yield* captain.mint;

      const memberAuth = Context.get(memberAuthContext, EnvironmentAuth.EnvironmentAuth);
      const sessions = Context.get(memberAuthContext, SessionStore.SessionStore);
      const key = makeDpopKey();
      const pairing = yield* memberAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const exchanged = yield* memberAuth.exchangeBootstrapCredentialForAccessToken(
        pairing.credential,
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const token = exchanged.access_token;
      const session = yield* sessions.verify(token);
      const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      const memberUrl = `https://${MEMBER_HOST}`;

      const whoami = (signedFor: string) =>
        send(`${captain.via(handle)}/api/whoami`, {
          headers: {
            authorization: `DPoP ${token}`,
            dpop: key.sign({ method: "GET", url: `${signedFor}/api/whoami`, token, iat }),
          },
        });
      const rpcSocket = Effect.gen(function* () {
        const ticket = yield* memberAuth.issueWebSocketTicket(session, { use: "rpc" });
        const proof = key.sign({
          method: "GET",
          url: `${memberUrl}/ws`,
          token: ticket.ticket,
          iat,
        });
        const client = yield* openClient(
          `${captain.via(handle).replace(/^http/, "ws")}/ws?wsTicket=${ticket.ticket}&dpop=${proof}`,
        );
        return (yield* Effect.promise(() => client.next())).data.toString();
      }).pipe(Effect.scoped);

      const accepted = yield* whoami(memberUrl);
      expect(accepted.status).toBe(200);
      expect(accepted.body.toString()).toBe(session.sessionId);
      // A proof for the captain's own address fails, so Host and protocol are what made it work.
      expect((yield* whoami(captain.origin)).status).toBe(401);
      expect(yield* rpcSocket).toBe(session.sessionId);

      yield* captain.routes.set(MEMBER, tunnel, "tunnel");
      expect((yield* whoami(memberUrl)).body.toString()).toBe(session.sessionId);
      expect(yield* rpcSocket).toBe(session.sessionId);
    }),
  );

  it.effect("a machine out of the mesh boots without touching its secrets", () =>
    Effect.gen(function* () {
      const secretsContext = yield* Layer.build(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mesh-boot-test-" })),
        ),
      );
      const real = Context.get(secretsContext, ServerSecretStore.ServerSecretStore);
      const touched: Array<string> = [];
      const record =
        <A extends ReadonlyArray<unknown>, R>(operation: string, run: (...args: A) => R) =>
        (...args: A) => {
          touched.push(operation);
          return run(...args);
        };
      const secrets = ServerSecretStore.ServerSecretStore.of({
        ...real,
        get: record("get", real.get),
        set: record("set", real.set),
        remove: record("remove", real.remove),
      });
      const membership = yield* MeshTestkit.makeMembership({ enabled: false });
      const settings = yield* makeSettings;
      const link = yield* makeLink;
      yield* Layer.build(
        MeshProxy.layer.pipe(
          Layer.provide(membership.layer),
          Layer.provide(MeshTestkit.layerCredentials()),
          Layer.provide(settings.layer),
          Layer.provide(link.layer),
          Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
          Layer.provide(NodeServices.layer),
        ),
      );
      yield* settings.changed;
      expect(touched).toEqual([]);
    }),
  );

  it.effect("drops the route after an upstream failure, so the next request walks again", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain(meshSnapshot(OTHER));
      // A route that answered the probe but no longer takes connections.
      yield* captain.routes.set(MEMBER, "http://127.0.0.1:9");
      yield* captain.membership.setSnapshot(meshSnapshot(SELF));
      const { handle } = yield* captain.mint;

      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(502);
      expect(yield* Queue.clear(captain.routes.forgotten)).toEqual([MEMBER]);
      // The failed member is probed again before the next client learns of it.
      yield* captain.routes.set(MEMBER, member.origin);
      expect((yield* captain.mint).routes).toEqual([MEMBER]);
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);
      expect(yield* Queue.size(captain.routes.forgotten)).toBe(0);
    }),
  );

  it.effect("drops routes after failed WebSocket forwards without an HTTP agent", () =>
    Effect.gen(function* () {
      const captain = yield* startCaptain(meshSnapshot(OTHER));
      yield* captain.routes.set(MEMBER, "http://127.0.0.1:9");
      yield* captain.membership.setSnapshot(meshSnapshot(SELF));
      const { handle } = yield* captain.mint;
      for (let attempt = 0; attempt < 2; attempt++) {
        const status = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const socket = new WebSocket(`${captain.via(handle).replace(/^http/, "ws")}/ws`);
              socket.on("error", () => undefined);
              socket.once("unexpected-response", (_request, response) => {
                resolve(response.statusCode ?? 0);
                socket.terminate();
              });
            }),
        );
        expect(status).toBe(502);
      }
      expect(yield* Queue.clear(captain.routes.forgotten)).toEqual([MEMBER, MEMBER]);
    }),
  );

  it.effect("keeps the new route when an older request fails after a route walk", () =>
    Effect.gen(function* () {
      const held = yield* Queue.unbounded<NodeHttp.ServerResponse>();
      const server = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const created = NodeHttp.createServer((_request, response) => {
            Queue.offerUnsafe(held, response);
          });
          created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
        }),
        (created) =>
          Effect.sync(() => {
            created.closeAllConnections();
            created.close();
          }),
      );
      const address = server.address();
      if (address === null || typeof address === "string") return yield* Effect.die("no port");
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, `http://127.0.0.1:${address.port}`);
      const { handle } = yield* captain.mint;
      const pending = yield* send(`${captain.via(handle)}/api/hold`).pipe(Effect.forkChild);
      const response = yield* Queue.take(held);
      const currentMember = yield* startRawMember;
      yield* captain.routes.set(MEMBER, currentMember.origin);
      response.destroy();
      expect((yield* Fiber.join(pending)).status).toBe(502);
      expect(yield* Queue.clear(captain.routes.forgotten)).toEqual([]);
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);
    }),
  );

  it.effect("takes the route credentials hold now, so a captain network change moves it", () =>
    Effect.gen(function* () {
      const lan = yield* startRawMember;
      const tunnel = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, lan.origin, "lan");
      const { handle } = yield* captain.mint;
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);

      // What MeshCredentials answers after this machine changed networks: the LAN address still
      // takes connections, but no longer reaches the member.
      yield* captain.routes.set(MEMBER, tunnel.origin, "tunnel");
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);
      expect(lan.requests).toHaveLength(1);
      expect(tunnel.requests).toHaveLength(1);
    }),
  );

  it.effect("drops pooled member sockets when credentials walk the routes again", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      let connections = 0;
      member.server.on("connection", () => connections++);
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);
      expect(connections).toBe(1);

      // What MeshCredentials answers after a network change: a new walk that picked the same
      // address. A socket pooled before the change may be half-open.
      yield* captain.routes.set(MEMBER, member.origin);
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);
      expect(connections).toBe(2);
    }),
  );

  it.effect("lets a request in flight finish when credentials walk the routes again", () =>
    Effect.gen(function* () {
      // Holds every request until the test releases it.
      const held = yield* Queue.unbounded<NodeHttp.ServerResponse>();
      const member = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const server = NodeHttp.createServer((request, response) => {
            request.resume();
            request.on("end", () => Queue.offerUnsafe(held, response));
          });
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.sync(() => {
            server.closeAllConnections();
            server.close();
          }),
      );
      const address = member.address();
      if (address === null || typeof address === "string") return yield* Effect.die("no port");
      const origin = `http://127.0.0.1:${address.port}`;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, origin);
      const { handle } = yield* captain.mint;

      const first = yield* send(`${captain.via(handle)}/api/hold`).pipe(Effect.forkChild);
      const firstResponse = yield* Queue.take(held);
      // A walk lands while the first request waits for its answer; the next request takes it.
      yield* captain.routes.set(MEMBER, origin);
      const second = yield* send(`${captain.via(handle)}/api/hold`).pipe(Effect.forkChild);
      const secondResponse = yield* Queue.take(held);
      for (const response of [firstResponse, secondResponse]) {
        response.writeHead(201);
        response.end("done");
      }

      expect((yield* Fiber.join(first)).status).toBe(201);
      expect((yield* Fiber.join(second)).status).toBe(201);
      expect(yield* Queue.size(captain.routes.forgotten)).toBe(0);
    }),
  );

  it.effect("answers 502 when a member route never finishes connecting", () =>
    Effect.gen(function* () {
      // Takes the TCP connection and never answers the TLS handshake.
      const connected = yield* Deferred.make<void>();
      const sockets = new Set<NodeNet.Socket>();
      const silent = yield* Effect.acquireRelease(
        Effect.callback<NodeNet.Server>((resume) => {
          const server = NodeNet.createServer((socket) => {
            sockets.add(socket);
            Deferred.doneUnsafe(connected, Effect.void);
          });
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.sync(() => {
            for (const socket of sockets) socket.destroy();
            server.close();
          }),
      );
      const address = silent.address();
      if (address === null || typeof address === "string") return yield* Effect.die("no port");
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, `https://127.0.0.1:${address.port}`, "tunnel");
      const { handle } = yield* captain.mint;

      const forwarded = yield* send(`${captain.via(handle)}/api/echo`).pipe(Effect.forkChild);
      yield* Deferred.await(connected);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(forwarded)).status).toBe(502);
      expect(yield* Queue.clear(captain.routes.forgotten)).toEqual([MEMBER]);
    }),
  );

  it.effect("keeps serving through a relay socket blip until another captain is named", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;

      yield* captain.membership.setSnapshot(null);
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(201);
      expect((yield* captain.mint).handle).toBe(handle);

      yield* captain.membership.setSnapshot(meshSnapshot(OTHER));
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(410);
    }),
  );

  it.effect("a Connect account change ends the term and retires the old handle", () =>
    Effect.gen(function* () {
      const member = yield* startRawMember;
      const captain = yield* startCaptain();
      yield* captain.routes.set(MEMBER, member.origin);
      const { handle } = yield* captain.mint;
      const client = yield* openClient(`${captain.via(handle).replace(/^http/, "ws")}/api/echo-ws`);

      yield* captain.secrets.set(CLOUD_LINKED_USER_ID, encodeText("user-2"));
      yield* captain.link.changed;
      expect((yield* Effect.promise(() => client.closed)).code).toBe(4102);
      expect((yield* send(`${captain.via(handle)}/api/echo`)).status).toBe(421);
      expect((yield* captain.mint).handle).not.toBe(handle);
    }),
  );
});
