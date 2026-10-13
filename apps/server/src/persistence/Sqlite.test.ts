// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { WAL_SIZE_LIMIT_BYTES } from "./Sqlite.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("serves read transactions without blocking on an external write lock", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-read-tx-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE read_probe(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
    yield* sql`INSERT INTO read_probe(id, name) VALUES (${1}, ${"ready"})`;

    // Hold a write lock for 2 seconds in a child process; read snapshots and
    // standalone SELECT queries should finish immediately on the reader pool.
    yield* spawnWriteLockHolder(dbPath, 2000);
    const startedAt = yield* Clock.currentTimeMillis;
    const snapshot = yield* NodeSqliteClient.withReadTransaction(
      sql,
      Effect.all([
        sql<{ readonly id: number; readonly name: string }>`SELECT id, name FROM read_probe`,
        sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM read_probe`,
      ]),
    );
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

    assert.deepEqual([...snapshot[0]], [{ id: 1, name: "ready" }]);
    assert.deepEqual([...snapshot[1]], [{ count: 1 }]);
    assert.isBelow(elapsedMs, 1000);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("shrinks the WAL file back to the size limit after a large write", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-wal-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const walFileSize = () => NodeFS.statSync(`${dbPath}-wal`).size;
  // About 25% more 4 KB rows than the limit holds, in one transaction.
  const rowCount = Math.ceil((WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
      INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
    `;
    assert.isAbove(walFileSize(), WAL_SIZE_LIMIT_BYTES);

    // The auto-checkpoint after the large commit copied every frame into the
    // database, so the next commit restarts the WAL and cuts the file back.
    yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
    assert.isAtMost(walFileSize(), WAL_SIZE_LIMIT_BYTES);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("collects planner statistics for an existing database on open", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE stats_probe(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL)`;
      yield* sql`CREATE INDEX stats_probe_thread_idx ON stats_probe(thread_id)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
        INSERT INTO stats_probe(thread_id) SELECT 'thread-' || (i % 10) FROM n
      `;
    }).pipe(Effect.provide(persistence()));

    // A database written before statistics existed gets them on the next open.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly stat: string }>`
        SELECT stat FROM sqlite_stat1 WHERE idx = 'stats_probe_thread_idx'
      `;
      assert.deepEqual([...rows], [{ stat: "1000 100" }]);
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
