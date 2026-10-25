// EXPERIMENTAL mesh v1 service seams. Live layers live beside this module, one per service.
import {
  EnvironmentId,
  MeshCredentialErrorCode,
  MeshUnavailableReason,
  ServerSettingsError,
  type MeshCachedSession,
  type MeshCaller,
  type MeshModeLimit,
  type MeshRoute,
  type MeshSelfRole,
  type MeshSnapshot,
  type MeshStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class MeshUnavailableError extends Schema.TaggedError<MeshUnavailableError>()(
  "MeshUnavailableError",
  { reason: MeshUnavailableReason },
) {
  override get message(): string {
    return `This machine is not in the mesh: ${this.reason}.`;
  }
}

export class MeshGrantRefusedError extends Schema.TaggedError<MeshGrantRefusedError>()(
  "MeshGrantRefusedError",
  { targetEnvironmentId: EnvironmentId, code: MeshCredentialErrorCode },
) {
  override get message(): string {
    return `The relay refused a mesh grant for ${this.targetEnvironmentId}: ${this.code}.`;
  }
}

/** The id names no member, or a member without the capability the call needs. */
export class MeshNotMemberError extends Schema.TaggedError<MeshNotMemberError>()(
  "MeshNotMemberError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return `${this.environmentId} is not a reachable mesh member.`;
  }
}

export class MeshMemberOfflineError extends Schema.TaggedError<MeshMemberOfflineError>()(
  "MeshMemberOfflineError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return `Mesh member ${this.environmentId} is offline.`;
  }
}

/** No LAN, tailnet or tunnel route answered as this environment. */
export class MeshMemberUnreachableError extends Schema.TaggedError<MeshMemberUnreachableError>()(
  "MeshMemberUnreachableError",
  { environmentId: EnvironmentId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `No route reached mesh member ${this.environmentId}.`;
  }
}

/** The target refused to redeem a grant, or refused the session on a call. */
export class MeshSessionRefusedError extends Schema.TaggedError<MeshSessionRefusedError>()(
  "MeshSessionRefusedError",
  { environmentId: EnvironmentId, status: Schema.Int },
) {
  override get message(): string {
    return `Mesh member ${this.environmentId} refused the session (HTTP ${this.status}).`;
  }
}

export type MeshCredentialsError =
  | MeshUnavailableError
  | MeshGrantRefusedError
  | MeshNotMemberError
  | MeshMemberOfflineError
  | MeshMemberUnreachableError
  | MeshSessionRefusedError;

/** The remote tool answered with a failure. `code` is the remote's own code, kept for the agent. */
export class MeshRemoteToolError extends Schema.TaggedError<MeshRemoteToolError>()(
  "MeshRemoteToolError",
  {
    environmentId: EnvironmentId,
    toolName: Schema.String,
    code: Schema.String,
    message: Schema.String,
  },
) {}

/** This machine's relay socket: membership, presence, captain, and grants. */
export class MeshMembership extends Context.Service<
  MeshMembership,
  {
    /** Latest relay snapshot; none while off or before the first one arrives. */
    readonly snapshot: Effect.Effect<Option.Option<MeshSnapshot>>;
    /** The current snapshot, if any, then each new one. */
    readonly snapshots: Stream.Stream<MeshSnapshot>;
    readonly status: Effect.Effect<MeshStatus>;
    readonly selfRole: Effect.Effect<MeshSelfRole>;
    readonly isEnabled: Effect.Effect<boolean>;
    /** Persists `mesh.enabled`. Leaving closes the socket and revokes `mesh-member` sessions. */
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void, ServerSettingsError>;
    readonly setPin: (
      environmentId: EnvironmentId | null,
    ) => Effect.Effect<void, MeshUnavailableError>;
    /** Asks the relay for a grant to open a session on the target. Returns the grant JWT. */
    readonly requestGrant: (input: {
      readonly targetEnvironmentId: EnvironmentId;
      readonly jkt: string;
    }) => Effect.Effect<string, MeshUnavailableError | MeshGrantRefusedError>;
  }
>()("t3/mesh/Services/MeshMembership") {}

/** A cached `mesh-member` session on another member. */
export interface MeshSession {
  readonly environmentId: EnvironmentId;
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  /** The route the session was redeemed on. Send requests to `route.httpBaseUrl`. */
  readonly route: MeshRoute;
  /** The member's Connect URL, or null without a managed tunnel. */
  readonly connectUrl: string | null;
  /** `Authorization` and a fresh `DPoP` proof for one request to `url`. */
  readonly authorizationHeaders: (request: {
    readonly method: string;
    readonly url: string;
  }) => Effect.Effect<Readonly<Record<string, string>>>;
}

/** Sessions on other members, and the route to each. */
export class MeshCredentials extends Context.Service<
  MeshCredentials,
  {
    /** Opens or reuses a session, renewing it past half its lifetime. */
    readonly session: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<MeshSession, MeshCredentialsError>;
    /**
     * The best route that answered as this environment: LAN, then tailnet, then tunnel. The same
     * value until the routes are walked again, so a caller can tell a new walk from a cache hit.
     */
    readonly route: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      MeshRoute,
      | MeshUnavailableError
      | MeshNotMemberError
      | MeshMemberOfflineError
      | MeshMemberUnreachableError
    >;
    /** The current cached route, without probing or walking routes. */
    readonly cachedRoute: (environmentId: EnvironmentId) => Effect.Effect<Option.Option<MeshRoute>>;
    /** Drops the cached session and route, so the next call redeems a new session. */
    readonly invalidate: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /**
     * Drops only the cached route, after a transport failure, so the next call walks the routes
     * again. The session still works on any route.
     */
    readonly forgetRoute: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** Sessions already open and the route each last used. Never opens one. */
    readonly cachedSessions: Effect.Effect<ReadonlyArray<MeshCachedSession>>;
  }
>()("t3/mesh/Services/MeshCredentials") {}

export interface MeshToolCallOptions {
  /** Sent as `T3-Mesh-Mode-Limit`; the callee only narrows to it. */
  readonly modeLimit: MeshModeLimit;
  /**
   * Stable across retries and session renewals, so a retried launch replays its receipt. Sent as
   * the tool's `clientRequestId` argument.
   */
  readonly requestKey?: string;
  /** Sent as `T3-Mesh-Caller`. A thread caller becomes the `meshOrigin` thread of a launch. */
  readonly caller?: MeshCaller;
}

/** Calls T3 MCP tools on another member over a `mesh-member` session. */
export class MeshMcpClient extends Context.Service<
  MeshMcpClient,
  {
    /** Returns the tool's structured result, undecoded; callers decode with the tool's schema. */
    readonly callTool: (
      environmentId: EnvironmentId,
      toolName: string,
      args: Readonly<Record<string, unknown>>,
      options: MeshToolCallOptions,
    ) => Effect.Effect<unknown, MeshRemoteToolError | MeshCredentialsError>;
  }
>()("t3/mesh/Services/MeshMcpClient") {}
