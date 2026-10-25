// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MESH_GRANT_JWT_TYPE,
  MESH_IDLE_TIMEOUT_MS,
  MESH_OFFLINE_GRACE_MS,
  MeshCloseCode,
  MeshGrantClaims,
  type MeshMemberHello,
  type MeshRelayMessage,
  type MeshRelaySnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as MeshHandlers from "./meshRelayObject.ts";
import * as MeshStore from "./meshRelayStore.ts";
import * as NodeSqliteClient from "./nodeSqliteClient.ts";
import { RELAY_MINT_REQUEST_TYP, verifyRelayJwt } from "./relayJwt.ts";

const ISSUER = "https://relay.example.test/";
const START = Date.parse("2026-10-24T12:00:00.000Z");
const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const decodeGrantClaims = Schema.decodeUnknownEffect(MeshGrantClaims);

interface FakeSocket {
  environmentId: EnvironmentId | null;
  open: boolean;
  lastPingAt: number | null;
  readonly received: Array<MeshRelayMessage>;
  closed: { readonly code: number; readonly reason: string } | null;
}

const helloFrame = (label: string, overrides: Partial<Omit<MeshMemberHello, "type">> = {}) =>
  JSON.stringify({
    type: "hello",
    label,
    serverVersion: "1.0.0",
    capabilities: { meshMember: true, meshAgents: true, meshGateway: true },
    score: {
      backgroundService: false,
      onBattery: "false",
      lowPowerMode: "false",
      machineKind: "desktop",
      startedAt: "2026-10-01T00:00:00.000Z",
      tunnelReady: true,
    },
    connectHostname: `${label}.tunnels.example.test`,
    directEndpoints: [],
    ...overrides,
  });

/** One user's object. Sockets and storage outlive it, as they outlive a hibernated object. */
const makeMesh = (
  shared: { readonly sockets: Array<FakeSocket> } = { sockets: [] },
  options: { readonly allowlisted?: boolean } = {},
) => {
  const alarms: Array<number | null> = [];
  const ctx: MeshHandlers.MeshObjectContext<FakeSocket> = {
    isAllowlisted: (userId) => userId === "user-1" && (options.allowlisted ?? true),
    issuer: ISSUER,
    mintPrivateKey: Redacted.make(mintKeys.privateKey),
    setAlarm: (at) => Effect.sync(() => void alarms.push(at)),
    sockets: {
      list: Effect.sync(() => shared.sockets.filter((socket) => socket.open)),
      environmentOf: (socket) => socket.environmentId,
      lastPingAt: (socket) => Effect.succeed(socket.lastPingAt),
      send: (socket, text) => Effect.sync(() => void socket.received.push(JSON.parse(text))),
      retire: (socket, code, reason) =>
        Effect.sync(() => {
          socket.environmentId = null;
          socket.open = false;
          socket.closed = { code, reason };
        }),
    },
  };
  const connect = (environmentId: string) =>
    Effect.gen(function* () {
      const socket: FakeSocket = {
        environmentId: EnvironmentId.make(environmentId),
        open: true,
        lastPingAt: null,
        received: [],
        closed: null,
      };
      shared.sockets.push(socket);
      expect(yield* MeshHandlers.claimOwner("user-1")).toBe(true);
      yield* MeshHandlers.connect(ctx, EnvironmentId.make(environmentId));
      return socket;
    });
  const say = (socket: FakeSocket, frame: string | object) =>
    MeshHandlers.message(ctx, socket, typeof frame === "string" ? frame : JSON.stringify(frame));
  const join = (environmentId: string, label: string, hello?: Parameters<typeof helloFrame>[1]) =>
    Effect.gen(function* () {
      const socket = yield* connect(environmentId);
      yield* say(socket, helloFrame(label, hello));
      return socket;
    });
  /** The member's side closed with `code`: the runtime reports the close. */
  const drop = (socket: FakeSocket, code = 1006) => {
    socket.open = false;
    return MeshHandlers.close(ctx, socket, code);
  };
  return { ctx, alarms, connect, say, join, drop, sockets: shared.sockets };
};

const snapshots = (socket: FakeSocket) =>
  socket.received.filter((message): message is MeshRelaySnapshot => message.type === "snapshot");
const lastSnapshot = (socket: FakeSocket) => snapshots(socket).at(-1);
const presence = (snapshot: MeshRelaySnapshot | undefined) =>
  Object.fromEntries((snapshot?.members ?? []).map((m) => [m.environmentId, m.online]));
const credentialAnswers = (socket: FakeSocket) =>
  socket.received.filter((message) => message.type !== "snapshot");

const withMesh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* MeshStore.migrate;
    return yield* effect;
  }).pipe(
    Effect.provide(
      Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCryptoLayer.layer),
    ),
  );

describe("MeshObject presence", () => {
  it.effect("answers hello with a snapshot that names the captain", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const box = yield* mesh.join("env-box", "box");
        const snapshot = lastSnapshot(box);
        expect(snapshot).toMatchObject({
          captain: "env-box",
          pin: null,
          selfEnvironmentId: "env-box",
          members: [
            { environmentId: "env-box", label: "box", online: true, captainEligible: true },
          ],
        });
        expect(mesh.alarms.at(-1)).toBe(START + MESH_IDLE_TIMEOUT_MS);
      }),
    ),
  );

  it.effect("keeps the captain when a better member joins", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const laptop = yield* mesh.join("env-laptop", "laptop", {
          score: {
            backgroundService: false,
            onBattery: "true",
            lowPowerMode: "false",
            machineKind: "laptop",
            startedAt: "2026-10-20T00:00:00.000Z",
            tunnelReady: true,
          },
        });
        const server = yield* mesh.join("env-server", "server", {
          score: {
            backgroundService: true,
            onBattery: "unknown",
            lowPowerMode: "unknown",
            machineKind: "server",
            startedAt: "2026-09-01T00:00:00.000Z",
            tunnelReady: true,
          },
        });
        expect(lastSnapshot(laptop)?.captain).toBe("env-laptop");
        expect(lastSnapshot(server)).toMatchObject({
          captain: "env-laptop",
          selfEnvironmentId: "env-server",
        });
        expect(presence(lastSnapshot(laptop))).toEqual({ "env-laptop": true, "env-server": true });
      }),
    ),
  );

  it.effect("replaces the old socket on a new hello and ignores the old socket's close", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const first = yield* mesh.join("env-box", "box");
        const second = yield* mesh.join("env-box", "box");
        expect(first.closed).toEqual({ code: MeshCloseCode.replaced, reason: "replaced" });
        yield* MeshHandlers.close(mesh.ctx, first, MeshCloseCode.replaced);
        yield* TestClock.adjust(MESH_OFFLINE_GRACE_MS + 1_000);
        yield* MeshHandlers.alarm(mesh.ctx);
        expect(second.closed).toBeNull();
        expect(presence(lastSnapshot(second))).toEqual({ "env-box": true });
        expect((yield* MeshStore.getMember("env-box"))?.disconnectedAt).toBeNull();
      }),
    ),
  );

  it.effect("keeps a member online while a second socket waits for its hello", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const live = yield* mesh.join("env-box", "box");
        const pending = yield* mesh.connect("env-box");
        yield* mesh.drop(pending);
        expect((yield* MeshStore.getMember("env-box"))?.disconnectedAt).toBeNull();
        expect(live.closed).toBeNull();
      }),
    ),
  );

  it.effect("closes a socket with no ping for 90 s, then marks it offline after the grace", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const quiet = yield* mesh.join("env-quiet", "quiet");
        const chatty = yield* mesh.join("env-chatty", "chatty");
        expect(lastSnapshot(chatty)?.captain).toBe("env-quiet");

        yield* TestClock.adjust(60_000);
        chatty.lastPingAt = START + 60_000;
        yield* TestClock.adjust(MESH_IDLE_TIMEOUT_MS - 60_000);
        yield* MeshHandlers.alarm(mesh.ctx);
        expect(quiet.closed).toEqual({ code: MeshCloseCode.idle, reason: "idle" });
        expect(chatty.closed).toBeNull();
        // Still online during the grace, so the captain does not move yet.
        expect((yield* MeshStore.getMember("env-quiet"))?.online).toBe(true);
        expect(mesh.alarms.at(-1)).toBe(START + MESH_IDLE_TIMEOUT_MS + MESH_OFFLINE_GRACE_MS);

        yield* TestClock.adjust(MESH_OFFLINE_GRACE_MS);
        chatty.lastPingAt = START + MESH_IDLE_TIMEOUT_MS + MESH_OFFLINE_GRACE_MS;
        yield* MeshHandlers.alarm(mesh.ctx);
        const snapshot = lastSnapshot(chatty);
        expect(presence(snapshot)).toEqual({ "env-chatty": true, "env-quiet": false });
        expect(snapshot?.captain).toBe("env-chatty");
      }),
    ),
  );

  it.effect("keeps a member that reconnects within the grace online and captain", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const box = yield* mesh.join("env-box", "box");
        const other = yield* mesh.join("env-other", "other");
        yield* mesh.drop(box);
        expect(mesh.alarms.at(-1)).toBe(START + MESH_OFFLINE_GRACE_MS);
        yield* TestClock.adjust(MESH_OFFLINE_GRACE_MS - 1_000);
        yield* mesh.join("env-box", "box");
        yield* TestClock.adjust(MESH_OFFLINE_GRACE_MS);
        other.lastPingAt = START + MESH_OFFLINE_GRACE_MS * 2;
        yield* MeshHandlers.alarm(mesh.ctx);
        expect(presence(lastSnapshot(other))).toEqual({ "env-box": true, "env-other": true });
        expect(lastSnapshot(other)?.captain).toBe("env-box");
      }),
    ),
  );

  it.effect("removes a member that closes with left at once and clears its pin", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const box = yield* mesh.join("env-box", "box");
        const laptop = yield* mesh.join("env-laptop", "laptop");
        const laptopAgain = yield* mesh.connect("env-laptop");
        yield* mesh.say(laptop, { type: "setPin", environmentId: "env-laptop" });
        expect(lastSnapshot(box)).toMatchObject({ pin: "env-laptop", captain: "env-laptop" });

        yield* mesh.drop(laptop, MeshCloseCode.left);
        expect(laptopAgain.closed).toEqual({ code: MeshCloseCode.left, reason: "left" });
        expect(lastSnapshot(box)).toMatchObject({ pin: null, captain: "env-box" });
        expect(presence(lastSnapshot(box))).toEqual({ "env-box": true });
        expect(yield* MeshStore.getMember("env-laptop")).toBeNull();
      }),
    ),
  );

  it.effect("keeps a member whose socket closed for another reason through the grace", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const box = yield* mesh.join("env-box", "box");
        const laptop = yield* mesh.join("env-laptop", "laptop");
        yield* mesh.drop(laptop, 1001);
        expect(presence(lastSnapshot(box))).toEqual({ "env-box": true, "env-laptop": true });
        expect((yield* MeshStore.getMember("env-laptop"))?.disconnectedAt).toBe(START);
      }),
    ),
  );

  it.effect("belongs to the first user that calls it and refuses any other", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        yield* mesh.join("env-box", "box");
        expect(yield* MeshHandlers.claimOwner("user-2")).toBe(false);
        const misrouted = yield* Effect.flip(MeshHandlers.view("user-2"));
        expect(misrouted._tag).toBe("MeshOwnerMismatchError");
        const unlinked = yield* Effect.flip(
          MeshHandlers.unlink(mesh.ctx, "user-2", EnvironmentId.make("env-box")),
        );
        expect(unlinked._tag).toBe("MeshOwnerMismatchError");
        expect((yield* MeshHandlers.view("user-1")).members).toHaveLength(1);
      }),
    ),
  );

  it.effect("ignores a pin on an ineligible member and says why", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const box = yield* mesh.join("env-box", "box");
        const desk = yield* mesh.join("env-desk", "desk", { connectHostname: null });
        yield* mesh.say(desk, {
          type: "update",
          score: {
            backgroundService: true,
            onBattery: "false",
            lowPowerMode: "false",
            machineKind: "server",
            startedAt: "2026-10-01T00:00:00.000Z",
            tunnelReady: false,
          },
        });
        yield* mesh.say(box, { type: "setPin", environmentId: "env-desk" });
        const snapshot = lastSnapshot(box);
        expect(snapshot).toMatchObject({ pin: "env-desk", captain: "env-box" });
        expect(snapshot?.members.find((m) => m.environmentId === "env-desk")).toMatchObject({
          captainEligible: false,
          ineligibleReason: "no-tunnel",
        });

        yield* mesh.say(desk, { type: "update", capabilities: { meshMember: true } });
        expect(
          lastSnapshot(box)?.members.find((m) => m.environmentId === "env-desk")?.ineligibleReason,
        ).toBe("needs-update");
      }),
    ),
  );

  it.effect("rebuilds from storage and open sockets after hibernation", () =>
    withMesh(
      Effect.gen(function* () {
        const shared = { sockets: [] as Array<FakeSocket> };
        const before = makeMesh(shared);
        const box = yield* before.join("env-box", "box");
        const laptop = yield* before.join("env-laptop", "laptop");
        yield* before.say(laptop, { type: "setPin", environmentId: "env-laptop" });

        // A woken object has nothing in memory: only storage and the runtime's sockets.
        const after = makeMesh(shared);
        yield* after.say(box, { type: "update", label: "box renamed" });
        const snapshot = lastSnapshot(laptop);
        expect(snapshot).toMatchObject({ pin: "env-laptop", captain: "env-laptop" });
        expect(snapshot?.members.map((m) => m.label)).toEqual(["box renamed", "laptop"]);
        expect(yield* MeshHandlers.view("user-1")).toMatchObject({
          captain: "env-laptop",
          pin: "env-laptop",
        });
      }),
    ),
  );

  it.effect("drops an unlinked member and closes its socket", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const box = yield* mesh.join("env-box", "box");
        const laptop = yield* mesh.join("env-laptop", "laptop");
        yield* MeshHandlers.unlink(mesh.ctx, "user-1", EnvironmentId.make("env-laptop"));
        expect(laptop.closed?.code).toBe(MeshCloseCode.left);
        expect(presence(lastSnapshot(box))).toEqual({ "env-box": true });
      }),
    ),
  );
});

describe("MeshObject credential grants", () => {
  const requestGrant = (
    mesh: ReturnType<typeof makeMesh>,
    socket: FakeSocket,
    targetEnvironmentId: string,
    requestId = "request-1",
  ) =>
    mesh.say(socket, {
      type: "credentialRequest",
      requestId,
      targetEnvironmentId,
      jkt: "caller-key-thumbprint",
    });

  const verifyGrant = (grant: string, typ: string, nowMs: number) =>
    verifyRelayJwt({
      publicKey: mintKeys.publicKey,
      token: grant,
      typ,
      issuer: "https://relay.example.test",
      audience: "env-box",
      nowEpochSeconds: Math.floor(nowMs / 1_000),
    });

  it.effect("signs a short grant for an online member, bound to the caller's key", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        yield* mesh.join("env-box", "box");
        const laptop = yield* mesh.join("env-laptop", "laptop");
        yield* requestGrant(mesh, laptop, "env-box");
        yield* requestGrant(mesh, laptop, "env-box", "request-2");
        const [first, second] = credentialAnswers(laptop);
        if (first?.type !== "credentialGrant" || second?.type !== "credentialGrant") {
          return expect.unreachable(`expected grants, got ${JSON.stringify([first, second])}`);
        }
        expect(first.requestId).toBe("request-1");
        const claims = yield* verifyGrant(first.grant, MESH_GRANT_JWT_TYPE, START).pipe(
          Effect.flatMap(decodeGrantClaims),
        );
        expect(claims).toMatchObject({
          iss: "https://relay.example.test",
          sub: "user-1",
          aud: "env-box",
          meshCaller: "env-laptop",
          scope: "mesh:session",
          cnf: { jkt: "caller-key-thumbprint" },
        });
        expect(claims.exp - claims.iat).toBe(60);
        const secondClaims = yield* verifyGrant(second.grant, MESH_GRANT_JWT_TYPE, START).pipe(
          Effect.flatMap(decodeGrantClaims),
        );
        expect(secondClaims.jti).not.toBe(claims.jti);
      }),
    ),
  );

  it.effect("never passes as a mint request, and expires", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        yield* mesh.join("env-box", "box");
        const laptop = yield* mesh.join("env-laptop", "laptop");
        yield* requestGrant(mesh, laptop, "env-box");
        const [answer] = credentialAnswers(laptop);
        if (answer?.type !== "credentialGrant") return expect.unreachable("expected a grant");
        const asMint = yield* Effect.flip(verifyGrant(answer.grant, RELAY_MINT_REQUEST_TYP, START));
        expect(asMint._tag).toBe("RelayJwtError");
        // 60 s lifetime plus the verifier's 60 s clock tolerance.
        const late = yield* Effect.flip(
          verifyGrant(answer.grant, MESH_GRANT_JWT_TYPE, START + 121_000),
        );
        expect(late._tag).toBe("RelayJwtError");
      }),
    ),
  );

  it.effect("signs for the stored owner after a wake that names no user", () =>
    withMesh(
      Effect.gen(function* () {
        const shared = { sockets: [] as Array<FakeSocket> };
        const before = makeMesh(shared);
        yield* before.join("env-box", "box");
        const laptop = yield* before.join("env-laptop", "laptop");

        // A hibernated object wakes on a message: no worker call hands it the user id.
        const woken = makeMesh(shared);
        yield* requestGrant(woken, laptop, "env-box");
        const [answer] = credentialAnswers(laptop);
        if (answer?.type !== "credentialGrant") return expect.unreachable("expected a grant");
        const claims = yield* verifyGrant(answer.grant, MESH_GRANT_JWT_TYPE, START).pipe(
          Effect.flatMap(decodeGrantClaims),
        );
        expect(claims.sub).toBe("user-1");
      }),
    ),
  );

  it.effect("refuses a target outside this account's mesh, or offline", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        const box = yield* mesh.join("env-box", "box");
        const laptop = yield* mesh.join("env-laptop", "laptop");
        yield* requestGrant(mesh, laptop, "env-other-account");
        yield* mesh.drop(box);
        yield* TestClock.adjust(MESH_OFFLINE_GRACE_MS);
        laptop.lastPingAt = START + MESH_OFFLINE_GRACE_MS;
        yield* MeshHandlers.alarm(mesh.ctx);
        yield* requestGrant(mesh, laptop, "env-box", "request-2");
        expect(credentialAnswers(laptop)).toEqual([
          expect.objectContaining({ type: "credentialError", code: "not-member" }),
          expect.objectContaining({
            type: "credentialError",
            requestId: "request-2",
            code: "target-offline",
          }),
        ]);
      }),
    ),
  );

  it.effect("refuses a caller that has not said hello, and an account off the allowlist", () =>
    withMesh(
      Effect.gen(function* () {
        const mesh = makeMesh();
        yield* mesh.join("env-box", "box");
        const pending = yield* mesh.connect("env-laptop");
        yield* requestGrant(mesh, pending, "env-box");
        expect(credentialAnswers(pending)).toEqual([
          expect.objectContaining({ type: "credentialError", code: "not-member" }),
        ]);

        const offList = makeMesh({ sockets: mesh.sockets }, { allowlisted: false });
        const box = mesh.sockets[0]!;
        yield* requestGrant(offList, box, "env-box");
        expect(credentialAnswers(box)).toEqual([
          expect.objectContaining({ type: "credentialError", code: "not-allowlisted" }),
        ]);
      }),
    ),
  );
});
