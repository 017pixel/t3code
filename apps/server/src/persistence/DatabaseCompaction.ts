// @effect-diagnostics nodeBuiltinImport:off -- Offline maintenance holds a SQLite write lock across replay verification.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { applyThreadPullRequestLinkSync } from "@t3tools/shared/threadPullRequests";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "./Migrations.ts";

const encodeThread = Schema.encodeSync(OrchestrationV2AppThreadJson);
const sameThread = (left: OrchestrationV2AppThread, right: OrchestrationV2AppThread) =>
  JSON.stringify(encodeThread(left)) === JSON.stringify(encodeThread(right));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A legacy snapshot is replaceable only if this field patch reproduces every thread field. */
export function compactThreadFieldEvent(
  event: OrchestrationV2DomainEvent,
  previous: OrchestrationV2AppThread | undefined,
): OrchestrationV2DomainEvent {
  if (previous === undefined) return event;
  if (event.type === "thread.visited") {
    const payload = { lastVisitedAt: event.payload.lastVisitedAt };
    return sameThread({ ...previous, ...payload }, event.payload)
      ? { ...event, type: "thread.visit-recorded", payload }
      : event;
  }
  if (event.type !== "thread.pull-request-synced") return event;
  for (const link of event.payload.pullRequests ?? []) {
    if (link.snapshot === null) continue;
    const payload = {
      host: link.host,
      repository: link.repository,
      number: link.number,
      snapshot: link.snapshot,
      stack: link.stack,
    };
    if (sameThread(applyThreadPullRequestLinkSync(previous, payload), event.payload)) {
      return { ...event, type: "thread.pull-request-link-synced", payload };
    }
  }
  return event;
}

export class DatabaseCompactionError extends Schema.TaggedError<DatabaseCompactionError>()(
  "DatabaseCompactionError",
  { cause: Schema.Defect(), backupPath: Schema.optional(Schema.String) },
) {
  override get message() {
    return this.backupPath === undefined
      ? "Database compaction stopped; see the cause for details. Event rewrites commit only after verification."
      : `Database compaction stopped after committing its verified rewrites; see the cause for details. The database from before compaction is kept at ${this.backupPath}.`;
  }
}

const isDatabaseCompactionError = Schema.is(DatabaseCompactionError);

export class DatabaseCompaction extends Context.Service<
  DatabaseCompaction,
  {
    readonly compact: (input: {
      readonly databasePath: string;
      readonly onProgress?: (message: string) => void;
    }) => Effect.Effect<
      {
        readonly backupPath: string;
        readonly rewrittenEvents: number;
        readonly prunedReceipts: number;
        readonly beforeBytes: number;
        readonly afterBytes: number;
        readonly verifiedTables: ReadonlyArray<string>;
      },
      DatabaseCompactionError
    >;
  }
>()("t3/persistence/DatabaseCompaction") {}

const replayDatabase = (filename: string) =>
  Effect.gen(function* () {
    const database = NodeSqliteClient.layer({ filename });
    const services = yield* Layer.build(
      Layer.fresh(ProjectionStore.layer.pipe(Layer.provideMerge(database))),
    );
    const sql = Context.get(services, SqlClient.SqlClient);
    yield* runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return { sql, projections: Context.get(services, ProjectionStore.ProjectionStoreV2) };
  });

const assertStopped = async (databasePath: string) => {
  let descriptor: string;
  try {
    descriptor = await NodeFSP.readFile(
      NodePath.join(NodePath.dirname(databasePath), "server-runtime.json"),
      "utf8",
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  const state: unknown = JSON.parse(descriptor);
  if (
    typeof state !== "object" ||
    state === null ||
    !("pid" in state) ||
    typeof state.pid !== "number"
  ) {
    throw new Error("Cannot establish that the server is stopped: malformed server-runtime.json.");
  }
  try {
    process.kill(state.pid, 0);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return;
    throw cause;
  }
  throw new Error("Stop the server before running t3 db compact.");
};

/** Scratch directories of a run that died before removing its own. */
const removeStaleScratch = async (databasePath: string, current: string) => {
  const directory = NodePath.dirname(databasePath);
  const prefix = `${NodePath.basename(databasePath)}.compact-`;
  for (const entry of await NodeFSP.readdir(directory)) {
    const path = NodePath.join(directory, entry);
    if (entry.startsWith(prefix) && path !== current) {
      await NodeFSP.rm(path, { recursive: true, force: true });
    }
  }
};

const syncFile = async (filename: string) => {
  const handle = await NodeFSP.open(filename, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Offline, explicitly invoked only. All rewrites roll back unless both fresh replays match current rows. */
const compact = Effect.fn("DatabaseCompaction.compact")(
  function* (input: {
    readonly databasePath: string;
    readonly onProgress?: (message: string) => void;
  }) {
    const progress = input.onProgress ?? (() => {});
    const databasePath = NodePath.resolve(input.databasePath);
    yield* Effect.tryPromise(() => assertStopped(databasePath));
    const beforeBytes = yield* Effect.tryPromise(() =>
      NodeFSP.stat(databasePath).then((stat) => stat.size),
    );
    const startedAt = yield* Clock.currentTimeMillis;
    const backupPath = `${databasePath}.before-compact-${startedAt}`;
    const scratch = yield* Effect.tryPromise(() => NodeFSP.mkdtemp(`${databasePath}.compact-`));
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => NodeFSP.rm(scratch, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
    );
    const database = yield* Effect.acquireRelease(
      Effect.try(() => {
        const db = new NodeSqlite.DatabaseSync(databasePath);
        try {
          db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        } catch (cause) {
          db.close();
          throw cause;
        }
        return db;
      }),
      (db) => Effect.sync(() => db.close()),
    );
    // The write lock keeps any other compaction of this database out.
    yield* Effect.tryPromise(() => removeStaleScratch(databasePath, scratch));
    let committed = false;
    const result = yield* Effect.gen(function* () {
      progress("Backing up the stopped database before any changes...");
      yield* Effect.tryPromise(async () => {
        const source = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
        try {
          await NodeSqlite.backup(source, backupPath, { rate: 256 });
        } finally {
          source.close();
        }
        await NodeFSP.chmod(backupPath, 0o600);
        await syncFile(backupPath);
        const directory = await NodeFSP.open(NodePath.dirname(backupPath), "r");
        try {
          await directory.sync().catch((cause: NodeJS.ErrnoException) => {
            if (cause.code !== "EPERM") throw cause;
          });
        } finally {
          await directory.close();
        }
      });
      progress(
        `Backup saved: ${backupPath}. Replaying original and compacted events into fresh databases...`,
      );
      const beforePath = NodePath.join(scratch, "before.sqlite");
      const afterPath = NodePath.join(scratch, "after.sqlite");
      const before = yield* replayDatabase(beforePath);
      const after = yield* replayDatabase(afterPath);
      const decode = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
      const encode = Schema.encodeEffect(OrchestrationV2DomainEventJson);
      const page =
        database.prepare(`SELECT sequence,event_id,stream_id,event_type,occurred_at,payload_json,metadata_json
      FROM orchestration_events WHERE sequence > ? AND application_event_version=2 AND aggregate_kind='thread'
      ORDER BY sequence LIMIT 100`);
      const update = database.prepare(
        "UPDATE orchestration_events SET event_type=?,payload_json=? WHERE sequence=?",
      );
      let sequence = 0;
      let rewrittenEvents = 0;
      let processed = 0;
      let reportedAt = 0;
      // Identical consecutive legacy snapshots are idempotent projections.
      // Keep the proven patch until a non-legacy event could change any thread.
      const repeated = new Map<
        string,
        {
          readonly type: string;
          readonly payload: string;
          readonly replacementType: string;
          readonly replacementPayload: string;
        }
      >();
      while (true) {
        const rows = yield* Effect.try(() => page.all(sequence));
        if (rows.length === 0) break;
        yield* before.sql.withTransaction(
          after.sql.withTransaction(
            Effect.gen(function* () {
              for (const row of rows) {
                const legacy =
                  row.event_type === "thread.visited" ||
                  row.event_type === "thread.pull-request-synced";
                if (!legacy) repeated.clear();
                const key = String(row.stream_id);
                const cached = repeated.get(key);
                if (
                  legacy &&
                  cached !== undefined &&
                  cached.type === row.event_type &&
                  cached.payload === row.payload_json
                ) {
                  yield* Effect.try(() =>
                    update.run(
                      cached.replacementType,
                      cached.replacementPayload,
                      Number(row.sequence),
                    ),
                  );
                  rewrittenEvents++;
                  sequence = Number(row.sequence);
                  processed++;
                  continue;
                }
                repeated.delete(key);
                const metadata = decodeMetadata(String(row.metadata_json));
                const event = yield* decode({
                  ...metadata,
                  id: row.event_id,
                  threadId: row.stream_id,
                  type: row.event_type,
                  occurredAt: row.occurred_at,
                  payload: decodeJson(String(row.payload_json)),
                });
                let replacement = event;
                if (
                  event.type === "thread.visited" ||
                  event.type === "thread.pull-request-synced"
                ) {
                  const previous = yield* before.projections
                    .getThread(event.threadId)
                    .pipe(Effect.option);
                  replacement = compactThreadFieldEvent(
                    event,
                    previous._tag === "Some" ? previous.value : undefined,
                  );
                }
                yield* before.projections.apply(event);
                yield* after.projections.apply(replacement);
                if (event.type === "turn-item.updated") {
                  for (const replay of [before, after])
                    yield* replay.sql`
              INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
              VALUES (${event.threadId}, ${event.payload.id}, ${event.payload.ordinal})
              ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal=excluded.ordinal
            `;
                }
                if (replacement !== event) {
                  const encoded = yield* encode(replacement);
                  const replacementPayload = encodeJson(encoded.payload);
                  yield* Effect.try(() =>
                    update.run(replacement.type, replacementPayload, Number(row.sequence)),
                  );
                  if (repeated.size < 2000)
                    repeated.set(key, {
                      type: String(row.event_type),
                      payload: String(row.payload_json),
                      replacementType: replacement.type,
                      replacementPayload,
                    });
                  rewrittenEvents++;
                }
                sequence = Number(row.sequence);
                processed++;
              }
            }),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        if (now - reportedAt > 2000) {
          progress(
            `Replayed ${processed} events; ${rewrittenEvents} equivalent field events rewritten.`,
          );
          reportedAt = now;
        }
        yield* Effect.yieldNow;
      }
      progress("Comparing every projection row byte for byte...");
      const verifiedTables = yield* Effect.try(() => {
        const comparison = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
        try {
          comparison.prepare("ATTACH DATABASE ? AS original_replay").run(beforePath);
          comparison.prepare("ATTACH DATABASE ? AS compact_replay").run(afterPath);
          // Thread reads are derived from thread rows and keep a stale row after another build
          // rewrites its thread, which a replay never reproduces. The thread rows are compared.
          const tables = comparison
            .prepare(`SELECT name FROM sqlite_schema WHERE type='table'
        AND name LIKE 'orchestration_v2_projection_%' AND name <> 'orchestration_v2_projection_metadata'
        AND name <> 'orchestration_v2_projection_thread_reads'`)
            .all()
            .map((row) => String(row.name));
          tables.push("orchestration_v2_turn_item_positions");
          for (const table of tables) {
            for (const replay of ["original_replay", "compact_replay"]) {
              const different = comparison
                .prepare(`SELECT EXISTS(SELECT * FROM main."${table}" EXCEPT SELECT * FROM ${replay}."${table}")
            OR EXISTS(SELECT * FROM ${replay}."${table}" EXCEPT SELECT * FROM main."${table}") AS different`)
                .get();
              if (different?.different)
                throw new Error(
                  `Replay differs from current ${table}; no event changes will be committed.`,
                );
            }
          }
          return tables;
        } finally {
          comparison.close();
        }
      });
      // There is no expiry contract for V2 receipts. Only already-imported legacy
      // receipts older than 90 days can be removed without losing command deduplication.
      const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 90 }));
      const prunedReceipts = yield* Effect.try(() =>
        Number(
          database
            .prepare(`DELETE FROM orchestration_command_receipts
      WHERE command_type='legacy' AND accepted_at < ? AND aggregate_kind='thread' AND EXISTS (
        SELECT 1 FROM orchestration_v2_legacy_imports i WHERE i.thread_id=aggregate_id AND i.transcript_imported_at IS NOT NULL
      )`)
            .run(cutoff).changes,
        ),
      );
      yield* Effect.tryPromise(() => assertStopped(databasePath));
      yield* Effect.try(() => database.exec("COMMIT"));
      committed = true;
      progress(
        "Verified rewrites committed. Running VACUUM; interruption leaves a valid compacted log and the backup.",
      );
      yield* Effect.try(() => database.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)"));
      yield* Effect.tryPromise(() => syncFile(databasePath));
      const afterBytes = yield* Effect.tryPromise(() =>
        NodeFSP.stat(databasePath).then((stat) => stat.size),
      );
      progress(
        `Compaction complete: ${beforeBytes} → ${afterBytes} bytes; backup retained at ${backupPath}.`,
      );
      return {
        backupPath,
        rewrittenEvents,
        prunedReceipts,
        beforeBytes,
        afterBytes,
        verifiedTables,
      };
    }).pipe(
      // Nothing changed without a commit, so the backup is only clutter. After one, the
      // backup is the database from before compaction.
      Effect.onError(() =>
        committed
          ? Effect.void
          : Effect.tryPromise(() => NodeFSP.rm(backupPath, { force: true })).pipe(Effect.ignore),
      ),
      Effect.mapError((cause) =>
        committed ? new DatabaseCompactionError({ cause, backupPath }) : cause,
      ),
    );
    return result;
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    isDatabaseCompactionError(cause) ? cause : new DatabaseCompactionError({ cause }),
  ),
);

export const layer = Layer.succeed(DatabaseCompaction, { compact });
