import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  type MeshCaller,
  type MeshModeLimit,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** A delegated child task; its parent owns the work it hands back. */
  readonly subagent?: boolean;
}

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
}

/** EXPERIMENTAL mesh v1. Another member calling this machine's tools over a `mesh-member` session. */
export interface McpMeshCaller {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sessionId: string;
  /** From `T3-Mesh-Mode-Limit`: the source caller's modes. Calls here never run above them. */
  readonly modeLimit: MeshModeLimit;
  /** From `T3-Mesh-Caller`, when the source sent it. */
  readonly source: MeshCaller | undefined;
}

/** Read-only clients map to the lowest mode because McpToolAccess blocks writes first. */
const clientRuntimeModeCeiling = (client: McpClientCaller | undefined): RuntimeMode =>
  client === undefined || client.access === "read-only" ? "approval-required" : client.access;

/** Thread callers default to their own thread; client callers need thread for tools that act as the caller. */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
  /** Set on calls from another mesh member. They run here only and never forward again. */
  readonly mesh?: McpMeshCaller;
}

/** Modes of a caller that is not a thread here: a client's ceiling, or a member's mode limit. */
export const nonThreadCallerLimits = (scope: McpInvocationScope): MeshModeLimit =>
  scope.mesh?.modeLimit ?? {
    runtimeMode: clientRuntimeModeCeiling(scope.client),
    interactionMode: "default",
  };

/** An outside agent approved for read-only access, here or on the member that forwarded the call. */
export const isReadOnlyCaller = (scope: McpInvocationScope): boolean =>
  scope.client?.access === "read-only" ||
  (scope.mesh?.source?.kind === "client" && scope.mesh.source.access === "read-only");

/** EXPERIMENTAL mesh v1. A mesh call without a usable `T3-Mesh-Mode-Limit`; it never runs. */
export class McpMeshModeLimitError extends Schema.TaggedError<McpMeshModeLimitError>()(
  "McpMeshModeLimitError",
  {},
) {
  override get message(): string {
    return "Mesh calls must send T3-Mesh-Mode-Limit as <runtimeMode>/<interactionMode>.";
  }
}

/** EXPERIMENTAL mesh v1. Admits `Authorization: DPoP` from `mesh-member` sessions. */
export class McpMeshAuthenticator extends Context.Service<
  McpMeshAuthenticator,
  {
    /** Undefined when the credential or its proof is not a valid `mesh-member` one. */
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationScope | undefined, McpMeshModeLimitError>;
  }
>()("t3/mcp/McpInvocationContext/McpMeshAuthenticator") {}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/**
 * `McpSchema.EnabledWhen` for tools a delegated child must not see or call.
 * EnabledWhen only receives the MCP client profile, so read the T3 caller from the request fiber.
 */
export const hiddenFromSubagents = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.thread?.subagent !== true;
};

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
