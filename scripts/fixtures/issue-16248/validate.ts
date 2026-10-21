import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
} from "../../../packages/contracts/src/orchestrationV2.ts";
const db = new NodeSqlite.DatabaseSync(process.argv[2]!, { readOnly: true });
for (const [table, schema] of [
  ["threads", OrchestrationV2AppThread],
  ["runs", OrchestrationV2Run],
  ["nodes", OrchestrationV2ExecutionNode],
  ["messages", OrchestrationV2ConversationMessage],
  ["turn_items", OrchestrationV2TurnItem],
] as const) {
  const rows = db
    .prepare(
      `SELECT payload_json FROM orchestration_v2_projection_${table} WHERE thread_id LIKE 'minimap-proof-%'`,
    )
    .all();
  for (const row of rows)
    Schema.decodeUnknownSync(Schema.toCodecJson(schema))(JSON.parse(String(row.payload_json)));
  console.log(`${table}: ${rows.length} schema-valid synthetic records`);
}
db.close();
