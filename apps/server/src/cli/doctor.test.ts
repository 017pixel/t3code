import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

it.effect.each([
  { fix: false, dryRun: false },
  { fix: false, dryRun: true },
  { fix: true, dryRun: true },
  { fix: true, dryRun: false },
])("only applies repairs with --fix and without --dry-run: %j", (options) =>
  Effect.gen(function* () {
    let repairs = 0;
    let servicePauses = 0;
    yield* runDoctor("/test", options).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BootService.BootService)({
            withStopped: (operation) =>
              Effect.suspend(() => {
                servicePauses++;
                return operation;
              }),
          }),
          Layer.succeed(DatabaseMaintenance, {
            inspect: () =>
              Effect.succeed({
                databaseBytes: 2000,
                reclaimableBytes: 1000,
                incrementalVacuumEnabled: false,
                serverRunning: false,
              }),
            compact: () =>
              Effect.sync(() => {
                repairs++;
                return {
                  beforeBytes: 2000,
                  afterBytes: 1000,
                  deletedEventCount: 1,
                  deletedReceiptCount: 0,
                };
              }),
          }),
        ),
      ),
    );
    assert.equal(repairs, options.fix && !options.dryRun ? 1 : 0);
    assert.equal(servicePauses, repairs);
  }),
);
