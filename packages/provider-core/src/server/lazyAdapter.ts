import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as ProviderAdapter from "./ProviderAdapter.ts";

/** Keep construction in the instance scope while sharing it across concurrent first uses. */
export const makeLazyAdapter = <E, R>(
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  make: Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"], E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R | Scope.Scope>();
    const scope = yield* Scope.Scope;
    const fiber = yield* Effect.cached(
      make.pipe(Effect.provideContext(context), Effect.forkIn(scope)),
    );
    const adapter = fiber.pipe(Effect.flatMap(Fiber.join));
    return ProviderAdapter.ProviderAdapterV2.of({
      instanceId,
      driver,
      getCapabilities: () =>
        adapter.pipe(
          Effect.mapError(
            (cause) => new ProviderAdapter.ProviderAdapterCapabilitiesError({ driver, cause }),
          ),
          Effect.flatMap((value) => value.getCapabilities()),
        ),
      planSelectionTransition: (input) =>
        adapter.pipe(
          Effect.mapError(
            (cause) => new ProviderAdapter.ProviderAdapterCapabilitiesError({ driver, cause }),
          ),
          Effect.flatMap((value) => value.planSelectionTransition(input)),
        ),
      openSession: (input) =>
        adapter.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((value) => value.openSession(input)),
        ),
    });
  });
