// EXPERIMENTAL mesh v1: the captain route on the wire. Forwards one client request or WebSocket to
// one member unchanged. Node `http` and the `ws` package are used directly because the member
// checks DPoP proofs against `Host`, which `fetch` and Effect's socket constructor do not send.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { EnvironmentId, MeshCloseCode } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { WebSocket } from "ws";

/** No answer from the member on the route the captain used. */
export class MeshViaUpstreamError extends Schema.TaggedError<MeshViaUpstreamError>()(
  "MeshViaUpstreamError",
  { environmentId: EnvironmentId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The captain could not reach mesh member ${this.environmentId}.`;
  }
}

export interface MeshViaTarget {
  readonly environmentId: EnvironmentId;
  /** The captain's route to the member, from `MeshCredentials.route`. */
  readonly baseUrl: string;
  /** The member's Connect hostname, sent as `Host`. */
  readonly host: string;
  /** The client's path below the via base, with its query string. */
  readonly path: string;
}

/** Registers a way to close one forwarded connection; returns the unregister function. */
export type TrackConnection = (close: () => void) => () => void;

// RFC 9110 hop-by-hop fields, and `expect`, which each hop answers itself.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

/** For a connect and a WebSocket handshake. A LAN address the member left never answers. */
const CONNECT_TIMEOUT = Duration.seconds(10);
/** Above this many queued bytes, a pump waits for the receiving side to drain. */
const SOCKET_HIGH_WATER_MARK = 1024 * 1024;
const ABNORMAL_CLOSURE = 1006;
const NO_STATUS_RECEIVED = 1005;
const GOING_AWAY = 1001;

const connectionTokens = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );

const headerValue = (value: string | ReadonlyArray<string>) =>
  typeof value === "string" ? value : value.join(", ");

/**
 * The client's headers for the member. Drops cookies (the member reads a cookie before DPoP),
 * client `X-Forwarded-*`, hop-by-hop and WebSocket handshake fields, and adds no credentials.
 */
const memberRequestHeaders = (
  headers: NodeHttp.IncomingHttpHeaders,
  memberHost: string,
): Record<string, string> => {
  const dropped = connectionTokens(headers.connection);
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name) ||
      dropped.has(name) ||
      name === "host" ||
      name === "cookie" ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("sec-websocket-")
    ) {
      continue;
    }
    forwarded[name] = headerValue(value);
  }
  // The member builds the request URL its DPoP check uses from these two, so a proof signed for
  // its Connect URL holds on every route the captain takes.
  forwarded.host = memberHost;
  forwarded["x-forwarded-proto"] = "https";
  return forwarded;
};

const clientResponseHeaders = (response: NodeHttp.IncomingMessage): Record<string, string> => {
  const dropped = connectionTokens(response.headers.connection);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    // A member cookie would land on the captain's origin.
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || dropped.has(name)) continue;
    if (name === "set-cookie") continue;
    headers[name] = headerValue(value);
  }
  const status = response.statusCode ?? 200;
  // `identity` opts out of the captain's compression middleware, which would hold back stream
  // chunks; the middleware removes it again. It skips these statuses on its own.
  if (
    headers["content-encoding"] === undefined &&
    status >= 200 &&
    status !== 204 &&
    status !== 206 &&
    status !== 304
  ) {
    headers["content-encoding"] = "identity";
  }
  return headers;
};

const toClientResponse = (response: NodeHttp.IncomingMessage) =>
  HttpServerResponse.raw(response, {
    status: response.statusCode ?? 502,
    statusText: response.statusMessage,
    headers: clientResponseHeaders(response),
  });

// Joined as strings so a route base path survives and the client's path is sent as received.
const targetUrl = (target: MeshViaTarget) => {
  const base = new URL(target.baseUrl);
  return { base, path: `${base.pathname.replace(/\/+$/, "")}${target.path}` };
};

/** A keep-alive agent for one member route. */
export const makeMemberAgent = (baseUrl: string): NodeHttp.Agent =>
  new URL(baseUrl).protocol === "https:"
    ? new NodeHttps.Agent({ keepAlive: true })
    : new NodeHttp.Agent({ keepAlive: true });

/**
 * Closes an agent's idle pooled sockets, which may be half-open after a network change. Requests
 * still waiting for a response keep their sockets and finish; the member closes those sockets
 * once they go idle, because nothing reuses this agent.
 */
export const retireMemberAgent = (agent: NodeHttp.Agent): void => {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of sockets ?? []) socket.destroy();
  }
};

// Request middleware owns tracing for forwarded requests, including long-lived streams.
export const forwardHttp = Effect.fnUntraced(function* (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly target: MeshViaTarget;
  readonly agent: NodeHttp.Agent;
  readonly track: TrackConnection;
}) {
  const incoming = NodeHttpServerRequest.toIncomingMessage(input.request);
  const { base, path } = targetUrl(input.target);
  const upstreamError = (cause: unknown) =>
    new MeshViaUpstreamError({ environmentId: input.target.environmentId, cause });
  const connected = Deferred.makeUnsafe<void>();
  const response = Effect.callback<NodeHttp.IncomingMessage, MeshViaUpstreamError>((resume) => {
    const upstream = (base.protocol === "https:" ? NodeHttps : NodeHttp).request({
      protocol: base.protocol,
      hostname: base.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: base.port,
      path,
      method: incoming.method,
      headers: memberRequestHeaders(incoming.headers, input.target.host),
      agent: input.agent,
    });
    upstream.once(
      "close",
      input.track(() => upstream.destroy()),
    );
    upstream.once("socket", (socket) => {
      const done = () => Deferred.doneUnsafe(connected, Effect.void);
      // A keep-alive socket is already connected.
      if (upstream.reusedSocket) done();
      else socket.once(base.protocol === "https:" ? "secureConnect" : "connect", done);
    });
    let settled = false;
    upstream.once("response", (response) => {
      settled = true;
      resume(Effect.succeed(response));
    });
    // Errors after the response surface through the response body instead.
    upstream.on("error", (cause) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(upstreamError(cause)));
    });
    NodeStream.pipeline(incoming, upstream, (error) => {
      if (error) upstream.destroy(error);
    });
    return Effect.sync(() => upstream.destroy());
  });
  // Only the connect has a deadline: a member may take long to answer a large upload.
  const connectDeadline = Deferred.await(connected).pipe(
    Effect.timeoutOrElse({
      duration: CONNECT_TIMEOUT,
      orElse: () => Effect.fail(upstreamError("connect timed out")),
    }),
    Effect.andThen(Effect.never),
  );
  return toClientResponse(yield* Effect.raceFirst(response, connectDeadline));
});

type OpenedMemberSocket =
  | { readonly _tag: "open"; readonly socket: WebSocket }
  | { readonly _tag: "refused"; readonly response: NodeHttp.IncomingMessage };

const openMemberSocket = (target: MeshViaTarget, incoming: NodeHttp.IncomingMessage) =>
  Effect.callback<OpenedMemberSocket, MeshViaUpstreamError>((resume) => {
    const protocols = (incoming.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol.length > 0);
    const { base, path } = targetUrl(target);
    const url = `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}${path}`;
    const socket = new WebSocket(url, protocols, {
      headers: memberRequestHeaders(incoming.headers, target.host),
      followRedirects: false,
      handshakeTimeout: Duration.toMillis(CONNECT_TIMEOUT),
    });
    let settled = false;
    socket.once("open", () => {
      settled = true;
      // Hold member frames in the TCP buffer until the client socket is ready to take them.
      socket.pause();
      resume(Effect.succeed({ _tag: "open", socket }));
    });
    // The member refused the upgrade, for example a stale ticket: the client gets that answer.
    socket.once("unexpected-response", (_request, response) => {
      settled = true;
      resume(Effect.succeed({ _tag: "refused", response }));
    });
    socket.on("error", (cause) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(new MeshViaUpstreamError({ environmentId: target.environmentId, cause })));
    });
    return Effect.sync(() => {
      if (!settled) socket.terminate();
    });
  });

interface SocketClosed {
  readonly side: "client" | "member" | "captain";
  readonly code: number;
  readonly reason?: string | undefined;
}

const closedBy =
  (side: SocketClosed["side"]) =>
  (error: Socket.SocketError): SocketClosed =>
    error.reason._tag === "SocketCloseError"
      ? { side, code: error.reason.code, reason: error.reason.closeReason }
      : { side, code: ABNORMAL_CLOSURE };

// Codes a close frame may carry. 1005, 1006 and 1015 only describe how a socket ended.
const isSendableCloseCode = (code: number) =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1014) ||
  (code >= 3000 && code <= 4999);

const awaitDrain = (stream: NodeStream.Writable) =>
  Effect.callback<void>((resume) => {
    if (stream.writableLength <= SOCKET_HIGH_WATER_MARK || stream.destroyed) {
      return resume(Effect.void);
    }
    const done = () => resume(Effect.void);
    stream.once("drain", done);
    stream.once("close", done);
    return Effect.sync(() => {
      stream.off("drain", done);
      stream.off("close", done);
    });
  });

// Resumes once the last frame is written, so a slow member pauses the client's reader.
const sendToMember = (socket: WebSocket, frames: ReadonlyArray<Uint8Array | string>) =>
  Effect.callback<void>((resume) => {
    frames.forEach((frame, index) =>
      socket.send(frame, index === frames.length - 1 ? () => resume(Effect.void) : undefined),
    );
  });

// Request middleware owns tracing for forwarded requests, including long-lived sockets.
export const forwardWebSocket = Effect.fnUntraced(function* (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly target: MeshViaTarget;
  readonly track: TrackConnection;
}) {
  const incoming = NodeHttpServerRequest.toIncomingMessage(input.request);
  const opened = yield* openMemberSocket(input.target, incoming);
  if (opened._tag === "refused") return toClientResponse(opened.response);
  const member = opened.socket;
  // The client accepts the subprotocol the member chose, not the captain's default pick.
  if (member.protocol.length > 0) incoming.headers["sec-websocket-protocol"] = member.protocol;
  else delete incoming.headers["sec-websocket-protocol"];
  const transport = incoming.socket;
  const demoted = Deferred.makeUnsafe<void>();
  const untrack = input.track(() => Deferred.doneUnsafe(demoted, Effect.void));

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* input.request.upgrade;
      const clientReader = yield* client.reader;
      const clientWriter = yield* client.writer;
      const memberReader = yield* (yield* Socket.fromWebSocket(Effect.succeed(member))).reader;

      // Frame pumps run per message; the request span already covers the connection.
      const memberToClient = Effect.forever(
        memberReader.pull.pipe(
          Effect.mapError(closedBy("member")),
          Effect.flatMap((frames) =>
            clientWriter
              .writeAll(frames)
              .pipe(
                Effect.mapError((): SocketClosed => ({ side: "client", code: ABNORMAL_CLOSURE })),
              ),
          ),
          Effect.andThen(awaitDrain(transport)),
        ),
      );
      const clientToMember = Effect.forever(
        clientReader.pull.pipe(
          Effect.mapError(closedBy("client")),
          Effect.flatMap((frames) => sendToMember(member, frames)),
        ),
      );
      const closed = yield* Effect.raceAll([
        Effect.flip(memberToClient),
        Effect.flip(clientToMember),
        Deferred.await(demoted).pipe(
          Effect.map((): SocketClosed => ({
            side: "captain",
            code: MeshCloseCode.captainChanged,
            reason: "captain changed",
          })),
        ),
      ]);

      if (closed.side !== "client") {
        // Effect's writer always sends a code, so a bare close reaches the client as 1000.
        yield* isSendableCloseCode(closed.code) || closed.code === NO_STATUS_RECEIVED
          ? clientWriter
              .write(
                isSendableCloseCode(closed.code)
                  ? new Socket.CloseEvent(closed.code, closed.reason)
                  : new Socket.CloseEvent(),
              )
              .pipe(Effect.ignore)
          : Effect.sync(() => transport.destroy());
      }
      if (closed.side !== "member") {
        const code = closed.side === "captain" ? GOING_AWAY : closed.code;
        if (isSendableCloseCode(code)) member.close(code, closed.reason);
        else if (code === NO_STATUS_RECEIVED) member.close();
        else member.terminate();
      }
      return HttpServerResponse.empty();
    }),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        untrack();
        // Interrupted or failed before the bridge closed it, as on shutdown.
        if (member.readyState === WebSocket.OPEN) member.close(GOING_AWAY);
      }),
    ),
    // The client or member went away during the handshake; nothing is left to answer.
    Effect.catchTags({
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty()),
      SocketError: () => Effect.succeed(HttpServerResponse.empty()),
    }),
  );
});
