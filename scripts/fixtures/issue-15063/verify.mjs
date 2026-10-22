import * as NodeFS from "node:fs";
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
const root = NodeFS.realpathSync(new URL("../../..", import.meta.url));
const require = NodeModule.createRequire(root + "/apps/server/package.json");
const S = await import(require.resolve("effect/Schema"));
const { OrchestrationV2ThreadProjectionJson: Projection } = await import(
  root + "/packages/contracts/src/orchestrationV2.ts"
);
const { ServerProvider } = await import(root + "/packages/contracts/src/server.ts");
const { resolvePendingHandoff: resolve } = await import(
  root + "/packages/client-runtime/src/handoff.ts"
);
const tables = JSON.parse(NodeFS.readFileSync(new URL("./synthetic.json", import.meta.url)))
  .fixtures.single;
const tid = "mcp:62560f84-a9c3-410b-9654-2c196ab6f6e9";
const mapping = {
  thread: "threads",
  runs: "runs",
  attempts: "run_attempts",
  nodes: "nodes",
  subagents: "subagents",
  providerSessions: "provider_sessions",
  providerThreads: "provider_threads",
  providerTurns: "provider_turns",
  runtimeRequests: "runtime_requests",
  messages: "messages",
  plans: "plans",
  turnItems: "turn_items",
  checkpointScopes: "checkpoint_scopes",
  checkpoints: "checkpoints",
  contextHandoffs: "context_handoffs",
  contextTransfers: "context_transfers",
};
const raw = {};
for (const [key, table] of Object.entries(mapping)) {
  const rows = (tables["orchestration_v2_projection_" + table] ?? [])
    .filter((r) =>
      key === "contextTransfers"
        ? r.target_thread_id === tid || r.source_thread_id === tid
        : r.thread_id === tid,
    )
    .map((r) => JSON.parse(r.payload_json));
  raw[key] = key === "thread" ? rows[0] : rows;
}
raw.visibleTurnItems = raw.turnItems.map((item, position) => ({
  position,
  visibility: "local",
  sourceThreadId: tid,
  sourceItemId: item.id,
  item,
}));
raw.updatedAt = "2026-10-22T00:00:00.000Z";
const decode = S.decodeUnknownSync(Projection);
const base = decode(raw);
const selection = base.runs[0].modelSelection;
const provider = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  continuation: { groupKey: "synthetic-shared-home" },
};
const P = (x) => S.decodeUnknownSync(ServerProvider)(x);
const providers = [P(provider)];
let results = [];
function check(name, input, sel = selection, ps = providers, expected = null) {
  const valid = input == null ? input : decode(input);
  const actual = resolve(valid, sel, ps);
  NodeAssert.deepEqual(actual, expected, name);
  results.push({ name, passed: true, actual });
}
const pending = { from: [{ instanceId: "codex" }], to: selection };
check("G1 undefined", undefined);
check("G1 null", null);
check("G1 empty visible window", { ...raw, visibleTurnItems: [] });
check("G1 no runs", { ...raw, runs: [] });
check("G1 unstarted runs", { ...raw, runs: raw.runs.map((r) => ({ ...r, startedAt: null })) });
check("G1 null selection", raw, null);
check("G1 pending baseline", raw, selection, providers, pending);
const rollback = {
  ...raw.runs[0],
  id: "run-evidence-rolled-back",
  ordinal: 2,
  status: "rolled_back",
  modelSelection: { instanceId: "claudeAgent", model: "different" },
};
check(
  "G1 rolled back newest ignored",
  { ...raw, runs: [...raw.runs, rollback] },
  selection,
  providers,
  pending,
);
const tool = {
  ...raw.turnItems[0],
  type: "dynamic_tool",
  toolName: "evidence_tool",
  input: { synthetic: true },
};
for (const k of ["messageId", "inputIntent", "text", "attachments"]) delete tool[k];
check(
  "G1 only tool window",
  { ...raw, visibleTurnItems: [{ ...raw.visibleTurnItems[0], item: tool }] },
  selection,
  providers,
  pending,
);
const transfer = raw.contextTransfers.find((t) => t.type === "merge_back");
for (const type of ["fork", "provider_handoff", "subagent_spawn", "subagent_result"])
  check("G2 exclude " + type, { ...raw, contextTransfers: [{ ...transfer, type }] });
for (const status of ["resolved_native", "resolved_portable", "failed", "consumed", "superseded"])
  check("G2 exclude " + status, { ...raw, contextTransfers: [{ ...transfer, status }] });
check("G2 foreign target", {
  ...raw,
  contextTransfers: [{ ...transfer, targetThreadId: "foreign-evidence-thread" }],
});
check("G2 null source", {
  ...raw,
  contextTransfers: [{ ...transfer, sourceProviderInstanceId: null }],
});
check(
  "G2 unrelated error/target fields ignored",
  {
    ...raw,
    contextTransfers: [
      {
        ...transfer,
        error: "synthetic ignored error",
        targetProviderInstanceId: "otherEvidence",
        targetRunId: "other-evidence-run",
      },
    ],
  },
  selection,
  providers,
  pending,
);
check("G3 no pending matches", { ...raw, contextTransfers: [] });
const transfers = [
  transfer,
  { ...transfer, id: "second-evidence-transfer", sourceProviderInstanceId: "claudeAgent" },
  { ...transfer, id: "duplicate-evidence-transfer" },
];
check("G3 order and duplicates", { ...raw, contextTransfers: transfers }, selection, providers, {
  from: [{ instanceId: "codex" }, { instanceId: "claudeAgent" }, { instanceId: "codex" }],
  to: selection,
});
const changed = { instanceId: "codex", model: "synthetic-new-model" };
check("G3 same-instance no restart", raw, changed, providers, { ...pending, to: changed });
check(
  "G3 model requiring restart wins",
  raw,
  changed,
  [P({ ...provider, requiresNewThreadForModelChange: true })],
  { from: [selection], to: changed },
);
const other = { instanceId: "codexEvidence", model: selection.model };
check(
  "G3 same driver equal defined group",
  raw,
  other,
  [...providers, P({ ...provider, instanceId: other.instanceId })],
  { ...pending, to: other },
);
for (const mode of ["missing-group", "different-group", "different-driver"]) {
  let source = { ...provider };
  let target = { ...provider, instanceId: other.instanceId };
  if (mode === "missing-group") delete source.continuation;
  if (mode === "different-group") target.continuation = { groupKey: "other-group" };
  if (mode === "different-driver") target.driver = "claudeAgent";
  check("G3 " + mode + " wins", raw, other, [P(source), P(target)], {
    from: [selection],
    to: other,
  });
}
const latest = {
  ...raw.runs[0],
  id: "latest-started-evidence-run",
  ordinal: 2,
  modelSelection: { instanceId: "claudeAgent", model: "synthetic-latest" },
};
check(
  "G1 latest started governs precedence",
  { ...raw, runs: [...raw.runs, latest] },
  selection,
  providers,
  { from: [latest.modelSelection], to: selection },
);
console.log(
  JSON.stringify(
    {
      kind: "Schema-valid full projection and provider helper harness; no native/UI claim",
      count: results.length,
      results,
    },
    null,
    2,
  ),
);
