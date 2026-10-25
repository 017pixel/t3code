import {
  EnvironmentId,
  MeshCloseCode,
  type MeshMemberView,
  type RelayMeshResponse,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import * as MeshCaptain from "./meshCaptain.ts";
import {
  ConnectionTransientError,
  RelayConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import { captainRoute, connectionRouteId, type CaptainPath } from "./routes.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const ACCOUNT = "user-1";
const CAPTAIN_A = EnvironmentId.make("captain-a");
const CAPTAIN_B = EnvironmentId.make("captain-b");
const MEMBER = EnvironmentId.make("member-1");
const JOINED = EnvironmentId.make("member-2");
const OTHER = EnvironmentId.make("member-3");
const A_LAN = "http://192.168.1.5:3773/";
const A_TUNNEL = "https://captain-a.t3.test/";
const B_TUNNEL = "https://captain-b.t3.test/";
const UNAVAILABLE: RelayMeshResponse = { available: false, members: [], captain: null, pin: null };
/** A live session to a mesh-capable server, off its captain route. */
const OFF_CAPTAIN = { onCaptainRoute: false, meshMember: true } as const;

const memberView = (
  environmentId: EnvironmentId,
  overrides: Partial<MeshMemberView> = {},
): MeshMemberView => ({
  environmentId,
  label: environmentId,
  machineKind: null,
  serverVersion: "1.0.0",
  online: true,
  capabilities: { meshMember: true, meshGateway: true },
  connectHostname: `${environmentId}.t3.test`,
  directEndpoints: [],
  captainEligible: true,
  ...overrides,
});

const meshWith = (captain: EnvironmentId | null): RelayMeshResponse => ({
  available: true,
  members: [memberView(CAPTAIN_A), memberView(CAPTAIN_B), memberView(MEMBER)],
  captain,
  pin: null,
});

const viaPath = (address: string, handle: string, environmentId = MEMBER) =>
  `${address}api/mesh/via/${handle}/${environmentId}`;

/** The client's own connection to a captain, over a Connect credential. */
const captainConnection = (environmentId: EnvironmentId, httpBaseUrl: string) =>
  ({
    environmentId,
    label: environmentId,
    httpBaseUrl,
    socketUrl: "ws://unused.invalid/ws",
    httpAuthorization: { _tag: "Dpop", accessToken: "token", expiresAtEpochMs: 3_600_000 },
    target: new RelayConnectionTarget({ environmentId, label: environmentId }),
  }) satisfies PreparedConnection;

/** Wakeups one second apart, so each `TestClock.adjust("1 second")` delivers the next one. */
const wakeupsEverySecond = (...reasons: ReadonlyArray<ConnectionWakeups.ConnectionWakeup>) =>
  Stream.fromIterable(reasons).pipe(
    Stream.mapEffect((reason) => Effect.sleep("1 second").pipe(Effect.as(reason))),
  );

const makeMesh = Effect.fn("MeshCaptainTest.makeMesh")(function* (options?: {
  readonly saved?: MeshCaptain.SavedMeshCaptain;
  readonly relay?: RelayMeshResponse | "pending" | Effect.Effect<RelayMeshResponse>;
  /** The signed-in Connect account; null while the session is still loading. */
  readonly identity?: string | null;
  readonly wakeups?: Stream.Stream<ConnectionWakeups.ConnectionWakeup>;
}) {
  const relayMesh = yield* Ref.make<
    RelayMeshResponse | "pending" | Effect.Effect<RelayMeshResponse>
  >(options?.relay ?? meshWith(CAPTAIN_A));
  const reads = yield* Ref.make(0);
  let identity = options?.identity === undefined ? ACCOUNT : options.identity;
  const mints: Array<string> = [];
  /** Every request that carried a credential, by URL. */
  const credentialed: Array<string> = [];
  const proofs: Array<string> = [];
  const handles = new Map<string, string>([
    [A_LAN, "handle-a"],
    [A_TUNNEL, "handle-a-tunnel"],
    [B_TUNNEL, "handle-b"],
  ]);
  /** The members the captain reaches when it mints. */
  const mintRoutes: Array<EnvironmentId> = [CAPTAIN_A, CAPTAIN_B, MEMBER];
  let saved = Option.fromUndefinedOr(options?.saved);
  const unused = () => Effect.die("unused");
  const relay = ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.t3.test",
    listEnvironments: unused,
    listDevices: unused,
    getMesh: () =>
      Ref.update(reads, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(relayMesh)),
        Effect.flatMap((mesh) =>
          mesh === "pending" ? Effect.never : Effect.isEffect(mesh) ? mesh : Effect.succeed(mesh),
        ),
      ),
    createEnvironmentLinkChallenge: unused,
    linkEnvironment: unused,
    unlinkEnvironment: unused,
    getEnvironmentStatus: unused,
    connectEnvironment: unused,
    registerDevice: unused,
    unregisterDevice: unused,
    registerLiveActivity: unused,
    getAgentActivitySnapshot: unused,
    resetTokenCache: Effect.void,
  });
  const fetchFn: typeof fetch = async (request, init) => {
    const url = String(request);
    mints.push(url);
    if (new Headers(init?.headers).has("authorization")) credentialed.push(url);
    const address = url.replace(/api\/mesh\/via$/, "");
    const handle = handles.get(address);
    return handle === undefined
      ? new Response(null, { status: 503 })
      : Response.json({ handle, routes: mintRoutes });
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
    Layer.succeed(
      ManagedRelay.ManagedRelayDpopSigner,
      ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("thumbprint"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input.url);
            return "proof";
          }),
      }),
    ),
    Layer.succeed(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: unused,
        authorizeDpop: unused,
        authorizeDpopHttp: (input) =>
          Effect.succeed({
            environmentId: input.expectedEnvironmentId,
            label: input.expectedEnvironmentId,
            httpBaseUrl: `https://${input.expectedEnvironmentId}.t3.test/`,
            httpAuthorization: { _tag: "Dpop", accessToken: "token", expiresAtEpochMs: 3_600_000 },
          }),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        identity: Effect.sync(() =>
          identity === null ? Option.none() : Option.some({ accountId: identity }),
        ),
        clerkToken: Effect.succeed("clerk-token"),
      }),
    ),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: options?.wakeups ?? Stream.never }),
    ),
    Layer.succeed(MeshCaptain.MeshCaptainStore, {
      load: Effect.sync(() => saved),
      save: (next) =>
        Effect.sync(() => {
          saved = next;
        }),
    }),
    RpcHttp.layerRemoteHttpClient(fetchFn),
  );
  const mesh = yield* MeshCaptain.make.pipe(Effect.provide(layer));
  return {
    mesh,
    reads,
    mints,
    credentialed,
    proofs,
    handles,
    mintRoutes,
    saved: () => saved,
    setRelay: (next: RelayMeshResponse) => Ref.set(relayMesh, next),
    setIdentity: (next: string | null) =>
      Effect.sync(() => {
        identity = next;
      }),
  };
});

const pathFor = (mesh: MeshCaptain.MeshCaptain["Service"], environmentId = MEMBER) =>
  SubscriptionRef.get(mesh.paths).pipe(Effect.map((paths) => paths.get(environmentId)));

const awaitPath = (mesh: MeshCaptain.MeshCaptain["Service"], httpBaseUrl: string) =>
  SubscriptionRef.changes(mesh.paths).pipe(
    Stream.filter((paths) => paths.get(MEMBER)?.httpBaseUrl === httpBaseUrl),
    Stream.runHead,
  );

/** Reads once so the relay's captain is known, then reports the client's route to it. */
const connectToCaptain = Effect.fn("MeshCaptainTest.connectToCaptain")(function* (
  harness: Effect.Success<ReturnType<typeof makeMesh>>,
) {
  yield* harness.mesh.refresh;
  yield* harness.mesh.observeConnection(
    CAPTAIN_B,
    Option.some(captainConnection(CAPTAIN_B, B_TUNNEL)),
  );
  yield* harness.mesh.observeConnection(
    CAPTAIN_A,
    Option.some(captainConnection(CAPTAIN_A, A_LAN)),
  );
  yield* awaitPath(harness.mesh, viaPath(A_LAN, "handle-a"));
});

const SAVED_A: MeshCaptain.SavedMeshCaptain = {
  accountId: ACCOUNT,
  captain: CAPTAIN_A,
  address: A_LAN,
  handle: "saved-handle",
  routes: [MEMBER],
};

describe("MeshCaptain", () => {
  it.effect("races the saved captain at cold start, before the first relay read", () =>
    Effect.gen(function* () {
      const { mesh } = yield* makeMesh({ relay: "pending", saved: SAVED_A });
      expect(yield* pathFor(mesh)).toEqual({
        captain: CAPTAIN_A,
        httpBaseUrl: viaPath(A_LAN, "saved-handle"),
      });
    }),
  );

  it.effect("publishes a saved captain only for the account that saved it", () =>
    Effect.gen(function* () {
      const other = yield* makeMesh({ relay: "pending", saved: SAVED_A, identity: "user-2" });
      expect(yield* pathFor(other.mesh)).toBeUndefined();

      // A session still loading shows nothing until its account is known.
      const loading = yield* makeMesh({
        relay: "pending",
        saved: SAVED_A,
        identity: null,
        wakeups: wakeupsEverySecond("credentials-changed"),
      });
      expect(yield* pathFor(loading.mesh)).toBeUndefined();
      yield* loading.setIdentity(ACCOUNT);
      yield* TestClock.adjust("1 second");
      expect((yield* pathFor(loading.mesh))?.httpBaseUrl).toBe(viaPath(A_LAN, "saved-handle"));
    }),
  );

  it.effect("keeps the saved captain across a sign-out and an account switch", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh({
        relay: "pending",
        saved: SAVED_A,
        wakeups: wakeupsEverySecond(
          "credentials-changed",
          "credentials-changed",
          "credentials-changed",
        ),
      });
      yield* harness.setIdentity(null);
      yield* TestClock.adjust("1 second");
      expect(yield* pathFor(harness.mesh)).toBeUndefined();
      yield* harness.setIdentity("user-2");
      yield* TestClock.adjust("1 second");
      expect(yield* pathFor(harness.mesh)).toBeUndefined();
      expect(Option.getOrThrow(harness.saved())).toEqual(SAVED_A);

      yield* harness.setIdentity(ACCOUNT);
      yield* TestClock.adjust("1 second");
      expect((yield* pathFor(harness.mesh))?.httpBaseUrl).toBe(viaPath(A_LAN, "saved-handle"));
    }),
  );

  it.effect.each([false, true])(
    "discards an old account's deferred mesh read (available: %s)",
    (available) =>
      Effect.gen(function* () {
        const response = yield* Deferred.make<RelayMeshResponse>();
        const readStarted = yield* Deferred.make<void>();
        const harness = yield* makeMesh({
          saved: SAVED_A,
          relay: Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(response)),
          ),
          wakeups: wakeupsEverySecond("credentials-changed", "application-active"),
        });
        yield* Deferred.await(readStarted);
        const oldRead = yield* harness.mesh.refresh.pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* harness.setIdentity("user-2");
        const nextMesh = meshWith(CAPTAIN_B);
        yield* harness.setRelay(nextMesh);
        yield* TestClock.adjust("1 second");
        const afterSwitch = yield* Ref.get(harness.reads);
        const stateAfterSwitch = yield* SubscriptionRef.get(harness.mesh.state);

        yield* Deferred.succeed(response, available ? meshWith(CAPTAIN_A) : UNAVAILABLE);
        yield* Fiber.join(oldRead);
        expect(afterSwitch).toBe(2);
        expect(stateAfterSwitch).toEqual({ mesh: nextMesh, saved: null });
        expect(yield* SubscriptionRef.get(harness.mesh.state)).toEqual(stateAfterSwitch);
        expect(yield* pathFor(harness.mesh)).toBeUndefined();
        expect(Option.getOrThrow(harness.saved())).toEqual(SAVED_A);

        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(harness.reads)).toBe(3);
      }),
  );

  it.effect("mints a handle over the client's own route to the captain", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      const { mesh } = harness;
      yield* mesh.refresh;
      expect(yield* pathFor(mesh)).toBeUndefined();

      yield* mesh.observeConnection(CAPTAIN_A, Option.some(captainConnection(CAPTAIN_A, A_LAN)));
      yield* awaitPath(mesh, viaPath(A_LAN, "handle-a"));
      expect(yield* pathFor(mesh)).toEqual({
        captain: CAPTAIN_A,
        httpBaseUrl: viaPath(A_LAN, "handle-a"),
      });
      // The captain is never routed through itself.
      expect(yield* pathFor(mesh, CAPTAIN_A)).toBeUndefined();
      expect(harness.mints).toEqual([`${A_LAN}api/mesh/via`]);
      expect(harness.proofs).toContain(`${A_LAN}api/mesh/via`);
      expect(Option.getOrThrow(harness.saved())).toMatchObject({
        captain: CAPTAIN_A,
        address: A_LAN,
        handle: "handle-a",
      });

      // The same captain at the same address keeps its handle: a read mints nothing and
      // publishes nothing, so supervisors do not recheck routes.
      const before = yield* SubscriptionRef.get(mesh.paths);
      const reads = yield* Ref.get(harness.reads);
      yield* mesh.refresh;
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);
      expect(harness.mints).toHaveLength(1);
      expect(yield* SubscriptionRef.get(mesh.paths)).toBe(before);
    }),
  );

  it.effect("never sends the captain credential to a saved address it has not checked", () =>
    Effect.gen(function* () {
      // The saved LAN address now belongs to another machine.
      const harness = yield* makeMesh({ saved: SAVED_A });
      yield* harness.mesh.refresh;
      const path = Option.getOrThrow(Option.fromUndefinedOr(yield* pathFor(harness.mesh)));
      // Even a 421 that asks for a new handle does not mint at the saved address.
      yield* harness.mesh.reportRouteFailure(path, "refused");
      yield* harness.mesh.refresh;
      expect(harness.credentialed).toEqual([]);
      expect(yield* pathFor(harness.mesh)).toBeUndefined();

      // The client's own session to the captain checked its descriptor, so the mint goes there.
      yield* harness.mesh.observeConnection(
        CAPTAIN_A,
        Option.some(captainConnection(CAPTAIN_A, A_TUNNEL)),
      );
      yield* awaitPath(harness.mesh, viaPath(A_TUNNEL, "handle-a-tunnel"));
      expect(harness.credentialed).toEqual([`${A_TUNNEL}api/mesh/via`]);
    }),
  );

  it.effect("does not mint over a cookie session such as the captain's own desktop", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* harness.mesh.refresh;
      yield* harness.mesh.observeConnection(
        CAPTAIN_A,
        Option.some({
          ...captainConnection(CAPTAIN_A, "http://127.0.0.1:3773/"),
          httpAuthorization: null,
        }),
      );
      yield* harness.mesh.refresh;
      expect(harness.mints).toEqual([]);
      expect(yield* pathFor(harness.mesh)).toBeUndefined();
    }),
  );

  it.effect("mints again when a member joins after the handle was minted", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const mints = harness.mints.length;

      harness.mintRoutes.push(JOINED);
      const joined = meshWith(CAPTAIN_A);
      yield* harness.setRelay({ ...joined, members: [...joined.members, memberView(JOINED)] });
      yield* harness.mesh.refresh;
      expect(yield* pathFor(harness.mesh, JOINED)).toEqual({
        captain: CAPTAIN_A,
        httpBaseUrl: viaPath(A_LAN, "handle-a", JOINED),
      });
      expect(harness.mints).toHaveLength(mints + 1);
      expect(Option.getOrThrow(harness.saved()).routes).toContain(JOINED);
    }),
  );

  it.effect("mints a new handle at once after the captain refuses one", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const path = Option.getOrThrow(Option.fromUndefinedOr(yield* pathFor(harness.mesh)));

      harness.handles.set(A_LAN, "handle-a2");
      yield* harness.mesh.reportRouteFailure(path, "refused");
      yield* awaitPath(harness.mesh, viaPath(A_LAN, "handle-a2"));
    }),
  );

  it.effect("moves every member path to a new captain and drops the old handle", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      expect((yield* pathFor(harness.mesh))?.captain).toBe(CAPTAIN_A);

      yield* harness.setRelay(meshWith(CAPTAIN_B));
      yield* harness.mesh.refresh;
      expect(yield* pathFor(harness.mesh)).toEqual({
        captain: CAPTAIN_B,
        httpBaseUrl: viaPath(B_TUNNEL, "handle-b"),
      });
      expect(Option.getOrThrow(harness.saved()).captain).toBe(CAPTAIN_B);
    }),
  );

  it.effect("reads the mesh on a better-route tick only while a member is off its captain", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const reads = yield* Ref.get(harness.reads);

      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(MEMBER, { onCaptainRoute: true, meshMember: true });
      yield* harness.mesh.betterRouteTick(CAPTAIN_A, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads);

      yield* harness.mesh.betterRouteTick(MEMBER, OFF_CAPTAIN);
      // Every member's tick in the same interval shares that read.
      yield* harness.mesh.betterRouteTick(CAPTAIN_B, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);
    }),
  );

  it.effect("finds a replacement captain at cold start with nothing saved", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      // The first read names A while A is in its offline grace; A never connects.
      yield* harness.mesh.refresh;
      yield* harness.mesh.observeConnection(
        CAPTAIN_B,
        Option.some(captainConnection(CAPTAIN_B, B_TUNNEL)),
      );
      const reads = yield* Ref.get(harness.reads);

      yield* harness.setRelay(meshWith(CAPTAIN_B));
      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(MEMBER, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);
      expect((yield* SubscriptionRef.get(harness.mesh.state)).mesh?.captain).toBe(CAPTAIN_B);
      expect(yield* pathFor(harness.mesh)).toEqual({
        captain: CAPTAIN_B,
        httpBaseUrl: viaPath(B_TUNNEL, "handle-b"),
      });
    }),
  );

  it.effect("reads on a tick for a connected member that joined after the last read", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const reads = yield* Ref.get(harness.reads);
      harness.mintRoutes.push(JOINED);
      const joined = meshWith(CAPTAIN_A);
      yield* harness.setRelay({ ...joined, members: [...joined.members, memberView(JOINED)] });

      yield* TestClock.adjust("60 seconds");
      // A server that cannot join a mesh is not worth a read.
      yield* harness.mesh.betterRouteTick(JOINED, { onCaptainRoute: false, meshMember: false });
      expect(yield* Ref.get(harness.reads)).toBe(reads);
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);
      expect(yield* pathFor(harness.mesh, JOINED)).toEqual({
        captain: CAPTAIN_A,
        httpBaseUrl: viaPath(A_LAN, "handle-a", JOINED),
      });
    }),
  );

  it.effect("reads once for a connected server that stays out of the mesh, not every tick", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const reads = yield* Ref.get(harness.reads);

      // Every server advertises meshMember, including one that left or belongs to another account.
      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);
      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);

      // A change in the member list earns it one more read.
      const changed = meshWith(CAPTAIN_A);
      yield* harness.setRelay({ ...changed, members: [...changed.members, memberView(OTHER)] });
      yield* harness.mesh.refresh;
      const afterChange = yield* Ref.get(harness.reads);
      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(afterChange + 1);
    }),
  );

  it.effect("discovers a server that joins after its first unlisted read on a later tick", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const reads = yield* Ref.get(harness.reads);

      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);
      expect(yield* pathFor(harness.mesh, JOINED)).toBeUndefined();

      harness.mintRoutes.push(JOINED);
      const joined = meshWith(CAPTAIN_A);
      yield* harness.setRelay({ ...joined, members: [...joined.members, memberView(JOINED)] });
      yield* TestClock.adjust("4 minutes");
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 1);

      yield* TestClock.adjust("60 seconds");
      yield* harness.mesh.betterRouteTick(MEMBER, { onCaptainRoute: true, meshMember: true });
      yield* harness.mesh.betterRouteTick(CAPTAIN_B, { onCaptainRoute: true, meshMember: true });
      yield* harness.mesh.betterRouteTick(JOINED, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 2);
      expect(yield* pathFor(harness.mesh, JOINED)).toEqual({
        captain: CAPTAIN_A,
        httpBaseUrl: viaPath(A_LAN, "handle-a", JOINED),
      });

      yield* harness.mesh.betterRouteTick(OTHER, OFF_CAPTAIN);
      expect(yield* Ref.get(harness.reads)).toBe(reads + 2);
    }),
  );

  it.effect("reads again for an account without the mesh only on a credential change", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh({
        relay: UNAVAILABLE,
        wakeups: wakeupsEverySecond("application-active", "network-changed", "credentials-changed"),
      });
      yield* harness.mesh.refresh;
      expect(yield* Ref.get(harness.reads)).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(harness.reads)).toBe(1);

      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(harness.reads)).toBe(2);
      // Opening the Mesh section reads too.
      yield* harness.mesh.refresh;
      expect(yield* Ref.get(harness.reads)).toBe(3);
    }),
  );

  it.effect("drops every path when the relay names no gateway captain", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      expect(yield* pathFor(harness.mesh)).toBeDefined();

      yield* harness.setRelay({
        ...meshWith(CAPTAIN_A),
        members: [
          memberView(CAPTAIN_A, { capabilities: { meshMember: true } }),
          memberView(MEMBER),
        ],
      });
      yield* harness.mesh.refresh;
      expect((yield* SubscriptionRef.get(harness.mesh.paths)).size).toBe(0);
      expect(Option.isNone(harness.saved())).toBe(true);
    }),
  );
});

// A supervisor wired to the mesh the way the registry wires it, over a driver whose routes are
// up or down by captain.
const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId: MEMBER, label: "Member" }),
  profile: Option.none(),
  enabled: true,
};

const routeCaptain = (route: ConnectionRoute) => {
  const profile = Option.getOrNull(route.profile);
  return profile?._tag === "BearerConnectionProfile" ? (profile.captain ?? null) : null;
};

const makeMemberSupervisor = Effect.fn("MeshCaptainTest.makeMemberSupervisor")(function* (
  mesh: MeshCaptain.MeshCaptain["Service"],
  alive: Ref.Ref<ReadonlySet<EnvironmentId>>,
) {
  const sessions: Array<Deferred.Deferred<never, ConnectionTransientError>> = [];
  const up = (route: ConnectionRoute) =>
    Ref.get(alive).pipe(
      Effect.map((captains) => {
        const captain = routeCaptain(route);
        return captain === null || captains.has(captain);
      }),
    );
  const driver = ConnectionDriver.ConnectionDriver.of({
    connect: (entry, reportProgress) =>
      ConnectionDriver.connectOverRoutes(
        entry,
        (route) => up(route).pipe(Effect.map((ok) => (ok ? "answered" : "silent"))),
        Effect.fnUntraced(function* (route) {
          if (!(yield* up(route))) {
            return yield* new ConnectionTransientError({ reason: "transport", detail: "down" });
          }
          const prepared: PreparedConnection = {
            environmentId: MEMBER,
            label: "Member",
            httpBaseUrl: "https://member.t3.test/",
            socketUrl: "wss://member.t3.test/ws",
            httpAuthorization: null,
            target: route.target,
          };
          yield* reportProgress({ stage: "opening", prepared });
          const closed = yield* Deferred.make<never, ConnectionTransientError>();
          sessions.push(closed);
          return {
            prepared,
            session: {
              client: {} as WsRpcProtocolClient,
              initialConfig: Effect.fail(
                new ConnectionTransientError({ reason: "transport", detail: "unused" }),
              ),
              subscribeServerConfig: () => Stream.never,
              ready: Effect.void,
              probe: Effect.void,
              closed: Deferred.await(closed),
            },
          };
        }),
      ),
    checkRoute: (_entry, route) =>
      up(route).pipe(Effect.map((ok): ConnectionDriver.RouteCheck => (ok ? "answered" : "silent"))),
    preflight: (_entry, route) => up(route),
  });
  const routesFrom = (paths: ReadonlyMap<EnvironmentId, CaptainPath>) => {
    const path = paths.get(MEMBER);
    return path === undefined ? [] : [captainRoute(RELAY_ENTRY.target, path)];
  };
  const captainChanges = yield* Ref.make(0);
  const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
    initiallyDesired: true,
    mesh: {
      initialRoutes: routesFrom(yield* SubscriptionRef.get(mesh.paths)),
      routes: SubscriptionRef.changes(mesh.paths).pipe(Stream.map(routesFrom)),
      beforeBetterRouteCheck: (session) => mesh.betterRouteTick(MEMBER, session),
      captainChanged: Ref.update(captainChanges, (count) => count + 1).pipe(
        Effect.andThen(mesh.refresh),
        Effect.andThen(SubscriptionRef.get(mesh.paths)),
        Effect.map(routesFrom),
      ),
    },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
        Layer.succeed(
          Connectivity.Connectivity,
          Connectivity.Connectivity.of({
            status: Effect.succeed("online"),
            changes: Stream.never,
          }),
        ),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
        ),
      ),
    ),
  );
  const close = (error: ConnectionTransientError) => Deferred.fail(sessions.at(-1)!, error);
  return { supervisor, close, captainChanges };
});

const connectedVia = (
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
  captain: EnvironmentId | null,
) =>
  SubscriptionRef.changes(supervisor.state).pipe(
    Stream.filter((state: SupervisorConnectionState) => state.phase === "connected"),
    Stream.mapEffect(() => SubscriptionRef.get(supervisor.prepared)),
    Stream.filter((prepared) => {
      if (Option.isNone(prepared)) return false;
      const target = prepared.value.target;
      return captain === null
        ? target._tag === "RelayConnectionTarget"
        : target._tag === "BearerConnectionTarget" &&
            connectionRouteId(target).startsWith(`captain:${captain}@`);
    }),
    Stream.runHead,
  );

describe("captain route with an active client", () => {
  it.effect("moves every member to the new captain when the old one is demoted", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const alive = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set([CAPTAIN_A, CAPTAIN_B]));
      const member = yield* makeMemberSupervisor(harness.mesh, alive);
      yield* connectedVia(member.supervisor, CAPTAIN_A);

      yield* harness.setRelay(meshWith(CAPTAIN_B));
      yield* member.close(
        new ConnectionTransientError({
          reason: "transport",
          detail: "Captain changed.",
          closeCode: MeshCloseCode.captainChanged,
        }),
      );
      yield* connectedVia(member.supervisor, CAPTAIN_B);
      expect(yield* Ref.get(member.captainChanges)).toBe(1);
      // The reconnect skipped the retry backoff.
      expect((yield* SubscriptionRef.get(member.supervisor.state)).attempt).toBe(1);
    }),
  );

  it.effect("falls back when the captain crashes and lands on the newly elected captain", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const alive = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set([CAPTAIN_A, CAPTAIN_B]));
      const member = yield* makeMemberSupervisor(harness.mesh, alive);
      yield* connectedVia(member.supervisor, CAPTAIN_A);

      // A crashed captain sends nothing; the socket just dies and the relay still lists it.
      yield* Ref.set(alive, new Set([CAPTAIN_B]));
      yield* member.close(new ConnectionTransientError({ reason: "transport", detail: "Lost." }));
      // Past the retry backoff.
      yield* TestClock.adjust("2 seconds");
      yield* connectedVia(member.supervisor, null);

      // After its offline timeout the relay elects B; the next better-route tick finds it.
      yield* harness.setRelay(meshWith(CAPTAIN_B));
      yield* TestClock.adjust("60 seconds");
      yield* connectedVia(member.supervisor, CAPTAIN_B);
    }),
  );

  it.effect("keeps reading after a crashed captain until the relay names the next one", () =>
    Effect.gen(function* () {
      const harness = yield* makeMesh();
      yield* connectToCaptain(harness);
      const alive = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set([CAPTAIN_A, CAPTAIN_B]));
      const member = yield* makeMemberSupervisor(harness.mesh, alive);
      yield* connectedVia(member.supervisor, CAPTAIN_A);

      yield* Ref.set(alive, new Set([CAPTAIN_B]));
      yield* harness.mesh.observeConnection(CAPTAIN_A, Option.none());
      yield* member.close(new ConnectionTransientError({ reason: "transport", detail: "Lost." }));
      yield* TestClock.adjust("2 seconds");
      yield* connectedVia(member.supervisor, null);

      // A is offline and B cannot be captain yet, so the relay names no captain for a while.
      yield* harness.setRelay({
        ...meshWith(null),
        members: [
          memberView(CAPTAIN_A, { online: false }),
          memberView(CAPTAIN_B),
          memberView(MEMBER),
        ],
      });
      yield* TestClock.adjust("60 seconds");
      expect((yield* SubscriptionRef.get(harness.mesh.state)).mesh?.captain).toBeNull();

      yield* harness.setRelay(meshWith(CAPTAIN_B));
      yield* TestClock.adjust("60 seconds");
      yield* connectedVia(member.supervisor, CAPTAIN_B);
      // No mint ever went to the crashed captain after the first one.
      expect(harness.mints.filter((url) => url.startsWith(A_LAN))).toHaveLength(1);
    }),
  );
});
