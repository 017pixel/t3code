import * as NodeServices from "@effect/platform-node/NodeServices";
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
          NodeServices.layer,
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

it.effect.each([true, false])("runs only the user's selected repairs: %s", (selected) =>
  Effect.gen(function* () {
    let repairs = 0;
    let choices = 0;
    yield* runDoctor("/test", { fix: false, dryRun: false, interactive: true }, (available) => {
      choices++;
      assert.isTrue(available[0]?.recommended);
      return Effect.succeed(selected ? ["database"] : []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(BootService.BootService)({ withStopped: (operation) => operation }),
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
    assert.equal(choices, 1);
    assert.equal(repairs, selected ? 1 : 0);
  }),
);

it.effect("dry-run never opens the repair picker or stops a service", () =>
  runDoctor("/test", { fix: true, dryRun: true, interactive: true }, () =>
    Effect.die("picker must not run"),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(DatabaseMaintenance, {
          inspect: () =>
            Effect.succeed({
              databaseBytes: 2000,
              reclaimableBytes: 1000,
              incrementalVacuumEnabled: false,
              serverRunning: false,
            }),
          compact: () => Effect.die("repair must not run"),
        }),
        Layer.mock(BootService.BootService)({
          withStopped: () => Effect.die("service must not stop"),
        }),
      ),
    ),
  ),
);
