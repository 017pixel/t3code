import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";

export const restartingWatch = <A, E, R, E2, R2>(
  watch: (onReady: () => void) => Stream.Stream<A, E, R>,
  reconcile: Effect.Effect<void, E2, R2>,
  onEvent: Effect.Effect<void, never, R2>,
  onStarted: () => void,
) =>
  Effect.gen(function* () {
    let delay = 100;
    let recovering = false;
    while (true) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const watcher = yield* watch(() => {
            Deferred.doneUnsafe(ready, Effect.void);
          }).pipe(
            Stream.runForEach(() => onEvent),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(watcher));
          onStarted();
          if (recovering)
            yield* Effect.raceFirst(
              reconcile.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis") })),
              Fiber.join(watcher),
            );
          yield* Fiber.join(watcher);
        }),
      ).pipe(Effect.ignoreCause({ log: true }));
      onStarted();
      recovering = true;
      yield* Effect.sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  });
