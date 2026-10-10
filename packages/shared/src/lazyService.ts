import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";

/** Deferred acquisition keeps services and finalizers in the application scope. */
export const cacheInOwnerScope = <A, E, R>(make: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R | Scope.Scope>();
    const scope = yield* Scope.Scope;
    const fiber = yield* Effect.cached(
      make.pipe(Effect.provideContext(context), Effect.forkIn(scope)),
    );
    return fiber.pipe(Effect.flatMap(Fiber.join));
  });
