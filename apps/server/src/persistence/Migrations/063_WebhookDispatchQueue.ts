import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduled_task_webhook_queue (
    delivery_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_created_at TEXT NOT NULL,
    prompt TEXT NOT NULL,
    target_json TEXT
  )`;
  yield* sql`CREATE INDEX idx_scheduled_task_webhook_queue_task
    ON scheduled_task_webhook_queue(task_id, task_created_at)`;
});
