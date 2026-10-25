// EXPERIMENTAL mesh v1. Calls T3 MCP tools on another member over a `mesh-member` session.
import {
  formatMeshCaller,
  formatMeshModeLimit,
  MESH_CALLER_HEADER,
  MESH_MODE_LIMIT_HEADER,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { environmentEndpointUrl } from "@t3tools/shared/advertisedEndpoint";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import * as MeshServices from "./Services.ts";

const CallToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});
const decodeCallToolResult = Schema.decodeUnknownOption(CallToolResult);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
// Tools with `failureMode: "return"` send their encoded failure as JSON text.
const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestratorMcpFailure));

// Forwarded waits run in 50 s pieces, and a clone answers only when cloning ends (its own
// budget is 120 s). Other requests must release recovery sooner.
const meshToolDeadline = (toolName: string) =>
  toolName === "t3_project_clone"
    ? "130 seconds"
    : toolName === "t3_thread_wait"
      ? "60 seconds"
      : "15 seconds";

const make = Effect.gen(function* () {
  const credentials = yield* MeshServices.MeshCredentials;

  const callOnce = Effect.fn("MeshMcpClient.callOnce")(function* (
    environmentId: Parameters<MeshServices.MeshMcpClient["Service"]["callTool"]>[0],
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    options: MeshServices.MeshToolCallOptions,
  ) {
    const session = yield* credentials.session(environmentId);
    const meshHeaders = {
      [MESH_MODE_LIMIT_HEADER]: formatMeshModeLimit(options.modeLimit),
      ...(options.caller === undefined
        ? {}
        : { [MESH_CALLER_HEADER]: formatMeshCaller(options.caller) }),
    };
    return yield* mcpToolSession({
      endpoint: environmentEndpointUrl(session.route.httpBaseUrl, "/mcp"),
      clientName: "t3-code-mesh",
      requestTimeout: meshToolDeadline(toolName),
      requestHeaders: (request) =>
        session
          .authorizationHeaders(request)
          .pipe(Effect.map((headers) => ({ ...headers, ...meshHeaders }))),
    }).pipe(
      Effect.flatMap((mcp) =>
        mcp.call(
          toolName,
          options.requestKey === undefined
            ? args
            : { ...args, clientRequestId: options.requestKey },
        ),
      ),
      Effect.scoped,
      Effect.mapError((error) =>
        error.status === 401 || error.status === 403
          ? new MeshServices.MeshSessionRefusedError({ environmentId, status: error.status })
          : new MeshServices.MeshMemberUnreachableError({ environmentId, cause: error }),
      ),
      // The route stopped answering, though the member may still advertise it: the next call
      // walks LAN, tailnet and tunnel again. No retry here, since the tool may have run.
      Effect.tapErrorTag("MeshMemberUnreachableError", () =>
        credentials.forgetRoute(environmentId),
      ),
    );
  });

  const callTool: MeshServices.MeshMcpClient["Service"]["callTool"] = Effect.fn(
    "MeshMcpClient.callTool",
  )(function* (environmentId, toolName, args, options) {
    const raw = yield* callOnce(environmentId, toolName, args, options).pipe(
      Effect.catchTags({
        // A revoked or expired session: redeem a new one once.
        MeshSessionRefusedError: (error) =>
          error.status === 401
            ? credentials
                .invalidate(environmentId)
                .pipe(Effect.andThen(callOnce(environmentId, toolName, args, options)))
            : Effect.fail(error),
      }),
    );
    const result = decodeCallToolResult(raw);
    if (Option.isNone(result)) {
      return yield* new MeshServices.MeshRemoteToolError({
        environmentId,
        toolName,
        code: "orchestration_error",
        message: "The machine sent a tool result this build cannot read.",
      });
    }
    const text = result.value.content?.find((part) => part.type === "text")?.text;
    if (result.value.isError === true) {
      const failure = text === undefined ? Option.none() : decodeFailureText(text);
      return yield* new MeshServices.MeshRemoteToolError({
        environmentId,
        toolName,
        code: Option.isSome(failure) ? failure.value.code : "orchestration_error",
        message: Option.isSome(failure) ? failure.value.message : (text ?? "The tool failed."),
      });
    }
    if (result.value.structuredContent !== undefined) return result.value.structuredContent;
    return text === undefined ? undefined : Option.getOrUndefined(decodeJson(text));
  });

  return MeshServices.MeshMcpClient.of({ callTool });
});

export const layer = Layer.effect(MeshServices.MeshMcpClient, make);
