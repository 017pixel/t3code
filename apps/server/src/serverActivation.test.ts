import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as ServerActivation from "./serverActivation.ts";

it.effect("proves a root is parked before returning and releases it with one gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      yield* ServerActivation.forkParked(Deferred.succeed(ran, undefined)).pipe(
        Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      );
      expect(yield* Deferred.isDone(ran)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(ran);
      expect(yield* Deferred.isDone(ran)).toBe(true);
    }),
  ),
);

it.effect("keeps maintenance parked until activation and client delivery", () =>
  Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    const ran = yield* Deferred.make<void>();
    const background = yield* ServerActivation.makeBackgroundStart(Deferred.await(activation));
    yield* ServerActivation.forkBackground(Deferred.succeed(ran, undefined)).pipe(
      Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
      Effect.provideService(ServerActivation.ServerBackgroundStart, background),
    );

    yield* TestClock.adjust("1 minute");
    expect(yield* Deferred.isDone(ran)).toBe(false);
    yield* Deferred.succeed(activation, undefined);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Deferred.isDone(ran)).toBe(false);

    yield* background.markClientServed;
    yield* Deferred.await(ran);
  }),
);

it.effect("releases background work within a bounded time without a client", () =>
  Effect.gen(function* () {
    const background = yield* ServerActivation.makeBackgroundStart(Effect.void);
    const probes = yield* background.awaitTurn.pipe(Effect.forkScoped);
    const maintenance = yield* background.awaitTurn.pipe(Effect.forkScoped);
    yield* TestClock.adjust("30 seconds");
    expect(probes.pollUnsafe()?._tag).toBe("Success");
    expect(maintenance.pollUnsafe()?._tag).toBe("Success");
    yield* Fiber.join(probes);
    yield* Fiber.join(maintenance);
  }),
);
