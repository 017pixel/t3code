import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag, Prompt } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { createDoctorProgress, doctorEmphasis } from "./doctorProgress.ts";
import { baseDirFlag } from "./config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";

export interface DoctorRepair {
  readonly id: "database";
  readonly title: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly details: ReadonlyArray<string>;
}

export const chooseDoctorRepairs = (repairs: ReadonlyArray<DoctorRepair>) =>
  Prompt.run(
    Prompt.MultiSelect({
      message: "Choose repairs to run",
      selectAll: "Select all",
      selectNone: "Select none",
      inverseSelection: "Invert selection",
      choices: repairs.map((repair) => ({
        title: doctorEmphasis(repair.title) + (repair.recommended ? " · Recommended" : ""),
        value: repair.id,
        selected: repair.recommended,
      })),
    }),
  );

export const runDoctor = Effect.fn("runDoctor")(function* (
  directory: string,
  options: { readonly fix: boolean; readonly dryRun: boolean; readonly interactive?: boolean },
  chooseRepairs: typeof chooseDoctorRepairs = chooseDoctorRepairs,
) {
  const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
  const status = yield* maintenance.inspect(directory);
  const progress = createDoctorProgress();
  progress.intro(status.databaseBytes, status.reclaimableBytes);
  const repairs: ReadonlyArray<DoctorRepair> =
    status.incrementalVacuumEnabled && status.reclaimableBytes === 0
      ? []
      : [
          {
            id: "database",
            title: "Reclaim database space",
            description: "Frees unused database space and enables automatic shrinking.",
            details: [
              "Pauses the background service. May take several minutes.",
              "Requires temporary free disk space.",
            ],
            recommended: !status.incrementalVacuumEnabled || status.reclaimableBytes >= 1024 ** 3,
          },
        ];
  if (repairs.length === 0) {
    progress.note("Everything looks good. No repairs needed.");
    return;
  }
  progress.repairs(repairs);
  if (options.dryRun) {
    progress.note("Dry run complete. No changes made.");
    return;
  }
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.fix && !interactive) {
    progress.note("Run in a terminal to choose repairs, or use --fix for the recommended set.");
    return;
  }
  if (!options.fix) progress.note("↑/↓ Move   Space Select   Enter Run   Ctrl+C Cancel");
  const selected = options.fix
    ? repairs.filter((repair) => repair.recommended).map((repair) => repair.id)
    : yield* chooseRepairs(repairs).pipe(Effect.catchTags({ QuitError: () => Effect.succeed([]) }));
  if (selected.length === 0) {
    progress.note("No repairs selected. No changes made.");
    return;
  }
  const service = yield* BootService.BootService;
  progress.start();
  const report = (stage: Parameters<typeof progress.report>[0]) =>
    Effect.sync(() => progress.report(stage));
  const result = yield* service
    .withStopped(maintenance.compact(directory, report), report)
    .pipe(Effect.ensuring(Effect.sync(progress.finish)));
  progress.complete(result.beforeBytes, result.afterBytes);
});

export const doctorCommand = Command.make("doctor", {
  baseDir: baseDirFlag,
  fix: Flag.Boolean("fix").pipe(
    Flag.withDescription(
      "Apply recommended repairs without prompting, pausing and restarting the background service automatically.",
    ),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show planned repairs without changing anything, even with --fix."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Inspect T3 Code and choose repairs to run. Use --dry-run to inspect without prompting.",
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
