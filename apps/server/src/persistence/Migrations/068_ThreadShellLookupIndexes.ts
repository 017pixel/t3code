import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_last_executed_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
    )
    WHERE status <> 'queued'
      AND NOT(status='cancelled' AND json_extract(payload_json,'$.startedAt') IS NULL)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_interrupt_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type='run_interrupt_request'
  `;
});
