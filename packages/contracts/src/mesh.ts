// EXPERIMENTAL mesh v1: every machine on one T3 Connect account forms a mesh. The relay picks a
// captain that carries client traffic to the other members; members call each other directly.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  ForwardCompatibleUnion,
  IsoDateTime,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AuthMcpClientAccess } from "./auth.ts";
import { BackgroundBooleanState } from "./background.ts";
import { EnvironmentMachineKind, MeshCapabilities } from "./environment.ts";
import {
  OrchestratorMcpDelegatedTaskStatus,
  OrchestratorMcpDelegatedTaskWorkState,
  OrchestratorMcpPendingApproval,
} from "./orchestratorMcp.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ServerDirectEndpoint } from "./server.ts";

// Members and captain

/** What the relay ranks captain candidates by. Unknown power counts as on mains. */
export const MeshScoreInputs = Schema.Struct({
  backgroundService: Schema.Boolean,
  onBattery: BackgroundBooleanState,
  lowPowerMode: BackgroundBooleanState,
  /** Null when undetected, or a kind this build does not know. */
  machineKind: ForwardCompatibleNullable(EnvironmentMachineKind),
  startedAt: IsoDateTime,
  /** The managed Connect tunnel is up, so clients can reach this member through Connect. */
  tunnelReady: Schema.Boolean,
});
export type MeshScoreInputs = typeof MeshScoreInputs.Type;

/**
 * Why an online member cannot be captain: `needs-update` has no `meshGateway` capability,
 * `not-gateway` reports it as false, `no-tunnel` has no ready managed tunnel.
 */
export const MeshIneligibleReason = Schema.Literals(["needs-update", "no-tunnel", "not-gateway"]);
export type MeshIneligibleReason = typeof MeshIneligibleReason.Type;

export const MeshMemberView = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  machineKind: ForwardCompatibleNullable(EnvironmentMachineKind),
  serverVersion: TrimmedNonEmptyString,
  online: Schema.Boolean,
  capabilities: MeshCapabilities,
  /** Managed tunnel hostname, or null for a member without one. */
  connectHostname: Schema.NullOr(TrimmedNonEmptyString),
  directEndpoints: ForwardCompatibleArray(ServerDirectEndpoint),
  captainEligible: Schema.Boolean,
  /** Absent when eligible, and when offline: `online` already says why. */
  ineligibleReason: ForwardCompatibleOptional(MeshIneligibleReason),
});
export type MeshMemberView = typeof MeshMemberView.Type;

/** Identifies the member a result row came from. */
export const MeshMachineRef = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type MeshMachineRef = typeof MeshMachineRef.Type;

export const MeshSnapshot = Schema.Struct({
  members: Schema.Array(MeshMemberView),
  captain: Schema.NullOr(EnvironmentId),
  pin: Schema.NullOr(EnvironmentId),
  selfEnvironmentId: EnvironmentId,
});
export type MeshSnapshot = typeof MeshSnapshot.Type;

// Member <-> relay socket. JSON text frames; the relay sends a full snapshot on every change.

export const RELAY_MESH_SOCKET_PATH = "/v1/mesh/socket";
export const MESH_PING_INTERVAL_MS = 30_000;
/** Exact frame text: the relay answers it with an auto-response, so the bytes must match. */
export const MESH_PING_MESSAGE = '{"type":"ping"}';
export const MESH_PONG_MESSAGE = '{"type":"pong"}';
/** The relay closes a socket that sent no ping for this long. */
export const MESH_IDLE_TIMEOUT_MS = 90_000;
/** A member whose socket closed stays online this long, so a quick reconnect keeps the captain. */
export const MESH_OFFLINE_GRACE_MS = 30_000;

export const MeshMemberHello = Schema.Struct({
  type: Schema.Literal("hello"),
  label: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  capabilities: MeshCapabilities,
  score: MeshScoreInputs,
  connectHostname: Schema.NullOr(TrimmedNonEmptyString),
  directEndpoints: ForwardCompatibleArray(ServerDirectEndpoint),
});
export type MeshMemberHello = typeof MeshMemberHello.Type;

/** Only the fields that changed since the last hello or update. */
export const MeshMemberUpdate = Schema.Struct({
  type: Schema.Literal("update"),
  label: Schema.optionalKey(MeshMemberHello.fields.label),
  serverVersion: Schema.optionalKey(MeshMemberHello.fields.serverVersion),
  capabilities: Schema.optionalKey(MeshMemberHello.fields.capabilities),
  score: Schema.optionalKey(MeshMemberHello.fields.score),
  connectHostname: Schema.optionalKey(MeshMemberHello.fields.connectHostname),
  directEndpoints: Schema.optionalKey(MeshMemberHello.fields.directEndpoints),
});
export type MeshMemberUpdate = typeof MeshMemberUpdate.Type;

export const MeshMemberSetPin = Schema.Struct({
  type: Schema.Literal("setPin"),
  environmentId: Schema.NullOr(EnvironmentId),
});
export type MeshMemberSetPin = typeof MeshMemberSetPin.Type;

/** Asks for a grant to open a session on `targetEnvironmentId`, bound to the DPoP key `jkt`. */
export const MeshMemberCredentialRequest = Schema.Struct({
  type: Schema.Literal("credentialRequest"),
  requestId: TrimmedNonEmptyString,
  targetEnvironmentId: EnvironmentId,
  jkt: TrimmedNonEmptyString,
});
export type MeshMemberCredentialRequest = typeof MeshMemberCredentialRequest.Type;

export const MeshMemberPing = Schema.Struct({ type: Schema.Literal("ping") });

const meshMemberMessageMembers = [
  MeshMemberHello,
  MeshMemberUpdate,
  MeshMemberSetPin,
  MeshMemberCredentialRequest,
  MeshMemberPing,
] as const;
/** Member to relay. Senders encode with this. */
export const MeshMemberMessage = Schema.Union(meshMemberMessageMembers);
export type MeshMemberMessage = typeof MeshMemberMessage.Type;
/** Member to relay, for the relay: a type it does not know decodes as `UnknownUnionMember`. */
export const ReceivedMeshMemberMessage = ForwardCompatibleUnion(meshMemberMessageMembers, "type");

export const MeshRelaySnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  ...MeshSnapshot.fields,
});
export type MeshRelaySnapshot = typeof MeshRelaySnapshot.Type;

export const MeshRelayCredentialGrant = Schema.Struct({
  type: Schema.Literal("credentialGrant"),
  requestId: TrimmedNonEmptyString,
  /** Compact JWT with `typ` {@link MESH_GRANT_JWT_TYPE} and {@link MeshGrantClaims}. */
  grant: TrimmedNonEmptyString,
});
export type MeshRelayCredentialGrant = typeof MeshRelayCredentialGrant.Type;

export const MeshCredentialErrorCode = Schema.Literals([
  "not-member",
  "target-offline",
  "not-allowlisted",
  "rate-limited",
  "internal",
]);
export type MeshCredentialErrorCode = typeof MeshCredentialErrorCode.Type;

export const MeshRelayCredentialError = Schema.Struct({
  type: Schema.Literal("credentialError"),
  requestId: TrimmedNonEmptyString,
  /** A code this build does not know decodes as `internal`. */
  code: MeshCredentialErrorCode.pipe(Schema.catchDecoding(() => Effect.succeedSome("internal"))),
  message: Schema.String,
});
export type MeshRelayCredentialError = typeof MeshRelayCredentialError.Type;

export const MeshRelayPong = Schema.Struct({ type: Schema.Literal("pong") });

const meshRelayMessageMembers = [
  MeshRelaySnapshot,
  MeshRelayCredentialGrant,
  MeshRelayCredentialError,
  MeshRelayPong,
] as const;
/** Relay to member. Senders encode with this. */
export const MeshRelayMessage = Schema.Union(meshRelayMessageMembers);
export type MeshRelayMessage = typeof MeshRelayMessage.Type;
/** Relay to member, for the member: a type it does not know decodes as `UnknownUnionMember`. */
export const ReceivedMeshRelayMessage = ForwardCompatibleUnion(meshRelayMessageMembers, "type");

/**
 * Relay socket close codes. 40xx are permanent: the member stops reconnecting until its Connect
 * link or mesh setting changes. 41xx are transient. A captain also closes forwarded client
 * sockets with `captainChanged` when it is demoted.
 */
export const MeshCloseCode = {
  /** The member's key is linked to more than one Connect user. */
  sharedKey: 4001,
  notAllowlisted: 4002,
  /**
   * A member leaves by closing its socket with this code, and the relay removes it at once. The
   * relay closes with it when the member's link was revoked.
   */
  left: 4003,
  /** A newer socket for the same member took over. */
  replaced: 4101,
  captainChanged: 4102,
  /** No ping reached the relay for {@link MESH_IDLE_TIMEOUT_MS}. */
  idle: 4103,
} as const;
export type MeshCloseCode = (typeof MeshCloseCode)[keyof typeof MeshCloseCode];

export const isPermanentMeshCloseCode = (code: number): boolean => code >= 4000 && code < 4100;

// Relay HTTP for clients

export const RELAY_MESH_PATH = "/v1/mesh";

/** `GET /v1/mesh` with the client's Connect auth. `available` is false off the allowlist. */
export const RelayMeshResponse = Schema.Struct({
  available: Schema.Boolean,
  members: Schema.Array(MeshMemberView),
  captain: Schema.NullOr(EnvironmentId),
  pin: Schema.NullOr(EnvironmentId),
});
export type RelayMeshResponse = typeof RelayMeshResponse.Type;

// Member credentials

/** `typ` header of a relay-signed mesh grant. Mint credentials use another `typ`. */
export const MESH_GRANT_JWT_TYPE = "t3-mesh-grant+jwt";
export const MESH_GRANT_SCOPE = "mesh:session";
export const MESH_GRANT_TTL_SECONDS = 60;

/** "`meshCaller` may open a session on `aud`", signed by the relay mint key. */
export const MeshGrantClaims = Schema.Struct({
  iss: TrimmedNonEmptyString,
  /** Connect user id. The target accepts only its own installed cloud user. */
  sub: TrimmedNonEmptyString,
  aud: EnvironmentId,
  meshCaller: EnvironmentId,
  scope: Schema.Literal(MESH_GRANT_SCOPE),
  cnf: Schema.Struct({ jkt: TrimmedNonEmptyString }),
  jti: TrimmedNonEmptyString,
  iat: Schema.Int,
  exp: Schema.Int,
});
export type MeshGrantClaims = typeof MeshGrantClaims.Type;

/** Session subject for member-to-member sessions. Accepted only on `/api/mesh/*` and `/mcp`. */
export const MESH_MEMBER_SUBJECT = "mesh-member";

const MESH_HTTP_PREFIX = "/api/mesh";
/** `POST`, with a DPoP proof for the caller's mesh key. */
export const MESH_SESSION_PATH = "/api/mesh/session";
/** `POST`, `mesh-member` session. */
export const MESH_OWNS_PATH = "/api/mesh/owns";
/** `POST`, `mesh-member` session. */
export const MESH_TASK_STATE_PATH = "/api/mesh/task-state";

export const MeshSessionRequest = Schema.Struct({ grant: TrimmedNonEmptyString });
export type MeshSessionRequest = typeof MeshSessionRequest.Type;

export const MeshSessionResponse = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type MeshSessionResponse = typeof MeshSessionResponse.Type;

/** How one member reaches another, in the order tried. */
export const MeshRouteKind = Schema.Literals(["lan", "tailnet", "tunnel"]);
export type MeshRouteKind = typeof MeshRouteKind.Type;

export const MeshRoute = Schema.Struct({
  kind: MeshRouteKind,
  httpBaseUrl: TrimmedNonEmptyString,
});
export type MeshRoute = typeof MeshRoute.Type;

// Member endpoints for agents

export const MeshOwnedKind = Schema.Literals(["thread", "project", "queue", "pending-request"]);
export type MeshOwnedKind = typeof MeshOwnedKind.Type;

/** Ids are opaque: owners are found by asking, never by parsing. */
export const MeshOwnsRequest = Schema.Struct({
  kind: MeshOwnedKind,
  id: TrimmedNonEmptyString,
});
export type MeshOwnsRequest = typeof MeshOwnsRequest.Type;

export const MeshOwnsResponse = Schema.Struct({ owns: Schema.Boolean });
export type MeshOwnsResponse = typeof MeshOwnsResponse.Type;

export const MeshTaskStateRequest = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
});
export type MeshTaskStateRequest = typeof MeshTaskStateRequest.Type;

/** Work on the member that runs a remote task's child, including that child's own children. */
export const MeshTaskStateResponse = Schema.Struct({
  workState: OrchestratorMcpDelegatedTaskWorkState,
  status: OrchestratorMcpDelegatedTaskStatus,
  hasPendingQuestion: Schema.Boolean,
  /** The oldest open question, so the caller can name it and tell a new one apart. */
  pendingQuestionRequestId: Schema.optional(Schema.NullOr(RuntimeRequestId)),
  /** Open questions asked by message: the child keeps working, so they wake but never block. */
  messageQuestionRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  pendingApproval: Schema.NullOr(OrchestratorMcpPendingApproval),
  result: Schema.NullOr(Schema.String),
  /** True once the run and every nested child are done. */
  settled: Schema.Boolean,
});
export type MeshTaskStateResponse = typeof MeshTaskStateResponse.Type;

/**
 * Required on every mesh call to `/mcp`. The callee narrows its modes to this value and never
 * widens them. Node lowercases incoming header names.
 */
export const MESH_MODE_LIMIT_HEADER = "T3-Mesh-Mode-Limit";

export interface MeshModeLimit {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const formatMeshModeLimit = (limit: MeshModeLimit): string =>
  `${limit.runtimeMode}/${limit.interactionMode}`;

const isRuntimeMode = Schema.is(RuntimeMode);
const isProviderInteractionMode = Schema.is(ProviderInteractionMode);

/** Parses `<runtimeMode>/<interactionMode>`. Returns null when missing or malformed. */
export const parseMeshModeLimit = (value: string | null | undefined): MeshModeLimit | null => {
  const parts = value?.trim().split("/");
  if (parts?.length !== 2) return null;
  const [runtimeMode, interactionMode] = parts;
  return isRuntimeMode(runtimeMode) && isProviderInteractionMode(interactionMode)
    ? { runtimeMode, interactionMode }
    : null;
};

/**
 * Optional on mesh calls to `/mcp`: who called the tool on the source member. A thread caller
 * becomes the `meshOrigin` thread of threads the call creates. A client keeps its grant, so a
 * read-only client stays read-only on the callee too.
 */
export const MESH_CALLER_HEADER = "T3-Mesh-Caller";

export type MeshCaller =
  | { readonly kind: "thread"; readonly threadId: ThreadId; readonly delegated?: true }
  | { readonly kind: "client"; readonly access: AuthMcpClientAccess };

/** `thread:<threadId>`, `delegated-thread:<threadId>`, or `client:<access>`. */
export const formatMeshCaller = (caller: MeshCaller): string =>
  caller.kind === "thread"
    ? `${caller.delegated === true ? "delegated-thread" : "thread"}:${encodeURIComponent(caller.threadId)}`
    : `client:${caller.access}`;

const isAuthMcpClientAccess = Schema.is(AuthMcpClientAccess);

/** Returns null when missing or malformed. */
export const parseMeshCaller = (value: string | null | undefined): MeshCaller | null => {
  const separator = value?.indexOf(":") ?? -1;
  if (value === null || value === undefined || separator < 0) return null;
  const kind = value.slice(0, separator);
  const rest = value.slice(separator + 1).trim();
  if (kind === "client") return isAuthMcpClientAccess(rest) ? { kind, access: rest } : null;
  if ((kind !== "thread" && kind !== "delegated-thread") || rest.length === 0) return null;
  try {
    return {
      kind: "thread",
      threadId: ThreadId.make(decodeURIComponent(rest)),
      ...(kind === "delegated-thread" ? { delegated: true } : {}),
    };
  } catch {
    return null;
  }
};

// Captain route

/** `POST` from a `cloud-connect` session mints a handle; forwarding lives below it. */
export const MESH_VIA_PATH = "/api/mesh/via";

export const MeshViaResponse = Schema.Struct({
  /** Stable per Connect user until the captain's key rotates. Grants reachability, not access. */
  handle: TrimmedNonEmptyString,
  /** Members this captain can forward to. */
  routes: Schema.Array(EnvironmentId),
});
export type MeshViaResponse = typeof MeshViaResponse.Type;

/** Not 401, so a client never mistakes it for the member refusing its credential. */
export const MESH_VIA_REFUSED_STATUS = 421;
export const MESH_VIA_NOT_CAPTAIN_STATUS = 410;

export class MeshViaRefusedError extends Schema.TaggedError<MeshViaRefusedError>()(
  "MeshViaRefusedError",
  { reason: Schema.Literals(["bad-handle", "unknown-environment"]) },
  { httpApiStatus: MESH_VIA_REFUSED_STATUS },
) {
  override get message(): string {
    return `The captain refused this route: ${this.reason}.`;
  }
}

export class MeshViaNotCaptainError extends Schema.TaggedError<MeshViaNotCaptainError>()(
  "MeshViaNotCaptainError",
  { captain: Schema.NullOr(EnvironmentId) },
  { httpApiStatus: MESH_VIA_NOT_CAPTAIN_STATUS },
) {
  override get message(): string {
    return "This member is no longer the captain.";
  }
}

/** Only a `cloud-connect` session may mint a handle; other sign-ins keep their direct routes. */
export class MeshViaForbiddenError extends Schema.TaggedError<MeshViaForbiddenError>()(
  "MeshViaForbiddenError",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Only a T3 Connect session can use the captain route.";
  }
}

/** Base path a client puts after the captain's address to reach `environmentId`. */
export const meshViaBasePath = (handle: string, environmentId: EnvironmentId): string =>
  `${MESH_VIA_PATH}/${encodeURIComponent(handle)}/${encodeURIComponent(environmentId)}`;

/** Splits a captain request path. `forwardedPath` keeps its query string. */
export const parseMeshViaPath = (
  path: string,
): {
  readonly handle: string;
  readonly environmentId: EnvironmentId;
  readonly forwardedPath: string;
} | null => {
  const match = /^\/api\/mesh\/via\/([^/?#]+)\/([^/?#]+)(.*)$/.exec(path);
  if (match === null) return null;
  const [, handle, environmentId, rest] = match;
  if (handle === undefined || environmentId === undefined || rest === undefined) return null;
  try {
    return {
      handle: decodeURIComponent(handle),
      environmentId: EnvironmentId.make(decodeURIComponent(environmentId)),
      forwardedPath: rest.startsWith("/") ? rest : `/${rest}`,
    };
  } catch {
    return null;
  }
};

const MESH_FORWARDED_PREFIXES = ["/api/", "/oauth/", "/.well-known/t3/"] as const;

/**
 * Whether the captain may forward `path` (with an optional query) to a member: `/api/*` except
 * `/api/mesh/*`, `/ws`, `/oauth/*`, and `/.well-known/t3/*`. Never the member's web app.
 * Refuses `//`, backslashes, absolute URLs and dot segments, which could escape the member.
 */
export const isMeshForwardedPath = (path: string): boolean => {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) {
    return false;
  }
  const hasDotSegment = pathname.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
  if (hasDotSegment || pathname.startsWith(`${MESH_HTTP_PREFIX}/`)) return false;
  return (
    pathname === "/ws" || MESH_FORWARDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
};

// Server RPCs

export const MeshSelfRole = Schema.Literals(["captain", "member", "off"]);
export type MeshSelfRole = typeof MeshSelfRole.Type;

/** Why this machine is not in the mesh right now. */
export const MeshUnavailableReason = Schema.Literals([
  "disabled",
  "not-linked",
  "shared-key",
  "not-allowlisted",
  "connecting",
]);
export type MeshUnavailableReason = typeof MeshUnavailableReason.Type;

/** A `mesh-member` session this machine holds on another member, and the route it last used. */
export const MeshCachedSession = Schema.Struct({
  environmentId: EnvironmentId,
  route: MeshRoute,
  expiresAt: Schema.DateTimeUtc,
});
export type MeshCachedSession = typeof MeshCachedSession.Type;

export const MeshStatus = Schema.Struct({
  enabled: Schema.Boolean,
  selfRole: MeshSelfRole,
  /** Set while `selfRole` is `off`. */
  unavailableReason: ForwardCompatibleOptional(MeshUnavailableReason),
  captain: Schema.NullOr(EnvironmentId),
  pin: Schema.NullOr(EnvironmentId),
  members: Schema.Array(MeshMemberView),
  /** Cached sessions on other members. Reading status never opens one. */
  sessions: ForwardCompatibleOptional(Schema.Array(MeshCachedSession)),
});
export type MeshStatus = typeof MeshStatus.Type;

export const MeshSetEnabledInput = Schema.Struct({ enabled: Schema.Boolean });
export type MeshSetEnabledInput = typeof MeshSetEnabledInput.Type;

export const MeshSetPinInput = Schema.Struct({ environmentId: Schema.NullOr(EnvironmentId) });
export type MeshSetPinInput = typeof MeshSetPinInput.Type;

export class MeshRpcError extends Schema.TaggedError<MeshRpcError>()("MeshRpcError", {
  reason: Schema.Union([
    MeshUnavailableReason,
    Schema.Literals(["unknown-member", "not-implemented"]),
  ]),
}) {
  override get message(): string {
    return `Mesh request failed: ${this.reason}.`;
  }
}
