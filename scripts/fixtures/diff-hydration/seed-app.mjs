import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    "base-dir": { type: "string" },
    directory: { type: "string" },
    "server-stopped": { type: "boolean", default: false },
  },
});
if (!values["base-dir"] || !values.directory || !values["server-stopped"]) {
  throw new Error(
    "Use --base-dir <isolated-migrated-home> --directory <generated-repo> --server-stopped. Stop its server before running this visual projection fixture.",
  );
}
const baseDir = NodeFS.realpathSync(values["base-dir"]);
const sharedHome = NodePath.join(NodeOS.homedir(), ".t3");
if (baseDir === sharedHome || baseDir.startsWith(`${sharedHome}${NodePath.sep}`)) {
  throw new Error("Refusing the shared T3 home");
}
const directory = NodeFS.realpathSync(values.directory);
const databasePath = NodePath.join(baseDir, "userdata", "statev2.sqlite");
if (!NodeFS.existsSync(databasePath))
  throw new Error("Start and stop an isolated T3 server once to run migrations first");
const fixture = JSON.parse(
  NodeFS.readFileSync(new URL("./app-state.json", import.meta.url), "utf8"),
);
const scopeId = fixture.orchestration_v2_projection_checkpoint_scopes[0].scope_id;
const scopeKey = NodeCrypto.createHash("sha256").update(scopeId).digest("hex").slice(0, 32);
const refs = [0, 1, 2].map((ordinal) => {
  const ref = `refs/t3/orchestration-v2/checkpoints/${Buffer.from(scopeKey).toString("base64url")}/ordinal/${ordinal}`;
  const sha = NodeChildProcess.execFileSync(
    "git",
    ["rev-parse", `refs/t3-fixture/ordinal/${ordinal}^{commit}`],
    { cwd: directory, encoding: "utf8" },
  ).trim();
  NodeChildProcess.execFileSync("git", ["update-ref", ref, sha], { cwd: directory });
  return { ordinal, ref, sha };
});
for (const checkpoint of fixture.orchestration_v2_projection_checkpoints) {
  const ordinal = checkpoint.ordinal_within_scope;
  if (ordinal === 0) continue;
  const args = ["diff", "--no-renames", "-z", refs[ordinal - 1].ref, refs[ordinal].ref];
  const gitDiff = (format) =>
    NodeChildProcess.execFileSync("git", [...args, format], { cwd: directory, encoding: "utf8" });
  const statuses = gitDiff("--name-status").split("\0").filter(Boolean);
  const kinds = new Map();
  for (let index = 0; index < statuses.length; index += 2)
    kinds.set(
      statuses[index + 1],
      statuses[index] === "A" ? "added" : statuses[index] === "D" ? "deleted" : "modified",
    );
  checkpoint.payload_json.files = gitDiff("--numstat")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [additions, deletions, path] = entry.split("\t");
      return {
        path,
        kind: kinds.get(path),
        additions: Number(additions),
        deletions: Number(deletions),
      };
    });
}
const replacements = new Map([
  ["__DIRECTORY__", directory],
  ...refs.map(({ ordinal, ref }) => [`__CHECKPOINT_REF_${ordinal}__`, ref]),
]);
const replace = (value) => {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(replace);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
  return value;
};
// Only stopped visual projections are inserted. No events, outbox effects,
// provider bindings, auth rows, or permission state are created or altered.
const database = new NodeSqlite.DatabaseSync(databasePath);
try {
  database.exec("BEGIN IMMEDIATE");
  for (const [table, rows] of Object.entries(fixture)) {
    if (table !== "projection_projects" && !table.startsWith("orchestration_v2_projection_"))
      throw new Error(`Unexpected fixture table ${table}`);
    for (const template of rows) {
      const row = replace(template);
      if (row.payload_json) row.payload_json = JSON.stringify(row.payload_json);
      const columns = Object.keys(row);
      const existingColumns = new Set(
        database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      );
      if (columns.some((column) => !existingColumns.has(column)))
        throw new Error(`Fixture schema does not match migrated ${table}`);
      const primaryKey = columns[0];
      const update = columns
        .slice(1)
        .map((column) => `${column}=excluded.${column}`)
        .join(",");
      database
        .prepare(
          `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(${primaryKey}) DO UPDATE SET ${update}`,
        )
        .run(...Object.values(row));
    }
  }
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
} finally {
  database.close();
}
process.stdout.write(
  `${JSON.stringify({ databasePath, directory, threadId: fixture.orchestration_v2_projection_threads[0].thread_id, refs }, null, 2)}\n`,
);
