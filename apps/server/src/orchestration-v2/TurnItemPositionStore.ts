import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

/** Positions per band; a turn item's band is `Math.floor(position / BAND_SIZE)`. */
const BAND_SIZE = 1_000_000;

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // A thread's timeline is split into bands of BAND_SIZE positions. Runless
    // items share band 0. A run gets the next free band when it writes its
    // first item, which happens when it starts, so runs sort by when they
    // started rather than by their ordinal, which is fixed when they are queued.
    const allocate: TurnItemPositionStoreV2Shape["allocate"] = ({ threadId, turnItemId, runId }) =>
      Effect.gen(function* () {
        const selectBand = (id: RunId) => sql<{ readonly band: number }>`
          SELECT band
          FROM orchestration_v2_run_timeline_bands
          WHERE thread_id = ${threadId} AND run_id = ${id}
          LIMIT 1
        `;
        let band = 0;
        if (runId !== null) {
          // Most calls update an item of a run that already has its band.
          let bandRows = yield* selectBand(runId);
          if (bandRows[0] === undefined) {
            yield* sql`
              INSERT INTO orchestration_v2_run_timeline_bands (thread_id, run_id, band)
              SELECT ${threadId}, ${runId}, COALESCE(MAX(band), 0) + 1
              FROM orchestration_v2_run_timeline_bands
              WHERE thread_id = ${threadId}
              ON CONFLICT(thread_id, run_id) DO NOTHING
            `;
            bandRows = yield* selectBand(runId);
          }
          band = bandRows[0]?.band ?? 0;
        }
        const lowerBound = band * BAND_SIZE;
        const upperBound = lowerBound + BAND_SIZE - 1;
        yield* sql`
          INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
          SELECT
            ${threadId},
            ${turnItemId},
            COALESCE(MAX(ordinal), ${lowerBound}) + 1
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
            AND ordinal >= ${lowerBound}
            AND ordinal <= ${upperBound}
          ON CONFLICT(thread_id, turn_item_id) DO NOTHING
        `;
        const rows = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
        const ordinal = rows[0]?.ordinal;
        if (ordinal === undefined) {
          return yield* new TurnItemPositionStoreError({
            threadId,
            turnItemId,
            cause: "Position allocation returned no row.",
          });
        }
        return ordinal;
      }).pipe(
        Effect.mapError((cause) =>
          isTurnItemPositionStoreError(cause)
            ? cause
            : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
        ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      normalize: (item) =>
        allocate({ threadId: item.threadId, turnItemId: item.id, runId: item.runId }).pipe(
          Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })),
        ),
    });
  }),
);
