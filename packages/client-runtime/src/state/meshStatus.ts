// EXPERIMENTAL mesh v1: what clients show about the mesh. Members, presence, captain and pin come
// from the client's relay read (`MeshCaptain`). Each machine's own `mesh.status` says whether it
// left; only the Settings Mesh section reads it, and mutations reread it.
import {
  type EnvironmentId,
  type MeshMemberView,
  type MeshStatus,
  type MeshUnavailableReason,
  type RelayMeshResponse,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as MeshCaptain from "../connection/meshCaptain.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  selectEnvironmentQueryData,
} from "./runtime.ts";

export interface MeshEnvironmentStatus {
  readonly environmentId: EnvironmentId;
  readonly status: MeshStatus;
}

export interface MeshMemberRow {
  readonly member: MeshMemberView;
  readonly captain: boolean;
  readonly pinned: boolean;
  /** Why the member cannot fully take part, or null. */
  readonly note: string | null;
  /** This client is connected to the member, so it can ask it to leave. */
  readonly connected: boolean;
}

/** A connected environment that is not in the mesh right now. */
export interface MeshOutsideRow {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly note: string;
}

export interface MeshOverview {
  /** A connected online member that pins go through, or null. */
  readonly sourceEnvironmentId: EnvironmentId | null;
  readonly captain: EnvironmentId | null;
  readonly pin: EnvironmentId | null;
  readonly members: ReadonlyArray<MeshMemberRow>;
  readonly outside: ReadonlyArray<MeshOutsideRow>;
}

export interface MeshOverviewInput {
  /** The relay read. Null before the first one, or when the client is not signed in to Connect. */
  readonly mesh: RelayMeshResponse | null;
  /** Environments this client connects to that can be mesh members. */
  readonly connected: ReadonlyArray<EnvironmentId>;
  readonly statuses: ReadonlyArray<MeshEnvironmentStatus>;
}

export type MeshMachineMarker = "captain" | "offline";

const EMPTY_MARKERS: ReadonlyMap<EnvironmentId, MeshMachineMarker> = new Map();

/** One reason line for an online member that cannot fully take part. Offline members get none. */
export function meshMemberNote(member: MeshMemberView, pin: EnvironmentId | null): string | null {
  if (!member.online) return null;
  if (member.capabilities.meshAgents !== true || member.ineligibleReason === "needs-update") {
    return "Needs update";
  }
  if (member.connectHostname === null && member.directEndpoints.length === 0) {
    return "No route from other machines";
  }
  const captainNote =
    member.ineligibleReason === "no-tunnel"
      ? "Cannot be captain: no T3 Connect tunnel"
      : member.ineligibleReason === "not-gateway"
        ? "Cannot be captain"
        : null;
  if (captainNote === null) return null;
  return member.environmentId === pin ? `Pin ignored. ${captainNote}` : captainNote;
}

function meshUnavailableNote(reason: MeshUnavailableReason | undefined): string {
  switch (reason) {
    case "disabled":
      return "Left the mesh";
    case "not-linked":
      return "Not linked to T3 Connect";
    case "shared-key":
      return "Shared machine: linked to more than one T3 Connect account";
    case "not-allowlisted":
      return "Mesh is not available for this account yet";
    case "connecting":
      return "Connecting";
    case undefined:
      return "Not in the mesh";
  }
}

const availableMesh = (mesh: RelayMeshResponse | null) => (mesh?.available === true ? mesh : null);

/**
 * The relay owns membership. A machine whose own status says it left drops out at once, because
 * the relay read that removes it can come later.
 */
export function buildMeshOverview(input: MeshOverviewInput): MeshOverview {
  const mesh = availableMesh(input.mesh);
  const connected = new Set(input.connected);
  const left = new Set(
    input.statuses.flatMap(({ environmentId, status }) => (status.enabled ? [] : [environmentId])),
  );
  const members = (mesh?.members ?? []).filter((member) => !left.has(member.environmentId));
  const memberIds = new Set(members.map((member) => member.environmentId));
  const captain = mesh?.captain ?? null;
  const pin = mesh?.pin ?? null;
  return {
    sourceEnvironmentId:
      members.find((member) => member.online && connected.has(member.environmentId))
        ?.environmentId ?? null,
    captain,
    pin,
    members: members.map((member) => ({
      member,
      captain: member.environmentId === captain,
      pinned: member.environmentId === pin,
      note: meshMemberNote(member, pin),
      connected: connected.has(member.environmentId),
    })),
    outside: input.statuses.flatMap(({ environmentId, status }) =>
      (status.selfRole === "off" || !status.enabled) && !memberIds.has(environmentId)
        ? [
            {
              environmentId,
              enabled: status.enabled,
              note: meshUnavailableNote(status.enabled ? status.unavailableReason : "disabled"),
            },
          ]
        : [],
    ),
  };
}

/**
 * Off the allowlist the relay lists no members, so the experimental section stays hidden unless
 * there is a mesh, or a machine left one or cannot join one.
 */
export function isMeshOverviewVisible(
  overview: MeshOverview,
  statuses: ReadonlyArray<MeshEnvironmentStatus>,
): boolean {
  return (
    overview.members.length > 0 ||
    statuses.some(({ status }) => !status.enabled || status.unavailableReason === "shared-key")
  );
}

export function meshMachineMarkers(
  mesh: RelayMeshResponse | null,
): ReadonlyMap<EnvironmentId, MeshMachineMarker> {
  const markers = new Map<EnvironmentId, MeshMachineMarker>();
  const current = availableMesh(mesh);
  for (const member of current?.members ?? []) {
    if (member.environmentId === current?.captain) markers.set(member.environmentId, "captain");
    else if (!member.online) markers.set(member.environmentId, "offline");
  }
  return markers.size === 0 ? EMPTY_MARKERS : markers;
}

/** A machine label with its mesh marker, such as "box · Captain". */
export function meshMachineLabel(label: string, marker: MeshMachineMarker | undefined): string;
export function meshMachineLabel(
  label: string | undefined,
  marker: MeshMachineMarker | undefined,
): string | undefined;
export function meshMachineLabel(
  label: string | undefined,
  marker: MeshMachineMarker | undefined,
): string | undefined {
  if (marker === undefined || label === undefined) return label;
  return `${label} · ${marker === "captain" ? "Captain" : "Offline"}`;
}

/** "via <captain>" while the connection runs on a captain route, else null. */
export function meshCaptainRouteLabel(
  prepared: Pick<PreparedConnection, "captain">,
  mesh: RelayMeshResponse | null,
): string | null {
  if (prepared.captain === undefined) return null;
  const captain = mesh?.members.find((member) => member.environmentId === prepared.captain);
  return `via ${captain?.label ?? "captain"}`;
}

export function createMeshEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | MeshCaptain.MeshCaptain | R, E>,
  options: {
    readonly serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
  },
) {
  const captainStateAtom = runtime.atom(
    Stream.unwrap(
      MeshCaptain.MeshCaptain.pipe(Effect.map((captain) => SubscriptionRef.changes(captain.state))),
    ),
  );

  // Each relay read decodes a new value; equal content keeps the old one, so readers skip it.
  const relayMeshAtom = Atom.make(
    (get) => Option.getOrNull(AsyncResult.value(get(captainStateAtom)))?.mesh ?? null,
  ).pipe(Atom.withEquality(Equal.equals), Atom.withLabel("mesh-relay"));

  const markersAtom = Atom.make((get) => meshMachineMarkers(get(relayMeshAtom))).pipe(
    Atom.withEquality(Equal.equals),
    Atom.withLabel("mesh-machine-markers"),
  );

  const statusQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:mesh:status",
    tag: WS_METHODS.meshStatus,
  });
  const statusAtom = (environmentId: EnvironmentId) => statusQuery({ environmentId, input: {} });

  const memberCapableIdsAtom = Atom.make((get) =>
    [...get(options.serverConfigsAtom)].flatMap(([environmentId, config]) =>
      config.environment.capabilities.meshMember === true ? [environmentId] : [],
    ),
  ).pipe(Atom.withEquality(Equal.equals), Atom.withLabel("mesh-member-capable-environments"));

  const statusesAtom = Atom.make((get) =>
    get(memberCapableIdsAtom).flatMap((environmentId) => {
      const status = selectEnvironmentQueryData(get(statusAtom(environmentId)));
      return status === null ? [] : [{ environmentId, status }];
    }),
  ).pipe(Atom.withEquality(Equal.equals), Atom.withLabel("mesh-statuses"));

  // Mounted with the overview, so opening the Mesh section reads the relay once.
  const relayReadAtom = runtime
    .atom(MeshCaptain.MeshCaptain.pipe(Effect.flatMap((captain) => captain.refresh)))
    .pipe(Atom.withLabel("mesh-relay-read"));

  /** For the Settings Mesh section only: mounting it reads every machine's `mesh.status`. */
  const overviewAtom = Atom.make((get) => {
    get(relayReadAtom);
    const statuses = get(statusesAtom);
    const overview = buildMeshOverview({
      mesh: get(relayMeshAtom),
      connected: get(memberCapableIdsAtom),
      statuses,
    });
    return { overview, visible: isMeshOverviewVisible(overview, statuses) };
  }).pipe(Atom.withLabel("mesh-overview"));

  // A pin or a member leaving changes what the relay and every member report, so reread them.
  const refreshAfterMutation = Effect.fn("MeshStatus.refreshAfterMutation")(function* (
    registry: AtomRegistry.AtomRegistry,
  ) {
    for (const environmentId of registry.get(memberCapableIdsAtom)) {
      registry.refresh(statusAtom(environmentId));
    }
    const captain = yield* MeshCaptain.MeshCaptain;
    yield* captain.refresh.pipe(Effect.forkDetach);
  });

  return {
    relayMeshAtom,
    markersAtom,
    overviewAtom,
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mesh:set-enabled",
      tag: WS_METHODS.meshSetEnabled,
      onSuccess: (_target, registry) => refreshAfterMutation(registry),
    }),
    setPin: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mesh:set-pin",
      tag: WS_METHODS.meshSetPin,
      onSuccess: (_target, registry) => refreshAfterMutation(registry),
    }),
  };
}
