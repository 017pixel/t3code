// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

it.effect(
  "snapshots V1, imports transcripts lazily, and preserves both databases across switches",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("legacy-thread");
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      for (let index = 0; index < 6; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      );
      const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
      const layerImporter = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* legacy.reconcileShells;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadProjection(threadId);
        assert.equal(shell.thread.id, threadId);
        assert.deepEqual(
          shell.messages.map((message) => message.text),
          ["Text 4", "Text 5"],
        );
        const pending =
          yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(pending[0]?.transcript_imported_at, null);
        yield* legacy.ensureTranscript(threadId);
        const transcript = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          transcript.messages.map((message) => message.text),
          ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
        );
        const imported =
          yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(imported[0]?.imported_message_count, 6);
        assert.isNotNull(imported[0]?.transcript_imported_at);
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(layerImporter));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
            )
            .get()?.count,
          0,
        );
        v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
      } finally {
        v1.close();
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
        assert.equal((yield* sql`SELECT title FROM projection_threads`)[0]?.title, "V1 thread");
      }).pipe(Effect.provide(layerDatabase));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("re-seeds a migration-only V2 store when V1 gained threads after the copy", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-stale-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project-a', 'Project A', '/tmp/project-a', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES ('thread-a', 'project-a', 'First V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

  return Effect.gen(function* () {
    yield* seed;
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(layerDatabase),
    );
    const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
    const layerImporter = LegacyV1ThreadImporter.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
    );
    const startV2 = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).reconcileShells;
      const rows =
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
      return rows.map((row) => row.thread_id);
    }).pipe(Effect.provide(layerImporter));

    assert.deepEqual(yield* startV2, ["thread-a"]);

    const v1 = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      v1.exec(`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project-b', 'Project B', '/tmp/project-b', '[]', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
        INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES ('thread-b', 'project-b', 'Newer V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');`);
    } finally {
      v1.close();
    }

    assert.deepEqual(yield* startV2, ["thread-a", "thread-b"]);
    assert.deepEqual(yield* startV2, ["thread-a", "thread-b"]);
    assert.equal(
      NodeFS.readdirSync(directory).filter(
        (name) =>
          name.startsWith("statev2.sqlite.stale-") &&
          !name.endsWith("-wal") &&
          !name.endsWith("-shm"),
      ).length,
      1,
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("keeps a V2 store with V2 work even when V1 gained threads after the copy", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-diverged-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project-a', 'Project A', '/tmp/project-a', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

  return Effect.gen(function* () {
    yield* seed;
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    // Stands in for V2 work by cloning a migration event under a non-migration id.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TABLE native_event AS
        SELECT * FROM orchestration_events WHERE application_event_version = 2 LIMIT 1`;
      yield* sql`UPDATE native_event
        SET sequence = NULL, event_id = 'native-event', stream_version = stream_version + 1000`;
      yield* sql`INSERT INTO orchestration_events SELECT * FROM native_event`;
    }).pipe(Effect.provide(layerDatabase));

    const v1 = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      v1.exec(`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES ('thread-b', 'project-a', 'Newer V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');`);
    } finally {
      v1.close();
    }

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(
        yield* sql`SELECT 1 FROM orchestration_events WHERE event_id = 'native-event'`,
        1,
      );
      assert.lengthOf(yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = 'thread-b'`, 0);
    }).pipe(Effect.provide(layerDatabase));
    assert.isFalse(NodeFS.readdirSync(directory).some((name) => name.includes(".stale-")));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(layerDatabase));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(layerDatabase));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
