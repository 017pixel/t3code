import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  compactThreadPullRequests,
  encodeThreadReadPayload,
} from "../../orchestration-v2/ThreadReadPayload.ts";

/**
 * A read projection of each thread's payload with repeated pull request stacks stored once, plus
 * a compact copy for the shell and background sweeps. ProjectionStore writes it next to the
 * thread row.
 *
 * Another build sharing this database rewrites thread payloads without it. The triggers mark the
 * read row stale on any thread write, whoever makes it, and readers use the thread payload for a
 * stale or missing row until this build writes the thread again.
 *
 * ProjectionStore's readers join this table, so it cannot depend on migration 63 running: a
 * database that recorded another build's migration at or above 63 skips it. runMigrations also
 * runs this after every migration pass, and it does nothing once the table and triggers exist.
 */
const ensureInTransaction = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('orchestration_v2_projection_thread_reads')
    `;
    if (!columns.some((column) => column.name === "source_stale")) {
      // Development builds of this change created the table without `source_stale`. It is derived
      // from the thread rows, so rebuild it.
      yield* sql`DROP TABLE IF EXISTS orchestration_v2_projection_thread_reads`;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_thread_reads (
          thread_id TEXT PRIMARY KEY NOT NULL,
          source_stale INTEGER NOT NULL DEFAULT 0,
          compact_payload_json TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;
      const decode = Schema.decodeUnknownEffect(
        Schema.fromJsonString(OrchestrationV2AppThreadJson),
      );
      let after = "";
      while (true) {
        const rows = yield* sql<{ thread_id: string; payload_json: string }>`
          SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
          WHERE thread_id > ${after} ORDER BY thread_id LIMIT 100
        `;
        if (rows.length === 0) break;
        for (const row of rows) {
          // A payload this build cannot decode keeps no read row; readers use the thread payload.
          const encoded = yield* decode(row.payload_json).pipe(
            Effect.flatMap((thread) =>
              Effect.all([
                encodeThreadReadPayload(thread),
                encodeThreadReadPayload(compactThreadPullRequests(thread)),
              ]),
            ),
            Effect.option,
          );
          if (Option.isNone(encoded)) continue;
          const [payload, compact] = encoded.value;
          yield* sql`
            INSERT INTO orchestration_v2_projection_thread_reads (thread_id, payload_json, compact_payload_json)
            VALUES (${row.thread_id}, ${payload}, ${compact})
          `;
        }
        after = rows[rows.length - 1]!.thread_id;
      }
    }
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS orchestration_v2_projection_thread_reads_stale_on_insert
      AFTER INSERT ON orchestration_v2_projection_threads
      BEGIN
        UPDATE orchestration_v2_projection_thread_reads SET source_stale = 1
        WHERE thread_id = NEW.thread_id;
      END
    `;
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS orchestration_v2_projection_thread_reads_stale_on_update
      AFTER UPDATE OF payload_json ON orchestration_v2_projection_threads
      BEGIN
        UPDATE orchestration_v2_projection_thread_reads SET source_stale = 1
        WHERE thread_id = NEW.thread_id;
      END
    `;
  });

export const ensureThreadReadProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(ensureInTransaction(sql));
});

export default ensureThreadReadProjection;
