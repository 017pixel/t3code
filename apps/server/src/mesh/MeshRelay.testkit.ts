// Stand-ins for the relay's mesh object, over the real member socket protocol.
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  MESH_PING_MESSAGE,
  MESH_PONG_MESSAGE,
  MeshCloseCode,
} from "@t3tools/contracts";
import * as MeshRelayObject from "@t3tools/shared/meshRelayObject";
import * as MeshRelayStore from "@t3tools/shared/meshRelayStore";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import { WebSocket, WebSocketServer } from "ws";

type RelayEvent =
  | {
      readonly type: "connection";
      readonly socket: WebSocket;
      readonly authorization?: string;
      readonly path?: string;
    }
  | { readonly type: "frame"; readonly socket: WebSocket; readonly text: string }
  | { readonly type: "close"; readonly socket: WebSocket; readonly code: number }
  | { readonly type: "alarm" };

/** Records what members send, in order; tests answer through each event's socket. */
export const startRelay = Effect.fn("MeshRelayTestkit.startRelay")(function* () {
  const events = yield* Queue.unbounded<RelayEvent>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<WebSocketServer>((resume) => {
      const created: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () =>
        resume(Effect.succeed(created)),
      );
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resume(Effect.void));
      }),
  );
  server.on("connection", (socket, request) => {
    Queue.offerUnsafe(events, {
      type: "connection",
      socket,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(request.url ? { path: request.url } : {}),
    });
    socket.on("message", (data) =>
      Queue.offerUnsafe(events, { type: "frame", socket, text: String(data) }),
    );
    socket.on("close", (code) => Queue.offerUnsafe(events, { type: "close", socket, code }));
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const next = <T extends RelayEvent["type"]>(type: T) =>
    Queue.take(events).pipe(
      Effect.flatMap((event) =>
        event.type === type
          ? Effect.succeed(event as Extract<RelayEvent, { readonly type: T }>)
          : Effect.die(`expected ${type}, got ${event.type}`),
      ),
    );
  return {
    url: `http://127.0.0.1:${port}`,
    events,
    nextConnection: next("connection"),
    nextFrame: next("frame").pipe(
      Effect.map((event) => JSON.parse(event.text) as Record<string, unknown>),
    ),
    nextRawFrame: next("frame").pipe(Effect.map((event) => event.text)),
    nextClose: next("close").pipe(Effect.map((event) => event.code)),
  };
});

const CREDENTIAL_PREFIX = "Bearer mesh-relay-credential:";

/** The environment credential a member presents to {@link startMeshRelay}. */
export const meshRelayCredential = (environmentId: EnvironmentId) =>
  `mesh-relay-credential:${environmentId}`;

/**
 * One account's mesh object, running the relay's own handlers on in-memory SQLite. It plays the
 * worker too: a member authenticates with {@link meshRelayCredential}, the account is in the mesh
 * rollout, and pings are answered without reaching the object. Events run one at a time, as in a
 * Durable Object.
 */
export const startMeshRelay = Effect.fn("MeshRelayTestkit.startMeshRelay")(function* (options: {
  readonly issuer: string;
  readonly cloudUserId: string;
  readonly mintPrivateKey: string;
}) {
  const relay = yield* startRelay();
  const runtime = yield* Layer.build(
    Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCryptoLayer.layer),
  );
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(runtime), Effect.orDie);
  yield* run(MeshRelayStore.migrate);

  // The socket's attachment: its member, or null once retired.
  const attachments = new Map<WebSocket, EnvironmentId | null>();
  const pings = new Map<WebSocket, number>();
  const closes = yield* PubSub.unbounded<{
    readonly environmentId: EnvironmentId;
    readonly code: number;
  }>();
  const alarm = yield* FiberHandle.make<void>();
  const ctx: MeshRelayObject.MeshObjectContext<WebSocket> = {
    isAllowlisted: (userId) => userId === options.cloudUserId,
    issuer: options.issuer,
    mintPrivateKey: Redacted.make(options.mintPrivateKey),
    sockets: {
      list: Effect.sync(() =>
        [...attachments.keys()].filter((socket) => socket.readyState === WebSocket.OPEN),
      ),
      environmentOf: (socket) => attachments.get(socket) ?? null,
      lastPingAt: (socket) => Effect.sync(() => pings.get(socket) ?? null),
      send: (socket, text) =>
        Effect.sync(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        }),
      retire: (socket, code, reason) =>
        Effect.sync(() => {
          attachments.set(socket, null);
          socket.close(code, reason);
        }),
    },
    setAlarm: (at) =>
      at === null
        ? FiberHandle.clear(alarm)
        : Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              FiberHandle.run(
                alarm,
                Effect.sleep(Math.max(0, at - now)).pipe(
                  Effect.andThen(Queue.offer(relay.events, { type: "alarm" })),
                  Effect.asVoid,
                ),
              ),
            ),
            Effect.asVoid,
          ),
  };

  const handle = Effect.fn("MeshRelayTestkit.handle")(function* (event: RelayEvent) {
    switch (event.type) {
      case "connection": {
        if (!event.authorization?.startsWith(CREDENTIAL_PREFIX)) {
          event.socket.close(MeshCloseCode.notAllowlisted);
          return;
        }
        if (!(yield* run(MeshRelayObject.claimOwner(options.cloudUserId)))) {
          return yield* Effect.die("the mesh object belongs to another user");
        }
        const environmentId = EnvironmentId.make(
          event.authorization.slice(CREDENTIAL_PREFIX.length),
        );
        attachments.set(event.socket, environmentId);
        return yield* run(MeshRelayObject.connect(ctx, environmentId));
      }
      case "frame": {
        if (event.text === MESH_PING_MESSAGE) {
          pings.set(event.socket, yield* Clock.currentTimeMillis);
          event.socket.send(MESH_PONG_MESSAGE);
          return;
        }
        return yield* run(MeshRelayObject.message(ctx, event.socket, event.text));
      }
      case "close": {
        const environmentId = attachments.get(event.socket) ?? null;
        yield* run(MeshRelayObject.close(ctx, event.socket, event.code));
        attachments.delete(event.socket);
        pings.delete(event.socket);
        if (environmentId !== null)
          yield* PubSub.publish(closes, { environmentId, code: event.code });
        return;
      }
      case "alarm":
        return yield* run(MeshRelayObject.alarm(ctx));
    }
  });

  yield* Queue.take(relay.events).pipe(Effect.flatMap(handle), Effect.forever, Effect.forkScoped);
  return {
    url: relay.url,
    view: run(MeshRelayObject.view(options.cloudUserId)),
    /** Each member socket close, after the object handled it. Subscribe before the close. */
    subscribeCloses: PubSub.subscribe(closes),
  };
});
