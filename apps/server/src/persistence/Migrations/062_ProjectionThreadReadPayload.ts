import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  compactThreadPullRequests,
  encodeThreadReadPayload,
} from "../../orchestration-v2/ThreadReadPayload.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_thread_reads (
      thread_id TEXT PRIMARY KEY NOT NULL,
      compact_payload_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
  let after = "";
  while (true) {
    const rows = yield* sql<{ thread_id: string; payload_json: string }>`
      SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
      WHERE thread_id > ${after} ORDER BY thread_id LIMIT 100
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      const thread = yield* decode(row.payload_json);
      const payload = yield* encodeThreadReadPayload(thread);
      const compact = yield* encodeThreadReadPayload(compactThreadPullRequests(thread));
      yield* sql`
        INSERT OR REPLACE INTO orchestration_v2_projection_thread_reads (thread_id, payload_json, compact_payload_json)
        VALUES (${row.thread_id}, ${payload}, ${compact})
      `;
    }
    after = rows[rows.length - 1]!.thread_id;
  }
});
