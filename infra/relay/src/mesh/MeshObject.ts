import type * as cf from "@cloudflare/workers-types";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import {
  EnvironmentId,
  MESH_PING_MESSAGE,
  MESH_PONG_MESSAGE,
  type MeshCloseCode,
} from "@t3tools/contracts";
import * as MeshHandlers from "@t3tools/shared/meshRelayObject";
import * as MeshStore from "@t3tools/shared/meshRelayStore";
import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { CloudMintKeyPair } from "../cloudMintKeyPair.ts";
import * as RelayConfiguration from "../Config.ts";
import { layerEffectCrypto } from "../WebCrypto.ts";
import { RelayDeploymentConfig } from "../zone.ts";

/** Set by the worker after it authenticated the member; the object trusts nothing else. */
export const MESH_SOCKET_ENVIRONMENT_HEADER = "x-t3-mesh-environment-id";
/** Set by the worker: the Connect user whose link admitted the member. */
export const MESH_SOCKET_USER_HEADER = "x-t3-mesh-user-id";

type Call<A> = Effect.Effect<A, never, Alchemy.RuntimeContext>;

/**
 * One per Connect user, named by the user id: members, presence, pin and captain. Every call
 * names the user too; the object keeps the first one and refuses any other.
 */
export class MeshObject extends Cloudflare.DurableObject<
  MeshObject,
  {
    readonly view: (userId: string) => Call<MeshHandlers.MeshView>;
    readonly unlink: (userId: string, environmentId: string) => Call<void>;
  }
>()("MeshObject") {}

// The attachment holds only the environment id; a replaced socket has none.
const SocketAttachment = Schema.Struct({ environmentId: EnvironmentId });
const decodeAttachment = Schema.decodeUnknownOption(SocketAttachment);

const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_ABNORMAL_CLOSURE = 1006;

/** The worker's answer to a member it refuses: a socket closed at once with a permanent code. */
export const refuseSocket = (code: MeshCloseCode, reason: string) =>
  Effect.sync(() => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.close(code, reason);
    return HttpServerResponse.setBody(
      HttpServerResponse.empty({ status: 101 }),
      HttpBody.raw(new Response(null, { status: 101, webSocket: client })),
    );
  });

export const layer = MeshObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // Same bindings the worker reads: grants are signed with the relay mint key.
    const mintKeyPair = yield* CloudMintKeyPair;
    const mintPrivateKey = yield* mintKeyPair.privateKey;
    const meshAllowedUserIds = yield* RelayConfiguration.meshAllowedUserIdsConfig.pipe(
      Effect.orDie,
    );
    const { relayPublicOrigin } = yield* RelayDeploymentConfig.pipe(Effect.orDie);
    // Only the per-object inner Effect may access storage.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const raw = state.raw;
      const layerRuntime = Layer.merge(
        SqliteClient.layer({ storage: raw.storage }),
        layerEffectCrypto,
      );
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(layerRuntime), Effect.orDie);
      yield* run(MeshStore.migrate);
      // Pings are answered without waking the object; the alarm reads their timestamps.
      raw.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(MESH_PING_MESSAGE, MESH_PONG_MESSAGE),
      );

      const sockets: MeshHandlers.MeshSockets<cf.WebSocket> = {
        list: Effect.sync(() =>
          raw.getWebSockets().filter((socket) => socket.readyState === WEB_SOCKET_OPEN),
        ),
        environmentOf: (socket) =>
          Option.match(decodeAttachment(socket.deserializeAttachment()), {
            onNone: () => null,
            onSome: (attachment) => attachment.environmentId,
          }),
        lastPingAt: (socket) =>
          Effect.sync(() => raw.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null),
        send: (socket, text) => Effect.try(() => socket.send(text)).pipe(Effect.ignore),
        retire: (socket, code, reason) =>
          Effect.try(() => {
            socket.serializeAttachment(null);
            socket.close(code, reason);
          }).pipe(Effect.ignore),
      };
      const ctx: MeshHandlers.MeshObjectContext<cf.WebSocket> = {
        isAllowlisted: (userId) => meshAllowedUserIds.includes(userId),
        issuer: relayPublicOrigin,
        mintPrivateKey: yield* mintPrivateKey,
        sockets,
        setAlarm: (at) =>
          Effect.promise(() =>
            at === null ? raw.storage.deleteAlarm() : raw.storage.setAlarm(at),
          ),
      };

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const environmentId = request.headers[MESH_SOCKET_ENVIRONMENT_HEADER];
          const userId = request.headers[MESH_SOCKET_USER_HEADER];
          if (
            environmentId === undefined ||
            userId === undefined ||
            request.headers.upgrade?.toLowerCase() !== "websocket"
          ) {
            return HttpServerResponse.empty({ status: 400 });
          }
          if (!(yield* run(MeshHandlers.claimOwner(userId)))) {
            yield* Effect.logError("Refused a mesh socket for another user's mesh object");
            return HttpServerResponse.empty({ status: 403 });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          socket.serializeAttachment({ environmentId });
          yield* run(MeshHandlers.connect(ctx, EnvironmentId.make(environmentId)));
          return response;
        }),
        webSocketMessage: (socket: Cloudflare.WebSocket, message: string | ArrayBuffer) =>
          run(MeshHandlers.message(ctx, socket.ws, message)),
        webSocketClose: (socket: Cloudflare.WebSocket, code: number, reason: string) =>
          // Answer the member's close frame; a no-op where the runtime already did.
          Effect.try(() => socket.ws.close(code, reason)).pipe(
            Effect.ignore,
            Effect.andThen(run(MeshHandlers.close(ctx, socket.ws, code))),
          ),
        webSocketError: (socket: Cloudflare.WebSocket) =>
          run(MeshHandlers.close(ctx, socket.ws, WEB_SOCKET_ABNORMAL_CLOSURE)),
        alarm: () => run(MeshHandlers.alarm(ctx)),
        view: (userId) => run(MeshHandlers.view(userId)),
        unlink: (userId, environmentId) =>
          run(MeshHandlers.unlink(ctx, userId, EnvironmentId.make(environmentId))),
      };
    });
  }),
);
