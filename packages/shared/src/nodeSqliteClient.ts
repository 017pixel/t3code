/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const DEFAULT_READ_CONCURRENCY = 4;

const LEADING_SQL_COMMENT_OR_WHITESPACE = /^(?:\s+|\/\*[\s\S]*?\*\/|--[^\r\n]*(?:\r?\n|$))*/;
const READ_ONLY_SELECT_START = /^select\b/i;
const JOURNAL_MODE_PRAGMA_RE = /\bpragma\s+(?:main\.)?journal_mode\b/i;
const BUSY_TIMEOUT_PRAGMA_RE = /\bpragma\s+busy_timeout\b/i;
const CONNECTION_LOCAL_SCHEMA_RE = /\b(?:create\s+temp(?:orary)?\b|attach\s+)/i;

const isStandaloneReadOnlySql = (sql: string): boolean => {
  const stripped = sql.replace(LEADING_SQL_COMMENT_OR_WHITESPACE, "");
  return READ_ONLY_SELECT_START.test(stripped);
};

const ReadTransactionMode = Context.Reference<boolean>(
  "@t3tools/shared/NodeSqliteClient/ReadTransactionMode",
  { defaultValue: () => false },
);

export const TypeId = "~@t3tools/shared/NodeSqliteClient";
export type TypeId = typeof TypeId;

export interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId;
  /**
   * Run a read-only point-in-time snapshot transaction (`BEGIN` deferred)
   * on a read-only connection when the database is file-backed in WAL mode,
   * or as a nested savepoint when already inside an active transaction.
   */
  readonly withReadTransaction: <R, E, A>(
    self: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

export const isSqliteClient = (u: unknown): u is SqliteClient =>
  Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId;

/**
 * Execute an effect inside a read-only SQLite snapshot transaction.
 *
 * When the database is in WAL mode and the current fiber is not already inside
 * a transaction, this acquires a read-only connection from the reader pool and
 * starts a deferred `BEGIN` transaction instead of taking the writer semaphore
 * or issuing `BEGIN IMMEDIATE`. When called inside an existing read or write
 * transaction on the same client, it reuses the active transaction connection
 * via a `SAVEPOINT` so uncommitted writes remain visible.
 */
export function withReadTransaction(
  sql: Client.SqlClient,
): <R, E, A>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
export function withReadTransaction<R, E, A>(
  sql: Client.SqlClient,
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R>;
export function withReadTransaction<R, E, A>(sql: Client.SqlClient, self?: Effect.Effect<A, E, R>) {
  const run = <R2, E2, A2>(
    effect: Effect.Effect<A2, E2, R2>,
  ): Effect.Effect<A2, E2 | SqlError, R2> =>
    isSqliteClient(sql) ? sql.withReadTransaction(effect) : sql.withTransaction(effect);
  return self === undefined ? run : run(self);
}

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly readConcurrency?: number | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

interface InternalConnection extends Connection {
  readonly db: NodeSqlite.DatabaseSync;
  readonly isTransaction: () => boolean;
  readonly execPragma: (sql: string) => Effect.Effect<void, SqlError>;
}

interface ReaderSlot {
  inUse: boolean;
  connection: InternalConnection | undefined;
  appliedBusyTimeoutMs: number | undefined;
}

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<SqliteClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const clientScope = yield* Effect.scope;
  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;
  const spanAttributes: ReadonlyArray<readonly [string, unknown]> = [
    ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
    [ATTR_DB_SYSTEM_NAME, "sqlite"],
  ];

  let isFileBacked = false;
  let walMode: boolean | undefined = false;
  let writerBusyTimeoutMs: number | undefined;
  let hasConnectionLocalSchema = false;
  let writerReadOnlyTransaction = false;

  const makeConnection = (readOnly: boolean) =>
    Effect.gen(function* () {
      const db = yield* Effect.try({
        try: () =>
          new NodeSqlite.DatabaseSync(options.filename, {
            readOnly,
            allowExtension: readOnly ? false : (options.allowExtension ?? false),
          }),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to open database", "open"),
          }),
      });
      yield* Scope.addFinalizer(
        clientScope,
        Effect.try({
          try: () => db.close(),
          catch: (cause) =>
            new SqlError({
              reason: classifyError(cause, "Failed to close database", "close"),
            }),
        }).pipe(Effect.orDie),
      );

      const onWriterSql = !readOnly
        ? (sql: string) => {
            if (JOURNAL_MODE_PRAGMA_RE.test(sql)) {
              walMode = isFileBacked ? undefined : false;
            }
            if (BUSY_TIMEOUT_PRAGMA_RE.test(sql)) {
              writerBusyTimeoutMs = undefined;
            }
            if (CONNECTION_LOCAL_SCHEMA_RE.test(sql)) {
              hasConnectionLocalSchema = true;
            }
          }
        : undefined;

      const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
      const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
        const cached = statementReaderCache.get(statement);
        if (cached !== undefined) {
          return cached;
        }
        const value = statement.columns().length > 0;
        statementReaderCache.set(statement, value);
        return value;
      };

      const prepare = (sql: string) =>
        Effect.try({
          try: () => db.prepare(sql),
          catch: (cause) =>
            new SqlError({
              reason: classifyError(cause, "Failed to prepare statement", "prepare"),
            }),
        });

      const prepareCache = yield* Cache.makeWith(prepare, {
        capacity: options.prepareCacheSize ?? 200,
        // A transient prepare failure must not outlive the lock or missing schema.
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
      });

      const runStatement = (
        statement: NodeSqlite.StatementSync,
        params: ReadonlyArray<unknown>,
        raw: boolean,
        sql: string,
      ) =>
        Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
          try {
            statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
            if (hasRows(statement)) {
              const rows = statement.all(...(params as any));
              onWriterSql?.(sql);
              return Effect.succeed(rows);
            }
            const result = statement.run(...(params as any));
            onWriterSql?.(sql);
            return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
          } catch (cause) {
            return Effect.fail(
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
            );
          }
        });

      const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
        Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw, sql));

      const runStatementValues = (
        statement: NodeSqlite.StatementSync,
        params: ReadonlyArray<unknown>,
        sql: string,
      ) =>
        Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
          try {
            statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
            if (hasRows(statement)) {
              statement.setReturnArrays(true);
              try {
                const rows = statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
                onWriterSql?.(sql);
                return Effect.succeed(rows);
              } finally {
                statement.setReturnArrays(false);
              }
            }
            statement.run(...(params as any));
            onWriterSql?.(sql);
            return Effect.succeed([]);
          } catch (cause) {
            return Effect.fail(
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
            );
          }
        });

      const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
        Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
          runStatementValues(statement, params, sql),
        );

      const execPragma = (sql: string) =>
        Effect.try({
          try: () => {
            db.exec(sql);
          },
          catch: (cause) =>
            new SqlError({
              reason: classifyError(cause, "Failed to execute pragma", "execute"),
            }),
        });

      return identity<InternalConnection>({
        db,
        isTransaction: () => db.isTransaction,
        execPragma,
        execute(sql, params, rowTransform) {
          return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
        },
        executeRaw(sql, params) {
          return run(sql, params, true);
        },
        executeValues(sql, params) {
          return runValues(sql, params);
        },
        executeValuesUnprepared(sql, params) {
          return Effect.flatMap(prepare(sql), (statement) =>
            runStatementValues(statement, params ?? [], sql),
          );
        },
        executeUnprepared(sql, params, rowTransform) {
          const effectiveSql =
            sql === "BEGIN IMMEDIATE" && (readOnly || writerReadOnlyTransaction) ? "BEGIN" : sql;
          const effect = prepare(effectiveSql).pipe(
            Effect.flatMap((statement) =>
              runStatement(statement, params ?? [], false, effectiveSql),
            ),
          );
          return rowTransform ? Effect.map(effect, rowTransform) : effect;
        },
        executeStream(_sql, _params) {
          return Stream.die(new UnsupportedNodeSqliteOperationError());
        },
      });
    });

  const writerSemaphore = yield* Semaphore.make(1);
  const writerConnection = yield* makeConnection(options.readonly ?? false);
  isFileBacked = writerConnection.db.location() !== null;
  walMode = isFileBacked ? undefined : false;

  const maxReaders =
    options.readonly === true || !isFileBacked
      ? 0
      : Math.max(0, Math.floor(options.readConcurrency ?? DEFAULT_READ_CONCURRENCY));

  const readerPoolSemaphore = yield* Semaphore.make(Math.max(1, maxReaders));
  const readerSlots: ReadonlyArray<ReaderSlot> = Array.from({ length: maxReaders }, () => ({
    inUse: false,
    connection: undefined,
    appliedBusyTimeoutMs: undefined,
  }));

  const isWalMode = (): boolean => {
    if (maxReaders === 0 || hasConnectionLocalSchema) {
      return false;
    }
    if (walMode !== undefined) {
      return walMode;
    }
    try {
      const rows = writerConnection.db.prepare("PRAGMA journal_mode").all() as ReadonlyArray<{
        readonly journal_mode?: string;
      }>;
      const mode = rows[0]?.journal_mode?.toLowerCase();
      if (mode !== undefined) {
        walMode = mode === "wal";
        return walMode;
      }
    } catch {
      // An exclusive lock held by another connection can temporarily block reading journal_mode.
    }
    return false;
  };

  const getWriterBusyTimeoutMs = (): number | undefined => {
    if (writerBusyTimeoutMs !== undefined) {
      return writerBusyTimeoutMs;
    }
    try {
      const rows = writerConnection.db.prepare("PRAGMA busy_timeout").all() as ReadonlyArray<{
        readonly timeout?: number;
      }>;
      const timeout = rows[0]?.timeout;
      if (typeof timeout === "number") {
        writerBusyTimeoutMs = timeout;
        return timeout;
      }
    } catch {
      // Ignore if busy_timeout cannot be read.
    }
    return undefined;
  };

  const syncReaderSlot = Effect.fnUntraced(function* (slot: ReaderSlot) {
    if (slot.connection === undefined) {
      const conn = yield* makeConnection(true);
      yield* conn.execPragma("PRAGMA query_only = ON");
      slot.connection = conn;
    }
    const conn = slot.connection;
    const targetTimeout = getWriterBusyTimeoutMs();
    if (targetTimeout !== undefined && slot.appliedBusyTimeoutMs !== targetTimeout) {
      yield* conn.execPragma(`PRAGMA busy_timeout = ${targetTimeout}`);
      slot.appliedBusyTimeoutMs = targetTimeout;
    }
    return conn;
  });

  const rollbackIfOpen = (conn: InternalConnection) =>
    Effect.sync(() => {
      if (conn.isTransaction()) {
        try {
          conn.db.exec("ROLLBACK");
        } catch {
          // Best-effort cleanup if transaction remained open.
        }
      }
    });

  const borrowWriter = <A, E, R>(
    f: (connection: InternalConnection) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => writerSemaphore.withPermits(1)(f(writerConnection));

  const borrowReader = <A, E, R>(
    f: (connection: InternalConnection) => Effect.Effect<A, E | SqlError, R>,
  ): Effect.Effect<A, E | SqlError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(readerPoolSemaphore.take(1)), () => {
        const slot =
          readerSlots.find((candidate) => !candidate.inUse && candidate.connection !== undefined) ??
          readerSlots.find((candidate) => !candidate.inUse)!;
        slot.inUse = true;
        return restore(Effect.flatMap(syncReaderSlot(slot), f)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              slot.inUse = false;
            }).pipe(Effect.andThen(readerPoolSemaphore.release(1))),
          ),
        );
      }),
    );

  const canRouteStandaloneReadToPool = (sql: string): boolean =>
    isWalMode() && isStandaloneReadOnlySql(sql);

  const dispatchConnection = identity<Connection>({
    execute(sql, params, rowTransform) {
      return canRouteStandaloneReadToPool(sql)
        ? borrowReader((conn) => conn.execute(sql, params, rowTransform))
        : borrowWriter((conn) => conn.execute(sql, params, rowTransform));
    },
    executeRaw(sql, params) {
      return canRouteStandaloneReadToPool(sql)
        ? borrowReader((conn) => conn.executeRaw(sql, params))
        : borrowWriter((conn) => conn.executeRaw(sql, params));
    },
    executeValues(sql, params) {
      return canRouteStandaloneReadToPool(sql)
        ? borrowReader((conn) => conn.executeValues(sql, params))
        : borrowWriter((conn) => conn.executeValues(sql, params));
    },
    executeValuesUnprepared(sql, params) {
      return canRouteStandaloneReadToPool(sql)
        ? borrowReader((conn) => conn.executeValuesUnprepared(sql, params))
        : borrowWriter((conn) => conn.executeValuesUnprepared(sql, params));
    },
    executeUnprepared(sql, params, rowTransform) {
      return canRouteStandaloneReadToPool(sql)
        ? borrowReader((conn) => conn.executeUnprepared(sql, params, rowTransform))
        : borrowWriter((conn) => conn.executeUnprepared(sql, params, rowTransform));
    },
    executeStream(sql, params, rowTransform) {
      return writerConnection.executeStream(sql, params, rowTransform);
    },
  });

  const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const isReadTx = yield* ReadTransactionMode;

      if (isReadTx && isWalMode()) {
        yield* restore(readerPoolSemaphore.take(1));
        const slot =
          readerSlots.find((candidate) => !candidate.inUse && candidate.connection !== undefined) ??
          readerSlots.find((candidate) => !candidate.inUse)!;
        slot.inUse = true;
        yield* Scope.addFinalizer(
          scope,
          Effect.suspend(() => {
            const cleanup = slot.connection ? rollbackIfOpen(slot.connection) : Effect.void;
            return Effect.ensuring(
              cleanup,
              Effect.sync(() => {
                slot.inUse = false;
              }).pipe(Effect.andThen(readerPoolSemaphore.release(1))),
            );
          }),
        );
        return yield* restore(syncReaderSlot(slot));
      }

      yield* restore(writerSemaphore.take(1));
      const setQueryOnly = isReadTx && options.readonly !== true;
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() =>
          rollbackIfOpen(writerConnection).pipe(
            Effect.andThen(
              setQueryOnly
                ? Effect.sync(() => {
                    writerReadOnlyTransaction = false;
                    try {
                      writerConnection.db.exec("PRAGMA query_only = OFF");
                    } catch {
                      // Best-effort reset on close/error.
                    }
                  })
                : Effect.void,
            ),
            Effect.ensuring(writerSemaphore.release(1)),
          ),
        ),
      );
      if (setQueryOnly) {
        writerReadOnlyTransaction = true;
        yield* writerConnection.execPragma("PRAGMA query_only = ON");
      }
      return writerConnection;
    }),
  );

  const baseClient = yield* Client.make({
    acquirer: Effect.succeed(dispatchConnection),
    borrower: (f) => f(dispatchConnection),
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
    spanAttributes,
    transformRows,
  });

  const clientWithReadTransaction = <R, E, A>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError, R> =>
    Effect.provideService(
      baseClient.withTransaction(Effect.provideService(effect, ReadTransactionMode, false)),
      ReadTransactionMode,
      true,
    );

  return Object.assign(baseClient, {
    [TypeId]: TypeId as TypeId,
    withReadTransaction: clientWithReadTransaction,
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
