// @effect-diagnostics nodeBuiltinImport:off -- the silent relay is a plain Node server.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type HostPowerSnapshot,
  MESH_PING_MESSAGE,
  MESH_GRANT_JWT_TYPE,
  MESH_GRANT_SCOPE,
  MeshCloseCode,
  type MeshMemberView,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";

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
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MeshMembership from "./MeshMembership.ts";
import * as MeshSessionHttp from "./MeshSessionHttp.ts";
import { startRelay } from "./MeshRelay.testkit.ts";
import * as MeshServices from "./Services.ts";

const SELF = EnvironmentId.make("env-self");
const MEMBER_A = EnvironmentId.make("env-a");
const MEMBER_B = EnvironmentId.make("env-b");
const LAN_ENDPOINT = { kind: "lan", httpBaseUrl: "http://192.168.1.9:3773/" } as const;
const mintKey = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId: SELF,
  label: "self box",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.2.3",
  capabilities: { repositoryIdentity: true, meshMember: true, serverSelfUpdate: "boot-service" },
};

const initialPower: HostPowerSnapshot = {
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

const memberView = (environmentId: EnvironmentId): MeshMemberView => ({
  environmentId,
  label: environmentId,
  machineKind: null,
  serverVersion: "1.2.3",
  online: true,
  capabilities: { meshMember: true },
  connectHostname: null,
  directEndpoints: [],
  captainEligible: false,
});

const snapshotFrame = (members: ReadonlyArray<EnvironmentId>, captain: EnvironmentId | null) =>
  JSON.stringify({
    type: "snapshot",
    members: members.map(memberView),
    captain,
    pin: null,
    selfEnvironmentId: SELF,
  });

/** MeshMembership against a fake relay, with real auth and a real secret store. */
const startMembership = Effect.fn("test.startMembership")(function* (
  relayUrl: string,
  beforeIssue: Effect.Effect<void> = Effect.void,
) {
  const settingsRef = yield* SubscriptionRef.make<ServerSettingsValue>(DEFAULT_SERVER_SETTINGS);
  const powerRef = yield* SubscriptionRef.make(initialPower);
  const linkChanges = yield* PubSub.unbounded<void>();

  const layerFakes = Layer.mergeAll(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: SubscriptionRef.get(settingsRef),
      updateSettings: (patch) =>
        SubscriptionRef.updateAndGet(settingsRef, (current) =>
          applyServerSettingsPatch(current, patch),
        ),
      subscribeChanges: Effect.succeed(SubscriptionRef.changes(settingsRef).pipe(Stream.drop(1))),
    }),
    Layer.mock(HostPowerMonitor.HostPowerMonitor)({
      snapshot: SubscriptionRef.get(powerRef),
      streamChanges: SubscriptionRef.changes(powerRef).pipe(Stream.drop(1)),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(SELF),
      getDescriptor: Effect.succeed(descriptor),
    }),
    Layer.mock(ConnectReachability.ConnectReachability)({ latest: Effect.succeedNone }),
    Layer.mock(CloudManagedEndpointRuntime.CloudManagedEndpointRuntime)({
      inspectConnector: Effect.succeed(null),
      readinessChanged: Stream.never,
    }),
    Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([LAN_ENDPOINT]) }),
    Layer.mock(CloudLink.CloudLink)({ linkChanges: Stream.fromPubSub(linkChanges) }),
  );
  const layerAuth = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mesh-membership-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const auth = yield* Layer.build(layerAuth);
  const secrets = Context.get(auth, ServerSecretStore.ServerSecretStore);
  yield* secrets.set(RELAY_URL_SECRET, new TextEncoder().encode(relayUrl));
  yield* secrets.set(
    RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
    new TextEncoder().encode("environment-credential"),
  );
  const realAuth = Context.get(auth, EnvironmentAuth.EnvironmentAuth);
  const guardedAuth = EnvironmentAuth.EnvironmentAuth.of({
    ...realAuth,
    issueMeshMemberSession: (input) =>
      beforeIssue.pipe(Effect.andThen(realAuth.issueMeshMemberSession(input))),
  });
  const context = yield* Layer.build(
    MeshSessionHttp.layer.pipe(
      Layer.provideMerge(MeshMembership.layer),
      Layer.provide(layerFakes),
      Layer.provide(
        Layer.succeedContext(Context.add(auth, EnvironmentAuth.EnvironmentAuth, guardedAuth)),
      ),
    ),
  );
  return {
    membership: Context.get(context, MeshServices.MeshMembership),
    issuer: Context.get(context, MeshSessionHttp.MeshSessionIssuer),
    grant: Effect.fn("test.membershipGrant")(function* (caller: EnvironmentId, jkt: string) {
      yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, new TextEncoder().encode(mintKey.publicKey));
      yield* secrets.set(RELAY_ISSUER_SECRET, new TextEncoder().encode(relayUrl));
      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("user_mesh"));
      const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      return yield* signRelayJwt({
        privateKey: mintKey.privateKey,
        typ: MESH_GRANT_JWT_TYPE,
        payload: {
          iss: relayUrl,
          sub: "user_mesh",
          aud: SELF,
          meshCaller: caller,
          scope: MESH_GRANT_SCOPE,
          cnf: { jkt },
          jti: NodeCrypto.randomUUID(),
          iat,
          exp: iat + 60,
        },
      });
    }),
    secrets,
    auth: Context.get(auth, EnvironmentAuth.EnvironmentAuth),
    sessions: Context.get(auth, SessionStore.SessionStore),
    settings: settingsRef,
    power: powerRef,
    linkChanged: PubSub.publish(linkChanges, undefined),
  };
});

const firstSnapshot = (membership: MeshServices.MeshMembership["Service"]) =>
  membership.snapshots.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

const permanentEnd = Effect.fn("test.permanentEnd")(function* () {
  const ended = yield* Deferred.make<void>();
  const logger = Logger.make(({ message }) => {
    if (Array.isArray(message) && message.includes("The relay ended this machine's mesh socket")) {
      Deferred.doneUnsafe(ended, Effect.void);
    }
  });
  return {
    ended: Deferred.await(ended),
    layer: Logger.layer([logger], { mergeWithExisting: true }),
  };
});

/**
 * A relay that takes the mesh socket and then answers nothing, as one past a dead network would.
 * It reports each upgrade and each close frame a member sends.
 */
const startSilentRelay = Effect.fn("test.startSilentRelay")(function* () {
  const events = yield* Queue.unbounded<"connection" | "close">();
  const sockets = new Set<NodeStream.Duplex>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const created = NodeHttp.createServer();
      created.on("upgrade", (request, socket) => {
        sockets.add(socket);
        const accept = NodeCrypto.createHash("sha1")
          .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        Queue.offerUnsafe(events, "connection");
        // The low four bits of a frame's first byte are its opcode; 8 is a close.
        socket.on("data", (chunk: Buffer) => {
          if (((chunk[0] ?? 0) & 0x0f) === 8) Queue.offerUnsafe(events, "close");
        });
      });
      created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, next: Queue.take(events) };
});

it.layer(NodeServices.layer)("MeshMembership", (it) => {
  it.effect("says hello with its score inputs, then sends only the fields that change", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { membership, settings, power } = yield* startMembership(relay.url);

      const connection = yield* relay.nextConnection;
      assert.strictEqual(connection.authorization, "Bearer environment-credential");
      assert.strictEqual(connection.path, "/v1/mesh/socket");
      const hello = yield* relay.nextFrame;
      assert.deepInclude(hello, {
        type: "hello",
        label: "self box",
        serverVersion: "1.2.3",
        capabilities: { meshMember: true },
        connectHostname: null,
        directEndpoints: [LAN_ENDPOINT],
      });
      assert.deepInclude(hello.score as object, {
        backgroundService: true,
        onBattery: "false",
        machineKind: null,
        tunnelReady: false,
      });

      connection.socket.send(snapshotFrame([SELF, MEMBER_A], SELF));
      yield* firstSnapshot(membership);
      assert.strictEqual(yield* membership.selfRole, "captain");

      // A settings change that touches no hello field sends nothing; the next frame is the
      // power change alone.
      yield* SubscriptionRef.update(settings, (current) => ({
        ...current,
        guestSharingEnabled: true,
      }));
      yield* SubscriptionRef.update(power, (current) => ({
        ...current,
        onBattery: "true" as const,
      }));
      const update = yield* relay.nextFrame;
      assert.deepStrictEqual(Object.keys(update).toSorted(), ["score", "type"]);
      assert.deepInclude(update.score as object, { onBattery: "true" });
    }),
  );

  it.effect("pings every 30 seconds with the exact frame the relay auto-answers", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      yield* startMembership(relay.url);
      yield* relay.nextConnection;
      yield* relay.nextFrame;
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(yield* relay.nextRawFrame, MESH_PING_MESSAGE);
    }),
  );

  it.effect("resolves grant requests with the relay's answer", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { membership } = yield* startMembership(relay.url);
      const connection = yield* relay.nextConnection;
      yield* relay.nextFrame;

      const granted = yield* membership
        .requestGrant({ targetEnvironmentId: MEMBER_A, jkt: "thumbprint" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const request = yield* relay.nextFrame;
      assert.deepInclude(request, {
        type: "credentialRequest",
        targetEnvironmentId: MEMBER_A,
        jkt: "thumbprint",
      });
      connection.socket.send(
        JSON.stringify({ type: "credentialGrant", requestId: request.requestId, grant: "jwt" }),
      );
      assert.strictEqual(yield* Fiber.join(granted), "jwt");

      const refused = yield* membership
        .requestGrant({ targetEnvironmentId: MEMBER_B, jkt: "thumbprint" })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      const second = yield* relay.nextFrame;
      connection.socket.send(
        JSON.stringify({
          type: "credentialError",
          requestId: second.requestId,
          code: "target-offline",
          message: "offline",
        }),
      );
      assert.deepStrictEqual(
        yield* Fiber.join(refused),
        new MeshServices.MeshGrantRefusedError({
          targetEnvironmentId: MEMBER_B,
          code: "target-offline",
        }),
      );
    }),
  );

  it.effect("revokes the sessions of a member the relay no longer lists", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { membership, auth, sessions, issuer, grant } = yield* startMembership(relay.url);
      const kept = yield* auth.issueMeshMemberSession({
        meshCaller: MEMBER_A,
        proofKeyThumbprint: "a",
      });
      const removed = yield* auth.issueMeshMemberSession({
        meshCaller: MEMBER_B,
        proofKeyThumbprint: "b",
      });
      const connection = yield* relay.nextConnection;
      yield* relay.nextFrame;
      connection.socket.send(snapshotFrame([SELF, MEMBER_A, MEMBER_B], null));
      yield* firstSnapshot(membership);
      const unusedGrant = yield* grant(MEMBER_B, "b");

      const nextSnapshot = yield* membership.snapshots.pipe(
        Stream.drop(1),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      connection.socket.send(snapshotFrame([SELF, MEMBER_A], null));
      yield* Fiber.join(nextSnapshot);
      assert.strictEqual((yield* sessions.verify(kept.token)).meshCaller, MEMBER_A);
      const revoked = yield* Effect.flip(sessions.verify(removed.token));
      assert.strictEqual(revoked._tag, "SessionTokenRevokedError");
      const refused = yield* Effect.flip(
        issuer.redeem({ grant: unusedGrant, proofThumbprint: "b" }),
      );
      assert.strictEqual(refused._tag, "MeshGrantRejectedError");
    }),
  );

  it.effect("revokes a session whose issuance is in progress when this machine leaves", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const issuing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const member = yield* startMembership(
        relay.url,
        Deferred.succeed(issuing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const connection = yield* relay.nextConnection;
      yield* relay.nextFrame;
      connection.socket.send(snapshotFrame([SELF, MEMBER_A], null));
      yield* firstSnapshot(member.membership);
      const grant = yield* member.grant(MEMBER_A, "a");
      const issued = yield* member.issuer
        .redeem({ grant, proofThumbprint: "a" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(issuing);
      const leaving = yield* member.membership
        .setEnabled(false)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* SubscriptionRef.changes(member.settings).pipe(
        Stream.filter((settings) => !settings.meshEnabled),
        Stream.runHead,
      );
      yield* Deferred.succeed(release, undefined);
      const session = yield* Fiber.join(issued);
      yield* Fiber.join(leaving);
      assert.strictEqual(
        (yield* member.sessions.verify(session.token).pipe(Effect.flip))._tag,
        "SessionTokenRevokedError",
      );
    }),
  );

  it.effect("leaving closes the socket as left and revokes every mesh session", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { membership, auth, sessions } = yield* startMembership(relay.url);
      const session = yield* auth.issueMeshMemberSession({
        meshCaller: MEMBER_A,
        proofKeyThumbprint: "a",
      });
      yield* relay.nextConnection;
      yield* relay.nextFrame;

      yield* membership.setEnabled(false);
      const revoked = yield* Effect.flip(sessions.verify(session.token));
      assert.strictEqual(revoked._tag, "SessionTokenRevokedError");
      assert.strictEqual(yield* relay.nextClose, MeshCloseCode.left);
      assert.deepInclude(yield* membership.status, {
        enabled: false,
        selfRole: "off",
        unavailableReason: "disabled",
      });

      yield* membership.setEnabled(true);
      yield* relay.nextConnection;
      assert.strictEqual((yield* relay.nextFrame).type, "hello");
    }),
  );

  it.effect.each([MeshCloseCode.sharedKey, MeshCloseCode.notAllowlisted, MeshCloseCode.left])(
    "permanent close %s revokes all inbound sessions, including issuance in progress",
    (code) =>
      Effect.gen(function* () {
        const end = yield* permanentEnd();
        yield* Effect.gen(function* () {
          const relay = yield* startRelay();
          const issuing = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const member = yield* startMembership(
            relay.url,
            Deferred.succeed(issuing, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          const connection = yield* relay.nextConnection;
          yield* relay.nextFrame;
          connection.socket.send(snapshotFrame([SELF, MEMBER_A, MEMBER_B], null));
          yield* firstSnapshot(member.membership);
          const existing = yield* member.auth.issueMeshMemberSession({
            meshCaller: MEMBER_A,
            proofKeyThumbprint: "a",
          });
          const grant = yield* member.grant(MEMBER_B, "b");
          const issuingSession = yield* member.issuer
            .redeem({ grant, proofThumbprint: "b" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(issuing);

          connection.socket.close(code);
          assert.strictEqual(yield* relay.nextClose, code);
          yield* Deferred.succeed(release, undefined);
          const issued = yield* Fiber.join(issuingSession);
          yield* end.ended;

          for (const session of [existing, issued]) {
            assert.strictEqual(
              (yield* member.sessions.verify(session.token).pipe(Effect.flip))._tag,
              "SessionTokenRevokedError",
            );
          }
          assert.strictEqual(yield* member.membership.selfRole, "off");
        }).pipe(Effect.provide(end.layer));
      }),
  );

  it.effect.each([401, 403, 404, 426])(
    "permanent upgrade refusal %s revokes every inbound mesh session",
    (status) =>
      Effect.gen(function* () {
        const end = yield* permanentEnd();
        yield* Effect.gen(function* () {
          const requests = yield* Queue.unbounded<NodeHttp.ServerResponse>();
          const relay = yield* Effect.acquireRelease(
            Effect.callback<NodeHttp.Server>((resume) => {
              const server = NodeHttp.createServer((_request, response) => {
                Queue.offerUnsafe(requests, response);
              });
              server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
            }),
            (server) =>
              Effect.sync(() => {
                server.closeAllConnections();
                server.close();
              }),
          );
          const address = relay.address();
          assert.isNotNull(address);
          if (address === null || typeof address === "string") return yield* Effect.die("no port");
          const member = yield* startMembership(`http://127.0.0.1:${address.port}`);
          const sessions = yield* Effect.forEach([MEMBER_A, MEMBER_B], (meshCaller) =>
            member.auth.issueMeshMemberSession({ meshCaller, proofKeyThumbprint: meshCaller }),
          );

          (yield* Queue.take(requests)).writeHead(status).end();
          yield* end.ended;

          for (const session of sessions) {
            assert.strictEqual(
              (yield* member.sessions.verify(session.token).pipe(Effect.flip))._tag,
              "SessionTokenRevokedError",
            );
          }
          assert.deepInclude(yield* member.membership.status, {
            selfRole: "off",
            unavailableReason: status === 404 ? "not-allowlisted" : "not-linked",
          });
        }).pipe(Effect.provide(end.layer));
      }),
  );

  it.effect(
    "leaving while the relay socket is down still tells the relay on its next contact",
    () =>
      Effect.gen(function* () {
        const relay = yield* startRelay();
        const { membership } = yield* startMembership(relay.url);
        const connection = yield* relay.nextConnection;
        yield* relay.nextFrame;
        // The relay goes away; the machine waits out its backoff before it tries again.
        connection.socket.close(1011);
        assert.strictEqual(yield* relay.nextClose, 1011);

        yield* membership.setEnabled(false);
        yield* relay.nextConnection;
        assert.strictEqual(yield* relay.nextClose, MeshCloseCode.left);
      }),
  );

  it.effect("keeps a leave the relay never answered and sends it again", () =>
    Effect.gen(function* () {
      const relay = yield* startSilentRelay();
      const { membership, secrets } = yield* startMembership(relay.url);
      assert.strictEqual(yield* relay.next, "connection");

      yield* membership.setEnabled(false);
      assert.strictEqual(yield* relay.next, "close");
      yield* TestClock.adjust("10 seconds");
      // The marker survived the unanswered close, so the machine leaves on a new socket.
      assert.strictEqual(yield* relay.next, "connection");
      assert.strictEqual(yield* relay.next, "close");
      // That close goes unanswered too: it tries again after a backoff.
      yield* TestClock.adjust("10 seconds");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* relay.next, "connection");
      assert.isTrue(Option.isSome(yield* secrets.get("mesh-leave-pending")));
    }),
  );

  it.effect("after a permanent close it reconnects only when the Connect link changes", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay();
      const { linkChanged } = yield* startMembership(relay.url);
      const connection = yield* relay.nextConnection;
      yield* relay.nextFrame;

      connection.socket.close(MeshCloseCode.notAllowlisted);
      assert.strictEqual(yield* relay.nextClose, MeshCloseCode.notAllowlisted);
      yield* linkChanged;
      yield* relay.nextConnection;
      assert.strictEqual((yield* relay.nextFrame).type, "hello");
    }),
  );
});

it.effect("reconnects after a backoff until the relay closes with a permanent code", () =>
  Effect.gen(function* () {
    const sessions = yield* Ref.make(0);
    const ends = [
      { code: 1011, joined: true },
      { code: 1006, joined: false },
      { code: MeshCloseCode.sharedKey, joined: false },
    ];
    const loop = yield* MeshMembership.reconnectUntilPermanent(
      Ref.getAndUpdate(sessions, (count) => count + 1).pipe(Effect.map((count) => ends[count]!)),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    assert.strictEqual(yield* Ref.get(sessions), 1);
    // The first backoff is at most one second; the second, after an unjoined session, two.
    yield* TestClock.adjust("1 second");
    assert.strictEqual(yield* Ref.get(sessions), 2);
    yield* TestClock.adjust("2 seconds");
    assert.strictEqual(yield* Fiber.join(loop), "shared-key");
    assert.strictEqual(yield* Ref.get(sessions), 3);
  }),
);

it.effect("stops at once when the relay refuses the upgrade for good, and retries otherwise", () =>
  Effect.gen(function* () {
    const refusals = (statuses: ReadonlyArray<number | null>) =>
      Effect.gen(function* () {
        const sessions = yield* Ref.make(0);
        const loop = yield* MeshMembership.reconnectUntilPermanent(
          Ref.getAndUpdate(sessions, (count) => count + 1).pipe(
            Effect.flatMap(
              (count) => new MeshMembership.MeshRelaySocketError({ status: statuses[count]! }),
            ),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("2 seconds");
        const reason = yield* Fiber.join(loop);
        // No backoff is waiting: the loop ended on the refusal.
        yield* TestClock.adjust("10 minutes");
        return { reason, sessions: yield* Ref.get(sessions) };
      });
    assert.deepStrictEqual(yield* refusals([null, 503, 401]), {
      reason: "not-linked",
      sessions: 3,
    });
    // A relay without the mesh route, such as an older one, is not asked again.
    assert.deepStrictEqual(yield* refusals([404]), { reason: "not-allowlisted", sessions: 1 });
  }),
);

it("finds the fields that changed since the last hello", () => {
  const hello = {
    label: "box",
    serverVersion: "1.0.0",
    capabilities: { meshMember: true },
    score: {
      backgroundService: false,
      onBattery: "false",
      lowPowerMode: "false",
      machineKind: null,
      startedAt: "2026-10-24T00:00:00.000Z",
      tunnelReady: false,
    },
    connectHostname: null,
    directEndpoints: [LAN_ENDPOINT],
  } as const;
  assert.isNull(MeshMembership.helloUpdate(hello, { ...hello, directEndpoints: [LAN_ENDPOINT] }));
  assert.deepStrictEqual(
    MeshMembership.helloUpdate(hello, { ...hello, connectHostname: "box.t3.example" }),
    { type: "update", connectHostname: "box.t3.example" },
  );
});

it.effect("waits a jittered backoff that never exceeds five minutes", () =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const sessions = yield* Ref.make(0);
    yield* MeshMembership.reconnectUntilPermanent(
      Ref.updateAndGet(sessions, (count) => count + 1).pipe(
        Effect.tap((count) => (count === 20 ? Deferred.succeed(done, undefined) : Effect.void)),
        Effect.map((count) => ({ code: count === 20 ? MeshCloseCode.left : 1006, joined: false })),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    // Nineteen backoffs, each at most the five-minute cap.
    yield* TestClock.adjust("95 minutes");
    yield* Deferred.await(done);
    assert.strictEqual(yield* Ref.get(sessions), 20);
  }),
);
