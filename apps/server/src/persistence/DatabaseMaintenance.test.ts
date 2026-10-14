// @effect-diagnostics nodeBuiltinImport:off -- isolated on-disk SQLite fixtures exercise VACUUM.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const withDirectory = <A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-compact-"))),
    run,
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );

const layer = DatabaseMaintenance.layer.pipe(Layer.provide(NodeServices.layer));

it.effect("reclaims free database pages without losing retained data", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(directory, "userdata", "statev2.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* sql`CREATE TABLE retained_data (value TEXT)`;
        yield* sql`INSERT INTO retained_data VALUES ('keep')`;
        yield* sql`CREATE TABLE discarded_data (value BLOB)`;
        yield* sql`INSERT INTO discarded_data VALUES (zeroblob(1048576))`;
        yield* sql`DROP TABLE discarded_data`;
        yield* maintenance.rebuild;
      }).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
            Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      // Exercise upgrading a legacy database, not just vacuuming a new one.
      const legacy = new NodeSqlite.DatabaseSync(dbPath);
      legacy.exec(
        "PRAGMA auto_vacuum=NONE; VACUUM; CREATE TABLE free_pages (value BLOB); INSERT INTO free_pages VALUES (zeroblob(1048576)); DROP TABLE free_pages",
      );
      legacy.close();
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const beforeInspection = NodeFS.readFileSync(dbPath);
      const status = yield* maintenance.inspect(directory);
      assert.isFalse(status.incrementalVacuumEnabled);
      assert.isAbove(status.databaseBytes, 0);
      assert.deepEqual(NodeFS.readFileSync(dbPath), beforeInspection);
      const stages: DatabaseMaintenance.DatabaseRepairStage[] = [];
      const result = yield* maintenance.compact(directory, (stage) =>
        Effect.sync(() => {
          stages.push(stage);
        }),
      );
      assert.deepEqual(stages, [
        "checking-database",
        "compacting-history",
        "verifying-history",
        "reclaiming-space",
        "checkpointing",
      ]);
      assert.isBelow(result.afterBytes, result.beforeBytes);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
        assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
      }).pipe(Effect.provide(Sqlite.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))));
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("refuses a running server before opening its database", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      NodeFS.mkdirSync(NodePath.join(directory, "userdata"));
      NodeFS.writeFileSync(
        NodePath.join(directory, "userdata", "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://localhost:3773",
          startedAt: "2026-10-13T00:00:00.000Z",
        }),
      );
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const error = yield* maintenance.compact(directory).pipe(Effect.flip);
      assert.equal(error.reason, "running");
      assert.isFalse(NodeFS.existsSync(NodePath.join(directory, "userdata", "statev2.sqlite")));
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("does not create a database for an incorrect data directory", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      assert.equal((yield* maintenance.compact(directory).pipe(Effect.flip)).reason, "missing");
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("refuses an unrecorded reader holding the database open", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(directory, "userdata", "statev2.sqlite");
      yield* Effect.void.pipe(
        Effect.provide(Sqlite.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
      );
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath)),
        (database) => Effect.sync(() => database.close()),
      );
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM effect_sql_migrations").all();
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      assert.equal((yield* maintenance.compact(directory).pipe(Effect.flip)).reason, "compact");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  ),
);
