// EXPERIMENTAL mesh v1. Turns a `mesh-member` session on `/mcp` into an invocation scope.
// EnvironmentAuth checks the session and its proof; this adds the caller's mode limit.
import {
  MESH_CALLER_HEADER,
  MESH_MODE_LIMIT_HEADER,
  parseMeshCaller,
  parseMeshModeLimit,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

/** `/mcp` for other members: their tools run here with the caller's modes as the ceiling. */
export const layerMcpMeshAuthenticator = Layer.effect(
  McpInvocationContext.McpMeshAuthenticator,
  Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const environmentId = yield* ServerEnvironment.ServerEnvironment.pipe(
      Effect.flatMap((environment) => environment.getEnvironmentId),
    );
    return McpInvocationContext.McpMeshAuthenticator.of({
      authenticate: Effect.fn("MeshForwardingAuth.authenticateMcp")(function* (request) {
        const member = yield* environmentAuth
          .authenticateMeshMember(request)
          .pipe(
            Effect.catch((error) =>
              (EnvironmentAuth.isServerAuthCredentialError(error)
                ? Effect.void
                : Effect.logWarning("Mesh MCP authentication failed.", { cause: error })
              ).pipe(Effect.as(undefined)),
            ),
          );
        if (member === undefined) return undefined;
        const modeLimit = parseMeshModeLimit(request.headers[MESH_MODE_LIMIT_HEADER.toLowerCase()]);
        if (modeLimit === null) return yield* new McpInvocationContext.McpMeshModeLimitError();
        return {
          environmentId,
          // Not the session id: a renewed session must replay the same launch receipts.
          requestNamespace: `mesh:${member.meshCaller}`,
          thread: undefined,
          client: undefined,
          mesh: {
            sourceEnvironmentId: member.meshCaller,
            sessionId: member.sessionId,
            modeLimit,
            source: parseMeshCaller(request.headers[MESH_CALLER_HEADER.toLowerCase()]) ?? undefined,
          },
          capabilities: new Set<McpInvocationContext.McpCapability>([
            "orchestration",
            "worktree",
            "pull-requests",
          ]),
          issuedAt: yield* Clock.currentTimeMillis,
        } satisfies McpInvocationContext.McpInvocationScope;
      }),
    });
  }),
);
