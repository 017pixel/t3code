import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  type AuthMcpClientAccess,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as McpSchema from "effect/ai/McpSchema";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const decodeMcpRequest = Schema.decodeUnknownEffect(
  Schema.Struct({ method: Schema.String, id: Schema.optional(Schema.Number) }),
);

class PeerTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

export const descriptorOf = (
  environmentId: string,
  label: string,
  capabilities: Partial<ExecutionEnvironmentDescriptor["capabilities"]> = {},
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true, mcpModeLimitHeader: true, ...capabilities },
});

/**
 * The environment a link points at, as it runs: its descriptor, MCP OAuth,
 * and `/mcp` with `tools` behind the real client authenticator, on a real
 * socket. The descriptor can be swapped, as when its address comes to answer
 * as another environment, and every bearer it receives is recorded.
 */
export const servePeer = <E, R>(
  initial: ExecutionEnvironmentDescriptor,
  tools: Layer.Layer<never, E, R>,
) =>
  Effect.gen(function* () {
    const descriptor = yield* Ref.make(initial);
    const alternateDescriptor = yield* Ref.make(initial);
    const bearers = yield* Ref.make<ReadonlyArray<string>>([]);
    const probes = yield* Ref.make(0);
    const redirects = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    const redirectedBodies = yield* Ref.make<ReadonlyArray<string>>([]);
    const toolResult = yield* Ref.make<McpSchema.CallToolResult | null>(null);
    const sse = yield* Ref.make(false);
    const replies = yield* Ref.make<ReadonlyMap<string, { status: number; body: unknown }>>(
      new Map(),
    );
    const layerEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Ref.get(descriptor).pipe(Effect.map((current) => current.environmentId)),
      getDescriptor: Ref.get(descriptor),
    });
    const authContext = yield* EnvironmentAuth.layer.pipe(
      Layer.provide(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-peer-" })),
      Layer.provideMerge(NodeServices.layer),
      Layer.fresh,
      Layer.build,
    );
    // Every bearer B receives, on any route, so a test can show one was never sent.
    const layerRecordBearers = HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url.startsWith("/.well-known/t3/environment")) {
            yield* Ref.update(probes, (count) => count + 1);
            if (request.headers.host?.startsWith("localhost:")) {
              if (yield* Ref.get(sse)) {
                return HttpServerResponse.text(
                  [
                    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"result":"notification"}}',
                    "",
                    'data: {"jsonrpc":"2.0","id":999,"error":{"code":-1,"message":"other request"}}',
                    "",
                    'data: {"jsonrpc":"2.0",',
                    'data: "id":' + rpc.id + ',"result":' + JSON.stringify(result) + "}",
                    "",
                    "",
                  ].join("\r\n"),
                  { contentType: "text/event-stream" },
                );
              }
              return HttpServerResponse.jsonUnsafe(yield* Ref.get(alternateDescriptor));
            }
          }
          const redirect = (yield* Ref.get(redirects)).get(request.url);
          if (redirect !== undefined) {
            return HttpServerResponse.redirect(redirect, { status: 307 });
          }
          if (request.url === "/redirect-target") {
            const body = yield* request.text;
            yield* Ref.update(redirectedBodies, (bodies) => [...bodies, body]);
            return HttpServerResponse.empty({ status: 400 });
          }
          const authorization = request.headers.authorization;
          if (authorization !== undefined) {
            yield* Ref.update(bearers, (seen) => [...seen, authorization]);
          }
          const reply = (yield* Ref.get(replies)).get(request.url);
          if (reply !== undefined)
            return HttpServerResponse.jsonUnsafe(reply.body, { status: reply.status });
          const response = yield* httpEffect;
          // Keep real authentication and dispatch, but exercise richer peer wire results.
          const result = yield* Ref.get(toolResult);
          if (result !== null && request.url === "/mcp" && response.status === 200) {
            const rpc = yield* decodeMcpRequest(yield* request.json);
            if (rpc.method === "tools/call") {
              return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, result });
            }
          }
          return response;
        }),
      { global: true },
    );
    const layerRoutes = Layer.mergeAll(
      HttpApiBuilder.layer(PeerTestApi).pipe(
        Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
      tools.pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.succeed(undefined),
          }),
        ),
        Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      ),
    ).pipe(
      Layer.provide(layerRecordBearers),
      Layer.provide(layerEnvironment),
      Layer.provide(Layer.succeedContext(authContext)),
    );
    // Keep the peer's toolkit and MCP server separate from the linking environment.
    yield* HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.fresh,
      Layer.build,
    );
    const address = (yield* HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    return {
      url: `http://127.0.0.1:${address.port}`,
      auth: Context.get(authContext, EnvironmentAuth.EnvironmentAuth),
      descriptor,
      alternateDescriptor,
      bearers,
      toolResult,
      sse,
      replies,
      redirects,
      redirectedBodies,
      /** How often its descriptor was asked for, as a probe of whether it answers. */
      probes,
    };
  });

export type ServedPeer = Effect.Success<ReturnType<typeof servePeer>>;

/**
 * The environment that links: its own database and secret store, reaching
 * peers over plain HTTP. Provide it to anything built on its links.
 */
export const layerLinkingEnvironment = (descriptor: ExecutionEnvironmentDescriptor) =>
  PeerMcpClient.layer.pipe(
    Layer.provideMerge(PeerLinks.layer),
    Layer.provide(
      Layer.mergeAll(
        Sqlite.layerMemory,
        ServerSecretStore.layer,
        FetchHttpClient.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-here-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.fresh,
  );

/** Links `links` to `peer` with a fresh pairing code from it. */
export const linkTo = (
  links: PeerLinks.PeerLinks["Service"],
  peer: ServedPeer,
  access: AuthMcpClientAccess = "auto",
) =>
  peer.auth
    .issuePairingCredential()
    .pipe(
      Effect.flatMap((pairing) =>
        links.link({ url: peer.url, pairingCode: pairing.credential, access }),
      ),
    );
