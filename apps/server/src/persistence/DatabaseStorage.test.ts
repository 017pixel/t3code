import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const withDatabase = (incremental: boolean) =>
  DatabaseStorage.layer.pipe(
    Layer.provideMerge(
      incremental ? Sqlite.layerMemory : NodeSqliteClient.layer({ filename: ":memory:" }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), "/tmp/T3 user's data")),
    Layer.provide(NodeServices.layer),
  );

it.effect.each([true, false])(
  "reclaims pages only when incremental vacuum is enabled: %s",
  (incremental) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* DatabaseStorage.DatabaseStorage;
      yield* sql`CREATE TABLE retained (value TEXT)`;
      yield* sql`INSERT INTO retained VALUES ('keep')`;
      yield* sql`CREATE TABLE discarded (value BLOB)`;
      yield* sql`INSERT INTO discarded VALUES (zeroblob(12582912))`;
      yield* sql`DROP TABLE discarded`;
      const before = Option.getOrThrow(yield* storage.status.pipe(Stream.runHead));
      assert.isNotNull(before);
      if (before === null) return;
      assert.equal(before.incrementalVacuumEnabled, incremental);
      assert.isAbove(before.reclaimableBytes, 4 * 1024 * 1024);
      yield* storage.reclaim;
      const after = Option.getOrThrow(yield* storage.status.pipe(Stream.runHead));
      assert.isNotNull(after);
      if (after === null) return;
      if (incremental) {
        assert.isBelow(after.reclaimableBytes, before.reclaimableBytes);
        assert.equal(before.reclaimableBytes - after.reclaimableBytes, 1024 * 4096);
        assert.isBelow(after.databaseBytes, before.databaseBytes);
      } else {
        assert.equal(after.reclaimableBytes, before.reclaimableBytes);
        assert.equal(after.databaseBytes, before.databaseBytes);
      }
      assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
      if ((yield* HostProcess.Platform) !== "win32")
        assert.equal(after.compactCommand, "t3 doctor --base-dir '/tmp/T3 user'\\''s data'");
    }).pipe(Effect.provide(withDatabase(incremental))),
);
