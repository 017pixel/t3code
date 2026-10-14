// @effect-diagnostics globalDate:off -- this native worker has no application runtime or clock service.
import type * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";

export interface SqliteWorkerOptions {
  readonly filename: string;
  readonly readonly: boolean;
  readonly allowExtension: boolean;
  readonly prepareCacheSize: number;
  readonly prepareCacheTTL: number;
}

export type SqliteWorkerCommand =
  | { readonly operation: "open"; readonly options: SqliteWorkerOptions }
  | { readonly operation: "close" }
  | {
      readonly operation: "execute";
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly mode: "rows" | "values" | "raw";
      readonly unprepared: boolean;
      readonly safeIntegers: boolean;
    };

export type SqliteWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly operation: "open" | "close" | "prepare" | "execute";
      readonly cause: {
        readonly message: string;
        readonly code: string | undefined;
        readonly errcode: number | undefined;
        readonly errstr: string | undefined;
      };
    };

// This function becomes an inline worker script, including in the single
// executable. Pass built-ins as arguments so bundling cannot introduce closures.
export function sqliteWorkerMain(
  { DatabaseSync }: typeof NodeSqlite,
  { parentPort }: typeof NodeWorkerThreads,
) {
  let options: SqliteWorkerOptions;
  const port = parentPort!;
  let database: NodeSqlite.DatabaseSync | undefined;
  const cache = new Map<string, { statement: NodeSqlite.StatementSync; expiresAt: number }>();
  const readers = new WeakMap<NodeSqlite.StatementSync, boolean>();

  port.on("message", (request: SqliteWorkerCommand & { readonly id: number }) => {
    let operation: "open" | "close" | "prepare" | "execute" = request.operation;
    try {
      if (request.operation === "open") {
        options = request.options;
        // A sequential lease reuses this worker for another database.
        cache.clear();
        database = new DatabaseSync(options.filename, {
          readOnly: options.readonly,
          allowExtension: options.allowExtension,
        });
        port.postMessage({
          id: request.id,
          ok: true,
          value: undefined,
        } satisfies SqliteWorkerResponse);
        return;
      }
      if (request.operation === "close") {
        database?.close();
        database = undefined;
        cache.clear();
        port.postMessage({
          id: request.id,
          ok: true,
          value: undefined,
        } satisfies SqliteWorkerResponse);
        return;
      }

      operation = "prepare";
      const now = Date.now();
      const cached = request.unprepared ? undefined : cache.get(request.sql);
      const statement =
        cached && cached.expiresAt > now ? cached.statement : database!.prepare(request.sql);
      if (!request.unprepared && options.prepareCacheSize > 0) {
        cache.delete(request.sql);
        cache.set(request.sql, {
          statement,
          expiresAt:
            cached?.statement === statement ? cached.expiresAt : now + options.prepareCacheTTL,
        });
        if (cache.size > options.prepareCacheSize) {
          cache.delete(cache.keys().next().value!);
        }
      }

      operation = "execute";
      statement.setReadBigInts(request.safeIntegers);
      // Cloned empty views can have a null backing pointer that node:sqlite
      // binds as SQL NULL. A local empty view preserves an empty BLOB.
      const params = request.params.map((value) =>
        ArrayBuffer.isView(value) && value.byteLength === 0 ? new Uint8Array() : value,
      ) as Array<NodeSqlite.SQLInputValue>;
      const hasRows = readers.get(statement) ?? statement.columns().length > 0;
      readers.set(statement, hasRows);
      let value: unknown;
      if (hasRows) {
        statement.setReturnArrays(request.mode === "values");
        try {
          value = statement.all(...params);
        } finally {
          statement.setReturnArrays(false);
        }
      } else {
        const result = statement.run(...params);
        value = request.mode === "raw" ? result : [];
      }
      port.postMessage({ id: request.id, ok: true, value } satisfies SqliteWorkerResponse);
    } catch (cause) {
      const error = cause as {
        message?: unknown;
        code?: unknown;
        errcode?: unknown;
        errstr?: unknown;
      };
      port.postMessage({
        id: request.id,
        ok: false,
        operation,
        cause: {
          message: typeof error?.message === "string" ? error.message : String(cause),
          code: typeof error?.code === "string" ? error.code : undefined,
          errcode: typeof error?.errcode === "number" ? error.errcode : undefined,
          errstr: typeof error?.errstr === "string" ? error.errstr : undefined,
        },
      } satisfies SqliteWorkerResponse);
    }
  });
}
