import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** The only MCP protocol version a T3 Code `/mcp` registers. */
const PROTOCOL_VERSION = "2025-06-18";

export interface PeerCallLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Calls a linked environment's T3 MCP tools as this environment's outside
 * agent. Each call carries the calling agent's limits in `T3-Mode-Limit`, so
 * the peer enforces the narrower of those and the link's own access.
 */
export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    readonly call: <S extends Schema.Decoder<unknown>>(input: {
      readonly environmentId: EnvironmentId;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: PeerCallLimits;
      readonly success: S;
    }) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

const ToolCallResponse = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      structuredContent: Schema.optional(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const ToolCallResponseJson = Schema.fromJsonString(ToolCallResponse);
const decodeToolCallResponse = Schema.decodeUnknownEffect(ToolCallResponseJson);
const decodeToolCallResponseOption = Schema.decodeUnknownOption(ToolCallResponseJson);
const Failure = Schema.Struct({ code: OrchestratorMcpFailure.fields.code, message: Schema.String });
const decodeFailure = Schema.decodeUnknownOption(Failure);
const decodeTextFailure = Schema.decodeUnknownOption(Schema.fromJsonString(Failure));
const decodeTextResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

const responseJson = (contentType: string | undefined, text: string, requestId: number) => {
  if (contentType?.includes("text/event-stream") !== true) return text;
  for (const event of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    const decoded = decodeToolCallResponseOption(data);
    if (
      decoded._tag === "Some" &&
      decoded.value.id === requestId &&
      (decoded.value.result !== undefined || decoded.value.error !== undefined)
    ) {
      return data;
    }
  }
  return "";
};

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    ),
  );
  // One MCP session per peer and address, reused across calls. The peer keeps
  // sessions in memory, so a restart there answers 404 and we start a new one.
  const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const post = (url: string, token: string, body: unknown, headers: Record<string, string>) =>
    httpClient.execute(
      HttpClientRequest.post(`${url}/mcp`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...headers,
        }),
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
      ),
    );

  const openSession = (url: string, token: string, limitHeader: Record<string, string>) =>
    Effect.gen(function* () {
      const initialized = yield* post(
        url,
        token,
        {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "t3code-peer", version: "1" },
          },
        },
        limitHeader,
      );
      const sessionId = initialized.headers["mcp-session-id"];
      if (initialized.status !== 200 || sessionId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: initialized.status === 401 ? "capability_denied" : "orchestration_error",
          message:
            initialized.status === 401
              ? "The linked environment no longer accepts this link. It may have been revoked there; link it again."
              : `The linked environment refused to start an MCP session (HTTP ${initialized.status}).`,
        });
      }
      yield* post(
        url,
        token,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
      );
      return sessionId;
    });

  const call: PeerMcpClient["Service"]["call"] = (input) =>
    Effect.gen(function* () {
      const resolved = yield* links
        .resolve(input.environmentId)
        .pipe(Effect.mapError(fromLinkError));
      const limitHeader = {
        [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
      };
      const sessionKey = `${input.environmentId} ${resolved.url}`;
      const callOnce = (sessionId: string) =>
        post(
          resolved.url,
          resolved.token,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: input.tool, arguments: input.arguments },
          },
          { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
        );
      const existing = (yield* Ref.get(sessions)).get(sessionKey);
      const sessionId = existing ?? (yield* openSession(resolved.url, resolved.token, limitHeader));
      let response = yield* callOnce(sessionId);
      if (response.status === 404) {
        const renewed = yield* openSession(resolved.url, resolved.token, limitHeader);
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, renewed));
        response = yield* callOnce(renewed);
      } else if (existing === undefined) {
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, sessionId));
      }
      if (response.status === 401) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
        });
      }
      if (response.status !== 200) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `The linked environment answered HTTP ${response.status}.`,
        });
      }
      const body = yield* decodeToolCallResponse(
        responseJson(response.headers["content-type"], yield* response.text, 1),
      ).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment answered in an unexpected shape.",
            }),
        ),
      );
      if (body.error !== undefined || body.result === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: body.error?.message ?? "The linked environment returned no result.",
        });
      }
      const result = body.result;
      const text = result.content.map((part) => part.text ?? "").join("");
      if (result.isError === true) {
        const refused =
          result.structuredContent === undefined
            ? decodeTextFailure(text)
            : decodeFailure(result.structuredContent);
        return yield* refused._tag === "Some"
          ? new OrchestratorMcpFailure({ code: refused.value.code, message: refused.value.message })
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: text || "The linked environment refused the call.",
            });
      }
      const decodeResult = Effect.gen(function* () {
        const value =
          result.structuredContent === undefined
            ? yield* decodeTextResult(text)
            : result.structuredContent;
        // oxlint-disable-next-line t3code/no-inline-schema-compile -- Each caller supplies its own success schema.
        return yield* Schema.decodeUnknownEffect(input.success)(value);
      });
      return yield* decodeResult.pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "The linked environment's answer did not match this version. Update both environments.",
            }),
        ),
      );
    }).pipe(
      Effect.tapError((error) =>
        links.recordOutcome(input.environmentId, { error: error.message }),
      ),
      Effect.tap(() => links.recordOutcome(input.environmentId, { error: null })),
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment stopped answering.",
            }),
          ),
      }),
    );

  return PeerMcpClient.of({ call });
});

export const layer = Layer.effect(PeerMcpClient, make);
