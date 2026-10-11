import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/** Older clients cannot decode the added restart event. */
export const eventsForClient = (
  events: Stream.Stream<ServerLifecycleStreamEvent>,
  input: { readonly updateRestarts?: boolean },
) =>
  events.pipe(
    Stream.filter((event) => event.type !== "updateRestart" || input.updateRestarts === true),
    Stream.mapEffect((event) => {
      if (event.type !== "updateRestart" || event.payload.expiresAt === undefined) {
        return Effect.succeed(event);
      }
      const expiresAt = event.payload.expiresAt;
      return Clock.currentTimeMillis.pipe(
        Effect.map((now) => ({
          ...event,
          payload: { ...event.payload, expiresInMs: Math.max(0, expiresAt - now) },
        })),
      );
    }),
    Stream.filter((event) => event.type !== "updateRestart" || event.payload.expiresInMs !== 0),
  );

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "updateRestart" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "legacyThreadMigration" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  {
    readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
    readonly snapshot: Effect.Effect<SnapshotState>;
    readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
  }
>()("t3/serverLifecycleEvents") {}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
  const state = yield* Ref.make<SnapshotState>({
    sequence: 0,
    events: [],
  });

  return {
    publish: (event) =>
      Ref.modify(state, (current) => {
        const nextSequence = current.sequence + 1;
        const nextEvent = {
          ...event,
          sequence: nextSequence,
        } satisfies ServerLifecycleStreamEvent;
        const nextEvents = [
          nextEvent,
          ...current.events.filter((entry) => entry.type !== nextEvent.type),
        ];
        return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
      }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event))),
    snapshot: Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const now = yield* Clock.currentTimeMillis;
      return {
        ...current,
        events: current.events.filter(
          (event) =>
            event.type !== "updateRestart" ||
            event.payload.expiresAt === undefined ||
            event.payload.expiresAt > now,
        ),
      };
    }),
    get stream() {
      return Stream.fromPubSub(pubsub);
    },
  } satisfies ServerLifecycleEvents["Service"];
});

export const layer = Layer.effect(ServerLifecycleEvents, make);
