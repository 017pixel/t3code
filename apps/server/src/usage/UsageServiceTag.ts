// @effect-diagnostics deterministicKeys:off -- Preserve the service key while moving its lazy interface.
import type {
  UsageSummaryInput,
  UsageSummary,
  UsagePricing,
  UsageReadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { cacheInOwnerScope } from "@t3tools/shared/lazyService";

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    /** Refetches the rate table ahead of its TTL. See `ensureRates`. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

export const make = Effect.gen(function* () {
  const service = yield* cacheInOwnerScope(
    Effect.promise(() => import("./UsageService.ts")).pipe(Effect.flatMap((live) => live.make)),
  );
  return {
    readSummary: (input: UsageSummaryInput) =>
      service.pipe(Effect.flatMap((value) => value.readSummary(input))),
    refreshRates: service.pipe(Effect.flatMap((value) => value.refreshRates)),
    awaitPersisted: service.pipe(Effect.flatMap((value) => value.awaitPersisted)),
  };
});
export const layer = Layer.effect(UsageService, make);
