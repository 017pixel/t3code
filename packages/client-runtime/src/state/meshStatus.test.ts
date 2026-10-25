import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type MeshMemberView,
  type MeshStatus,
  type RelayMeshResponse,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as MeshCaptain from "../connection/meshCaptain.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { CaptainPath } from "../connection/routes.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  buildMeshOverview,
  createMeshEnvironmentAtoms,
  isMeshOverviewVisible,
  meshCaptainRouteLabel,
  meshMachineMarkers,
  meshMemberNote,
} from "./meshStatus.ts";

const id = EnvironmentId.make;

const member = (
  environmentId: string,
  overrides: Partial<MeshMemberView> = {},
): MeshMemberView => ({
  environmentId: id(environmentId),
  label: environmentId,
  machineKind: null,
  serverVersion: "1.0.0",
  online: true,
  capabilities: { meshMember: true, meshAgents: true, meshGateway: true },
  connectHostname: `${environmentId}.t3.codes`,
  directEndpoints: [],
  captainEligible: true,
  ...overrides,
});

const status = (overrides: Partial<MeshStatus> = {}): MeshStatus => ({
  enabled: true,
  selfRole: "member",
  captain: null,
  pin: null,
  members: [],
  ...overrides,
});

const relay = (overrides: Partial<RelayMeshResponse> = {}): RelayMeshResponse => ({
  available: true,
  members: [],
  captain: null,
  pin: null,
  ...overrides,
});

describe("meshMemberNote", () => {
  it("says nothing for an eligible or offline member", () => {
    expect(meshMemberNote(member("box"), null)).toBeNull();
    expect(
      meshMemberNote(member("box", { online: false, capabilities: { meshMember: true } }), null),
    ).toBeNull();
  });

  it("puts a needed update before the route and captain reasons", () => {
    expect(
      meshMemberNote(
        member("box", {
          capabilities: { meshMember: true },
          connectHostname: null,
          captainEligible: false,
          ineligibleReason: "needs-update",
        }),
        null,
      ),
    ).toBe("Needs update");
  });

  it("names a member no other machine can reach", () => {
    expect(meshMemberNote(member("box", { connectHostname: null }), null)).toBe(
      "No route from other machines",
    );
  });

  it("says why a member cannot be captain, and that its pin is ignored", () => {
    const laptop = member("laptop", { captainEligible: false, ineligibleReason: "no-tunnel" });
    expect(meshMemberNote(laptop, null)).toBe("Cannot be captain: no T3 Connect tunnel");
    expect(meshMemberNote(laptop, id("laptop"))).toBe(
      "Pin ignored. Cannot be captain: no T3 Connect tunnel",
    );
  });
});

describe("buildMeshOverview", () => {
  it("lists the relay's members and the connected machines outside the mesh", () => {
    const mesh = relay({
      members: [member("vps", { online: false }), member("box")],
      captain: id("box"),
      pin: id("vps"),
    });
    const overview = buildMeshOverview({
      mesh,
      connected: [id("laptop"), id("vps"), id("box")],
      statuses: [
        {
          environmentId: id("laptop"),
          status: status({ enabled: false, selfRole: "off", unavailableReason: "disabled" }),
        },
      ],
    });
    // The offline member cannot carry a pin, so pins go through the online one.
    expect(overview.sourceEnvironmentId).toBe(id("box"));
    expect(
      overview.members.map((row) => [
        row.member.environmentId,
        row.captain,
        row.pinned,
        row.connected,
      ]),
    ).toEqual([
      [id("vps"), false, true, true],
      [id("box"), true, false, true],
    ]);
    expect(overview.outside).toEqual([
      { environmentId: id("laptop"), enabled: false, note: "Left the mesh" },
    ]);
    expect(meshMachineMarkers(mesh)).toEqual(
      new Map([
        [id("vps"), "offline"],
        [id("box"), "captain"],
      ]),
    );
  });

  it("drops a machine that left before the relay read catches up", () => {
    const overview = buildMeshOverview({
      mesh: relay({ members: [member("box"), member("laptop")], captain: id("box") }),
      connected: [id("laptop")],
      statuses: [
        {
          environmentId: id("laptop"),
          status: status({ enabled: false, selfRole: "member" }),
        },
      ],
    });
    expect(overview.members.map((row) => row.member.environmentId)).toEqual([id("box")]);
    expect(overview.sourceEnvironmentId).toBeNull();
    expect(overview.outside).toEqual([
      { environmentId: id("laptop"), enabled: false, note: "Left the mesh" },
    ]);
  });

  it("stays hidden off the allowlist, and shows a machine that left", () => {
    const off = [
      {
        environmentId: id("box"),
        status: status({ selfRole: "off", unavailableReason: "not-allowlisted" }),
      },
    ];
    const hidden = buildMeshOverview({
      mesh: relay({ available: false, members: [member("box")] }),
      connected: [id("box")],
      statuses: off,
    });
    expect(hidden.members).toEqual([]);
    expect(isMeshOverviewVisible(hidden, off)).toBe(false);
    expect(meshMachineMarkers(relay({ available: false, captain: id("box") })).size).toBe(0);
    const left = [
      {
        environmentId: id("box"),
        status: status({ enabled: false, selfRole: "off", unavailableReason: "disabled" }),
      },
    ];
    expect(
      isMeshOverviewVisible(buildMeshOverview({ mesh: null, connected: [], statuses: left }), left),
    ).toBe(true);
  });
});

describe("meshCaptainRouteLabel", () => {
  it("names the captain only for a connection on a captain route", () => {
    const mesh = relay({ members: [member("box", { label: "Box" })], captain: id("box") });
    expect(meshCaptainRouteLabel({ captain: id("box") }, mesh)).toBe("via Box");
    expect(meshCaptainRouteLabel({ captain: id("box") }, null)).toBe("via captain");
    expect(meshCaptainRouteLabel({}, mesh)).toBeNull();
  });
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: id("box"),
  label: "Box",
  httpBaseUrl: "https://box.example.test",
  wsBaseUrl: "wss://box.example.test",
});

const makeHarness = Effect.fn("MeshStatusTest.makeHarness")(function* () {
  let statusReads = 0;
  let relayReads = 0;
  const client = {
    [WS_METHODS.meshStatus]: () =>
      Effect.sync(() => {
        statusReads += 1;
        return status({ enabled: false, selfRole: "off", unavailableReason: "disabled" });
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const captain = MeshCaptain.MeshCaptain.of({
    state: yield* SubscriptionRef.make<MeshCaptain.MeshCaptainState>({
      mesh: relay({
        members: [member("box"), member("vps", { online: false })],
        captain: TARGET.environmentId,
      }),
      saved: null,
    }),
    paths: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, CaptainPath>>(new Map()),
    observeConnection: () => Effect.void,
    reportRouteFailure: () => Effect.void,
    betterRouteTick: () => Effect.void,
    refresh: Effect.sync(() => {
      relayReads += 1;
    }),
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(MeshCaptain.MeshCaptain, captain),
    ),
  );
  const config = {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { serverVersion: "1.0.0", capabilities: { meshMember: true } },
  } as ServerConfig;
  const atoms = createMeshEnvironmentAtoms(runtime, {
    serverConfigsAtom: Atom.make(new Map([[TARGET.environmentId, config]])),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return {
    atoms,
    registry,
    statusReads: () => statusReads,
    relayReads: () => relayReads,
  };
});

describe("createMeshEnvironmentAtoms", () => {
  it.effect("marks machines from the relay read without asking any machine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const markers = yield* AtomRegistry.toStream(
          harness.registry,
          harness.atoms.markersAtom,
        ).pipe(
          Stream.filter((current) => current.size > 0),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(markers).toEqual(
          new Map([
            [id("box"), "captain"],
            [id("vps"), "offline"],
          ]),
        );
        expect(harness.statusReads()).toBe(0);
        expect(harness.relayReads()).toBe(0);
      }),
    ),
  );

  it.effect("reads each machine's status and the relay once when the Mesh section opens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { overview } = yield* AtomRegistry.toStream(
          harness.registry,
          harness.atoms.overviewAtom,
        ).pipe(
          Stream.filter(({ overview }) => overview.outside.length > 0),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        // The relay still lists box, but box says it left.
        expect(overview.members.map((row) => row.member.environmentId)).toEqual([id("vps")]);
        expect(overview.outside).toEqual([
          { environmentId: id("box"), enabled: false, note: "Left the mesh" },
        ]);
        expect(harness.statusReads()).toBe(1);
        expect(harness.relayReads()).toBe(1);
      }),
    ),
  );
});
