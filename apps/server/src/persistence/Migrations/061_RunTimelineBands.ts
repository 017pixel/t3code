import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Each run's turn items sit in one band of a thread's timeline, assigned when
  // the run writes its first item. TurnItemPositionStore owns this table.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_run_timeline_bands (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      band INTEGER NOT NULL,
      PRIMARY KEY (thread_id, run_id)
    )
  `;
  // Runs that already wrote items keep the band their positions were allocated
  // in, so stored items keep their order. Runs without items get a band when
  // they start.
  yield* sql`
    INSERT INTO orchestration_v2_run_timeline_bands (thread_id, run_id, band)
    SELECT thread_id, run_id, MAX(ordinal / 1000000)
    FROM orchestration_v2_projection_turn_items
    WHERE run_id IS NOT NULL
    GROUP BY thread_id, run_id
    ON CONFLICT(thread_id, run_id) DO NOTHING
  `;
});
