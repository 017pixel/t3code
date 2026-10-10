import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { resolveBaseDir } from "../os-jank.ts";
import * as DatabaseCompaction from "../persistence/DatabaseCompaction.ts";
import { baseDirFlag } from "./config.ts";

const compactCommand = Command.make("compact", { baseDir: baseDirFlag }, ({ baseDir }) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = yield* resolveBaseDir(Option.getOrUndefined(baseDir));
    const database = yield* DatabaseCompaction.DatabaseCompaction;
    const console = yield* Console.Console;
    const result = yield* database.compact({
      databasePath: path.join(home, "userdata", "statev2.sqlite"),
      onProgress: (message) => console.log(message),
    });
    yield* Console.log(
      `Verified ${result.verifiedTables.length} projection tables; rewrote ${result.rewrittenEvents} events and pruned ${result.prunedReceipts} imported legacy receipts.`,
    );
  }).pipe(Effect.provide(DatabaseCompaction.layer)),
).pipe(
  Command.withDescription(
    "Back up, verify and compact a stopped server's database. Never runs automatically.",
  ),
);

export const dbCommand = Command.make("db").pipe(Command.withSubcommands([compactCommand]));
