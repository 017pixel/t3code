import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../serverActivation.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";

/** Remove superseded history after startup, in the maintenance service's bounded batches. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* forkParked(
      Effect.sleep("1 minute").pipe(
        Effect.andThen(
          maintenance.compactEventStore.pipe(
            Effect.tap((result) =>
              result.deletedEventCount > 0 || result.deletedReceiptCount > 0
                ? Effect.logInfo("Compacted orchestration history", result)
                : Effect.void,
            ),
            Effect.catchTags({
              ProjectionMaintenanceError: (error) =>
                Effect.logWarning("Orchestration history compaction failed", { cause: error }),
            }),
            Effect.repeat(Schedule.spaced("6 hours")),
          ),
        ),
      ),
    );
  }),
);
