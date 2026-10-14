import * as HostProcess from "@t3tools/shared/HostProcess";
import type { DatabaseStorageStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    readonly status: Stream.Stream<DatabaseStorageStatus | null>;
    readonly reclaim: Effect.Effect<void>;
  }
>()("t3/persistence/DatabaseStorage") {}

export const layer = Layer.effect(
  DatabaseStorage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const platform = yield* HostProcess.Platform;
    const quotedHome = `'${config.baseDir.replaceAll("'", platform === "win32" ? "''" : "'\\''")}'`;
    const status = Effect.gen(function* () {
      const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
      const pageSize = size[0]?.page_size ?? 0;
      return {
        databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
        reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
        incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
        compactCommand: `t3 doctor --base-dir ${quotedHome}`,
      } satisfies DatabaseStorageStatus;
    });
    const reclaim = Effect.gen(function* () {
      const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
      if (mode[0]?.auto_vacuum !== 2) return;
      // The SQLite driver steps statements without result columns once. Request one
      // page per step, yielding between pages so client requests can run.
      for (let batch = 0; batch < 1024; batch++) {
        const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        if ((free[0]?.freelist_count ?? 0) === 0) break;
        yield* sql`PRAGMA incremental_vacuum(1)`;
        yield* Effect.yieldNow;
      }
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
    );
    return DatabaseStorage.of({
      status: Stream.fromEffectSchedule(
        status.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Database storage inspection failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
        Schedule.spaced("30 seconds"),
      ),
      reclaim,
    });
  }),
);
