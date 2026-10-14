import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

export class DatabaseMaintenanceError extends Schema.TaggedError<DatabaseMaintenanceError>()(
  "DatabaseMaintenanceError",
  {
    reason: Schema.Literals(["running", "missing", "invalid-projections", "compact"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "running":
        return "Stop the T3 Code server and desktop app before compacting the database.";
      case "missing":
        return "No existing T3 Code database was found in this data directory.";
      case "invalid-projections":
        return "Database projections need repair before compaction.";
      case "compact":
        return "Database compaction failed. Check that no other process has the database open and enough disk space is available.";
    }
  }
}

export class DatabaseMaintenance extends Context.Service<
  DatabaseMaintenance,
  {
    readonly compact: (baseDir: string) => Effect.Effect<
      {
        readonly beforeBytes: number;
        readonly afterBytes: number;
        readonly deletedEventCount: number;
        readonly deletedReceiptCount: number;
      },
      DatabaseMaintenanceError
    >;
  }
>()("t3/persistence/DatabaseMaintenance") {}

const isDatabaseMaintenanceError = Schema.is(DatabaseMaintenanceError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const compact = Effect.fn("DatabaseMaintenance.compact")(
    function* (baseDir: string) {
      const stateDir = path.join(baseDir, "userdata");
      const databasePath = path.join(stateDir, "statev2.sqlite");
      const runtime = yield* readPersistedServerRuntimeState(
        path.join(stateDir, "server-runtime.json"),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      if (Option.isSome(runtime) && isProcessAlive(runtime.value.pid)) {
        return yield* new DatabaseMaintenanceError({ reason: "running" });
      }
      if (!(yield* fs.exists(databasePath))) {
        return yield* new DatabaseMaintenanceError({ reason: "missing" });
      }
      const beforeBytes = Number((yield* fs.stat(databasePath)).size);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Keep an exclusive SQLite lock through compaction and VACUUM. This also
          // rejects readers not represented by the server runtime file.
          yield* sql`PRAGMA busy_timeout = 0`;
          yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
          yield* sql`BEGIN EXCLUSIVE`;
          yield* sql`COMMIT`;
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          if (!(yield* maintenance.verify).valid) {
            return yield* new DatabaseMaintenanceError({ reason: "invalid-projections" });
          }
          const summary = yield* maintenance.compactEventStore;
          if (!(yield* maintenance.verify).valid) {
            return yield* new DatabaseMaintenanceError({ reason: "invalid-projections" });
          }
          yield* sql`VACUUM`;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          return summary;
        }).pipe(
          Effect.provide(
            ProjectionMaintenance.layer.pipe(
              Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
            ),
          ),
        ),
      );
      const afterBytes = Number((yield* fs.stat(databasePath)).size);
      return {
        beforeBytes,
        afterBytes,
        deletedEventCount: result.deletedEventCount,
        deletedReceiptCount: result.deletedReceiptCount,
      };
    },
    Effect.mapError((cause) =>
      isDatabaseMaintenanceError(cause)
        ? cause
        : new DatabaseMaintenanceError({ reason: "compact", cause }),
    ),
  );
  return DatabaseMaintenance.of({ compact });
});

export const layer = Layer.effect(DatabaseMaintenance, make);
