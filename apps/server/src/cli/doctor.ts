import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { baseDirFlag } from "./config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";

export const runDoctor = Effect.fn("runDoctor")(function* (
  directory: string,
  options: { readonly fix: boolean; readonly dryRun: boolean },
) {
  const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
  const status = yield* maintenance.inspect(directory);
  yield* Console.log(
    `Database: ${status.databaseBytes} bytes; reusable space: ${status.reclaimableBytes} bytes.`,
  );
  yield* Console.log(
    `Automatic disk shrinking: ${status.incrementalVacuumEnabled ? "enabled" : "not enabled"}.`,
  );

  if (status.incrementalVacuumEnabled && status.reclaimableBytes === 0) {
    yield* Console.log("No database repairs needed.");
    return;
  }
  yield* Console.log(
    "Database repair: remove superseded history, reclaim unused disk space, and enable automatic disk shrinking.",
  );
  yield* Console.log(
    "Doctor pauses and restarts the matching background service automatically. Repair may take several minutes and needs temporary disk space.",
  );
  if (options.dryRun || !options.fix) {
    yield* Console.log(
      options.dryRun
        ? "Dry run: no changes made."
        : "Run t3 doctor --fix with the same --base-dir to apply this repair.",
    );
    return;
  }
  const service = yield* BootService.BootService;
  const result = yield* service.withStopped(maintenance.compact(directory));
  yield* Console.log(
    `Removed ${result.deletedEventCount} events and ${result.deletedReceiptCount} receipts. Database: ${result.beforeBytes} → ${result.afterBytes} bytes.`,
  );
});

export const doctorCommand = Command.make("doctor", {
  baseDir: baseDirFlag,
  fix: Flag.Boolean("fix").pipe(
    Flag.withDescription(
      "Apply the recommended repair, pausing and restarting the background service automatically.",
    ),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show planned repairs without changing anything, even with --fix."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Inspect T3 Code and show available repairs. Read-only unless --fix is supplied.",
  ),
  Command.withHandler(({ baseDir, fix, dryRun }) =>
    Effect.gen(function* () {
      const home = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const directory = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(baseDir, () => home)),
      );
      const path = yield* Path.Path;
      yield* runDoctor(directory, { fix, dryRun }).pipe(
        Effect.provide(
          BootService.layer({
            baseDir: directory,
            logsDir: path.join(directory, "userdata", "logs"),
            cliVersion: packageJson.version,
          }).pipe(Layer.provide(ProcessRunner.layer), Layer.provide(FetchHttpClient.layer)),
        ),
      );
    }).pipe(Effect.provide(DatabaseMaintenance.layer)),
  ),
);
