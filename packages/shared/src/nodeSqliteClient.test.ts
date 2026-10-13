import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );

  it.effect("enforces query_only inside withReadTransaction on in-memory databases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE readonly_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)`;
      yield* sql`INSERT INTO readonly_probe(id, value) VALUES (1, 'initial')`;

      const error = yield* SqliteClient.withReadTransaction(
        sql,
        sql`UPDATE readonly_probe SET value = 'mutated' WHERE id = 1`,
      ).pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");

      // After the read transaction closes, normal writes on the in-memory connection succeed.
      yield* sql`UPDATE readonly_probe SET value = 'updated' WHERE id = 1`;
      assert.deepEqual(yield* sql`SELECT value FROM readonly_probe WHERE id = 1`.values, [
        ["updated"],
      ]);
    }),
  );
});

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "allows withReadTransaction and standalone SELECT queries while another writer holds BEGIN IMMEDIATE",
  () =>
    Effect.gen(function* () {
      const { filename, other } = yield* makeTempDatabase;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 0`;

        yield* Effect.sync(() => {
          other.exec("BEGIN IMMEDIATE");
          other.exec("UPDATE counters SET value = 99 WHERE id = 1");
        });

        // Standalone SELECT and withReadTransaction read the committed WAL snapshot
        // on a read-only connection without contending on the write lock.
        assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[0]]);
        const snapshotValue = yield* SqliteClient.withReadTransaction(
          sql,
          Effect.gen(function* () {
            const first = yield* sql`SELECT value FROM counters WHERE id = 1`.values;
            const second = yield* sql`SELECT value FROM counters WHERE id = 1`.values;
            assert.deepEqual(first, second);
            return first;
          }),
        );
        assert.deepEqual(snapshotValue, [[0]]);

        yield* Effect.sync(() => other.exec("COMMIT"));
        assert.deepEqual(
          yield* SqliteClient.withReadTransaction(
            sql,
            sql`SELECT value FROM counters WHERE id = 1`.values,
          ),
          [[99]],
        );
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "runs concurrent read snapshots and queries without waiting on an in-flight write transaction",
  () =>
    Effect.gen(function* () {
      const { filename } = yield* makeTempDatabase;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const writerEntered = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const readerOneEntered = yield* Deferred.make<void>();
        const readerTwoEntered = yield* Deferred.make<void>();

        const writerFiber = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE counters SET value = 42 WHERE id = 1`;
              // Nested withReadTransaction inside an active write transaction reuses
              // the writer connection and sees uncommitted writes.
              const uncommitted = yield* SqliteClient.withReadTransaction(
                sql,
                sql`SELECT value FROM counters WHERE id = 1`.values,
              );
              assert.deepEqual(uncommitted, [[42]]);

              yield* Deferred.succeed(writerEntered, undefined);
              yield* Deferred.await(releaseWriter);
            }),
          ),
        );

        yield* Deferred.await(writerEntered);

        // Two concurrent read transactions can both enter and hold their WAL snapshots
        // simultaneously while the writer fiber is still holding the writer semaphore.
        const readerOne = yield* Effect.forkChild(
          SqliteClient.withReadTransaction(
            sql,
            Effect.gen(function* () {
              const before = yield* sql`SELECT value FROM counters WHERE id = 1`.values;
              yield* Deferred.succeed(readerOneEntered, undefined);
              yield* Deferred.await(readerTwoEntered);
              const after = yield* sql`SELECT value FROM counters WHERE id = 1`.values;
              return { before, after };
            }),
          ),
        );
        const readerTwo = yield* Effect.forkChild(
          SqliteClient.withReadTransaction(
            sql,
            Effect.gen(function* () {
              yield* Deferred.await(readerOneEntered);
              const rows = yield* sql`SELECT value FROM counters WHERE id = 1`.values;
              yield* Deferred.succeed(readerTwoEntered, undefined);
              return rows;
            }),
          ),
        );

        assert.deepEqual(yield* Fiber.join(readerOne), { before: [[0]], after: [[0]] });
        assert.deepEqual(yield* Fiber.join(readerTwo), [[0]]);
        assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[0]]);

        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Fiber.join(writerFiber);

        assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[42]]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename, readConcurrency: 2 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);
