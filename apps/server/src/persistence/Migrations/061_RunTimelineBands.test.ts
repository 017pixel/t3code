import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";

import * as TurnItemPositionStore from "../../orchestration-v2/TurnItemPositionStore.ts";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(
  Layer.mergeAll(
    TurnItemPositionStore.layer.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

layer("061_RunTimelineBands", (it) => {
  it.effect("keeps stored item order and starts new runs above it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      yield* runMigrations({ toMigrationInclusive: 60 });
      const threadId = ThreadId.make("thread:bands");
      // Run 2 was queued first but its items were stored in band 2; run 3 has
      // items in band 3. Run 4 is still queued and has no items.
      const stored = [
        ["item:1", "run:1", 1_000_001],
        ["item:2", "run:2", 2_000_001],
        ["item:3", "run:3", 3_000_001],
        ["item:3b", "run:3", 3_000_002],
      ] as const;
      for (const [itemId, runId, ordinal] of stored) {
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
          turn_item_id: itemId,
          thread_id: threadId,
          run_id: runId,
          ordinal,
          type: "user_message",
          status: "completed",
          updated_at: "2026-10-01T00:00:00.000Z",
          payload_json: "{}",
        })}`;
        yield* sql`INSERT INTO orchestration_v2_turn_item_positions ${sql.insert({
          thread_id: threadId,
          turn_item_id: itemId,
          ordinal,
        })}`;
      }

      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`
          SELECT run_id, band FROM orchestration_v2_run_timeline_bands ORDER BY band
        `,
        [
          { run_id: "run:1", band: 1 },
          { run_id: "run:2", band: 2 },
          { run_id: "run:3", band: 3 },
        ],
      );

      // An existing run keeps appending in its band.
      assert.strictEqual(
        yield* positions.allocate({
          threadId,
          turnItemId: TurnItemId.make("item:3c"),
          runId: RunId.make("run:3"),
        }),
        3_000_003,
      );
      // A queued run that starts now goes above every existing band.
      assert.strictEqual(
        yield* positions.allocate({
          threadId,
          turnItemId: TurnItemId.make("item:4"),
          runId: RunId.make("run:4"),
        }),
        4_000_001,
      );
    }),
  );
});
