import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";

const PROTOCOL_VERSION = "2025-06-18";

export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    readonly call: <S extends Schema.Decoder<unknown>>(input: {
      readonly environmentId: EnvironmentId;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      };
      readonly success: S;
    }) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

const RpcResponse = Schema.Union([
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Number,
    result: Schema.Unknown,
    error: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Number,
    result: Schema.optional(Schema.Never),
    error: Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(Schema.Unknown),
    }),
  }),
]);
const decodeRpcResponse = Schema.decodeUnknownOption(Schema.fromJsonString(RpcResponse));
const decodeInitializeResult = Schema.decodeUnknownEffect(McpSchema.InitializeResult);
const decodeToolResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const Refusal = Schema.Struct({
  code: OrchestratorMcpFailure.fields.code,
  message: Schema.String,
});
const decodeRefusal = Schema.decodeUnknownOption(Refusal);
const decodeTextRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Refusal));
const protocolFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The linked environment answered in an unexpected shape. Update both environments.",
  });
const revoked = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
  });
const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired" || error.reason === "incompatible"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transform((request) =>
      request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })),
    ),
  );
  const crypto = yield* Crypto.Crypto;
  const nextRequestId = yield* Ref.make(1);
  const sessions = yield* Ref.make<
    ReadonlyMap<
      string,
      {
        readonly credential: string;
        readonly sessionId: string;
      }
    >
  >(new Map());

  // Consume every body, including errors and the initialized notification.
  const post = Effect.fnUntraced(function* (
    url: string,
    token: string,
    body: unknown,
    headers: Record<string, string>,
  ) {
    const response = yield* http.execute(
      HttpClientRequest.post(`${url}/mcp`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...headers,
        }),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    const text = yield* response.text;
    return { status: response.status, headers: response.headers, text };
  });

  const rpcResult = Effect.fnUntraced(function* (
    response: { readonly headers: Record<string, string>; readonly text: string },
    id: number,
  ) {
    // Each SSE event has its own JSON-RPC message. Notifications may precede
    // the response; data lines within an event are joined with newlines.
    const messages = response.headers["content-type"]?.includes("text/event-stream")
      ? response.text
          .replaceAll("\r\n", "\n")
          .split("\n\n")
          .flatMap((event) => {
            const data = event
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            return data.length === 0 ? [] : [data];
          })
      : [response.text];
    for (const text of messages) {
      const decoded = decodeRpcResponse(text);
      if (Option.isNone(decoded) || decoded.value.id !== id) continue;
      if (decoded.value.error !== undefined) {
        const refusal = decodeRefusal(decoded.value.error.data);
        if (Option.isSome(refusal))
          return yield* new OrchestratorMcpFailure({
            code: refusal.value.code,
            message: refusal.value.message.slice(0, 1000),
          });
        return yield* new OrchestratorMcpFailure({
          code: decoded.value.error.code === -32602 ? "invalid_request" : "orchestration_error",
          message: "The linked environment refused the MCP request.",
        });
      }
      return decoded.value.result;
    }
    return yield* protocolFailure();
  });

  const assertOk = (status: number) =>
    status === 200
      ? Effect.void
      : Effect.fail(
          status === 401 || status === 403
            ? revoked()
            : new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `The linked environment answered HTTP ${status}.`,
              }),
        );

  const openSession = Effect.fnUntraced(function* (
    url: string,
    token: string,
    headers: Record<string, string>,
  ) {
    const response = yield* post(
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
      headers,
    );
    yield* assertOk(response.status);
    const initialized = yield* rpcResult(response, 0);
    const result = yield* decodeInitializeResult(initialized).pipe(
      Effect.mapError(protocolFailure),
    );
    const sessionId = response.headers["mcp-session-id"];
    if (sessionId === undefined || result.protocolVersion !== PROTOCOL_VERSION)
      return yield* protocolFailure();
    const notified = yield* post(
      url,
      token,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
    );
    if (notified.status !== 202 && notified.status !== 200) yield* assertOk(notified.status);
    return sessionId;
  });

  const call: PeerMcpClient["Service"]["call"] = (input) =>
    Effect.gen(function* () {
      // Even a cached MCP session must revalidate the peer before bearer use.
      const resolved = yield* links
        .resolve(input.environmentId)
        .pipe(Effect.mapError(fromLinkError));
      const headers = {
        [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
      };
      const key = `${encodeURIComponent(input.environmentId)}:${encodeURIComponent(resolved.url)}`;
      const credential = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(resolved.token))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      const cached = (yield* Ref.get(sessions)).get(key);
      const sessionId =
        cached?.credential === credential
          ? cached.sessionId
          : yield* openSession(resolved.url, resolved.token, headers);
      const saveSession = (sessionId: string) =>
        Ref.update(sessions, (current) => new Map(current).set(key, { credential, sessionId }));
      yield* saveSession(sessionId);
      const request = {
        jsonrpc: "2.0",
        id: yield* Ref.getAndUpdate(nextRequestId, (id) => id + 1),
        method: "tools/call",
        params: { name: input.tool, arguments: input.arguments },
      };
      const callOnce = (sessionId: string) =>
        post(resolved.url, resolved.token, request, {
          ...headers,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": PROTOCOL_VERSION,
        });
      let response = yield* callOnce(sessionId);
      // A missing in-memory MCP session is the only safe transport replay.
      if (response.status === 404) {
        const renewed = yield* openSession(resolved.url, resolved.token, headers);
        yield* saveSession(renewed);
        response = yield* callOnce(renewed);
      }
      yield* assertOk(response.status);
      const result = yield* rpcResult(response, request.id).pipe(
        Effect.flatMap(decodeToolResult),
        Effect.mapError((error) => (isMcpFailure(error) ? error : protocolFailure())),
      );
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      if (result.isError === true) {
        const refusal =
          result.structuredContent === undefined
            ? decodeTextRefusal(text)
            : decodeRefusal(result.structuredContent);
        return yield* Option.isSome(refusal)
          ? new OrchestratorMcpFailure({
              code: refusal.value.code,
              message: refusal.value.message.slice(0, 1000),
            })
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment refused the call.",
            });
      }
      return yield* (
        result.structuredContent === undefined
          ? // oxlint-disable-next-line t3code/no-inline-schema-compile -- The destination tool supplies its result schema per call.
            Schema.decodeUnknownEffect(Schema.fromJsonString(input.success))(text)
          : // oxlint-disable-next-line t3code/no-inline-schema-compile -- The destination tool supplies its result schema per call.
            Schema.decodeUnknownEffect(input.success)(result.structuredContent)
      ).pipe(Effect.mapError(protocolFailure));
    }).pipe(
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment stopped answering.",
            }),
          ),
      }),
      // Diagnostics must not turn a durable success into a failed mutation.
      Effect.tapError((error) =>
        links
          .recordOutcome(input.environmentId, {
            error: `Peer call failed (${error.code}).`,
          })
          .pipe(Effect.ignoreCause),
      ),
      Effect.tap(() =>
        links.recordOutcome(input.environmentId, { error: null }).pipe(Effect.ignoreCause),
      ),
    );

  return PeerMcpClient.of({ call });
});

export const layer = Layer.effect(PeerMcpClient, make);
