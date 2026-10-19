import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import DropUnusedV1Projections from "./063_DropUnusedV1Projections.ts";
import CanonicalizeThreadPullRequestLinks from "./064_CanonicalizeThreadPullRequestLinks.ts";

/**
 * Background sweeps (settlement, pull request sync, the shell reads behind pull request
 * discovery) filtered every thread with `json_extract` on its payload, which holds every linked
 * pull request's snapshot: tens of KB parsed per thread per sweep. This index stores the values
 * they filter on, so SQLite reads them from the index instead of parsing payloads.
 *
 * SQLite computes the entries from `payload_json` on every write, so they stay correct for any
 * writer, including an older build sharing this database. ProjectionStore's sweep queries must
 * spell each expression exactly as it is here, or SQLite parses the payload again.
 */
export default Effect.gen(function* () {
  // Published perf builds used ids 63/64, so the migrator skips main's effects there.
  yield* DropUnusedV1Projections;
  yield* CanonicalizeThreadPullRequestLinks;
  const sql = yield* SqlClient.SqlClient;
  // Development builds of this change created an index of the same name over copied columns.
  // Replace it so every database gets this definition.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_active_idx`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_active_idx
    ON orchestration_v2_projection_threads(
      updated_at,
      thread_id,
      json_extract(payload_json, '$.settledAt'),
      json_extract(payload_json, '$.settledOverride'),
      json_extract(payload_json, '$.pinnedAt'),
      json_extract(payload_json, '$.autoSettleDisabledAt'),
      json_array_length(payload_json, '$.pullRequests'),
      CASE
        WHEN json_extract(payload_json, '$.forkedFrom.type') = 'run'
          THEN json_extract(payload_json, '$.forkedFrom.threadId')
        ELSE NULL
      END,
      provider_instance_id
    )
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
  // Older sweep builds recorded id 62, so they skip main's failed-error index migration.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_failed_error_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC
    )
    WHERE type = 'error' AND status = 'failed'
  `;
});
