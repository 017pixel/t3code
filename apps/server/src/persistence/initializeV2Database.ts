import * as NodeSqlite from "node:sqlite";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

const LEGACY_SHELL_TABLES = [
  { table: "projection_projects", id: "project_id" },
  { table: "projection_threads", id: "thread_id" },
] as const;

// Compares shells rather than event sequences: compaction deletes copied V1 events from V2.
function hasNewerV1Shells(source: NodeSqlite.DatabaseSync, copy: NodeSqlite.DatabaseSync) {
  return LEGACY_SHELL_TABLES.some(({ table, id }) => {
    const query = `SELECT ${id} AS id, updated_at FROM ${table}`;
    const copied = new Map(
      copy
        .prepare(query)
        .all()
        .map((row) => [row.id, row.updated_at]),
    );
    return source
      .prepare(query)
      .all()
      .some((row) => {
        const copiedUpdatedAt = copied.get(row.id);
        return copiedUpdatedAt === undefined || String(row.updated_at) > String(copiedUpdatedAt);
      });
  });
}

// V1 import and project baseline migrations write event ids prefixed with `migration:`.
function hasNativeV2Events(copy: NodeSqlite.DatabaseSync) {
  return (
    copy
      .prepare(
        "SELECT 1 FROM orchestration_events WHERE application_event_version = 2 AND substr(event_id, 1, 10) <> 'migration:' LIMIT 1",
      )
      .get() !== undefined
  );
}

function inspectStaleCopy(sourcePath: string, destinationPath: string) {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
    try {
      if (!hasNewerV1Shells(source, copy)) return "current" as const;
      return hasNativeV2Events(copy) ? ("diverged" as const) : ("stale" as const);
    } finally {
      copy.close();
    }
  } finally {
    source.close();
  }
}

/** Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(sourcePath))) return;
    if (yield* fs.exists(destinationPath)) {
      // A copy nobody worked in can come from a preview or rollback while the user kept using V1.
      const state = yield* Effect.try(() => inspectStaleCopy(sourcePath, destinationPath)).pipe(
        Effect.orElseSucceed(() => "current" as const),
      );
      if (state === "current") return;
      if (state === "diverged") {
        yield* Effect.logWarning(
          "The V1 database has newer projects or threads, but they are not imported because the V2 database already holds V2 work",
          { sourcePath, destinationPath },
        );
        return;
      }
      const backupBase = `${destinationPath}.stale-${yield* Clock.currentTimeMillis}`;
      let backupPath = backupBase;
      for (let attempt = 1; yield* fs.exists(backupPath); attempt++) {
        backupPath = `${backupBase}-${attempt}`;
      }
      yield* fs.rename(destinationPath, backupPath);
      for (const suffix of ["-wal", "-shm"]) {
        if (yield* fs.exists(destinationPath + suffix)) {
          yield* fs.rename(destinationPath + suffix, backupPath + suffix);
        }
      }
      yield* Effect.logWarning(
        "The V2 database predates newer V1 data and holds no V2 work; moved it aside and copied V1 again",
        { backupPath },
      );
    }
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});
