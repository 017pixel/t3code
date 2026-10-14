import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";

import { baseDirFlag } from "./config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";

const compactCommand = Command.make("compact", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Remove superseded history and reclaim disk space. Stop the server first.",
  ),
  Command.withHandler(({ baseDir }) =>
    Effect.gen(function* () {
      const home = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const directory = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(baseDir, () => home)),
      );
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const result = yield* maintenance.compact(directory);
      yield* Console.log(
        `Removed ${result.deletedEventCount} events and ${result.deletedReceiptCount} receipts. Database: ${result.beforeBytes} → ${result.afterBytes} bytes.`,
      );
    }).pipe(Effect.provide(DatabaseMaintenance.layer)),
  ),
);

export const databaseCommand = Command.make("database").pipe(
  Command.withDescription("Maintain the local T3 Code database."),
  Command.withSubcommands([compactCommand]),
);
