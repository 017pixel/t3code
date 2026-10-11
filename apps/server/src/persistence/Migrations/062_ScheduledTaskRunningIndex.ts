import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_running
    ON scheduled_tasks(last_run_status) WHERE last_run_status = 'running'`;
});
