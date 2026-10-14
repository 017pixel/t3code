import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as EventCompaction from "./EventCompaction.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";

it.effect("defers compaction until after startup and repeats it without overlapping", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const compactEventStore = Effect.gen(function* () {
        calls += 1;
        yield* Deferred.succeed(calls === 1 ? first : second, undefined);
        return { deletedEventCount: 0, deletedReceiptCount: 0, reclaimableBytes: 0 };
      });
      yield* Layer.build(
        EventCompaction.layer.pipe(
          Layer.provide(Layer.mock(DatabaseStorage.DatabaseStorage)({ reclaim: Effect.void })),
          Layer.provide(
            Layer.mock(ProjectionMaintenance.ProjectionMaintenanceV2)({ compactEventStore }),
          ),
        ),
      );
      assert.equal(calls, 0);
      yield* TestClock.adjust("59 seconds");
      assert.equal(calls, 0);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(first);
      assert.equal(calls, 1);
      yield* TestClock.adjust("6 hours");
      yield* Deferred.await(second);
      assert.equal(calls, 2);
    }),
  ),
);

it.effect("reclaims space after startup and every minute", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const reclaim = Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(calls === 1 ? first : second, undefined);
      });
      yield* Layer.build(
        EventCompaction.layer.pipe(
          Layer.provide(Layer.mock(DatabaseStorage.DatabaseStorage)({ reclaim })),
          Layer.provide(
            Layer.mock(ProjectionMaintenance.ProjectionMaintenanceV2)({
              compactEventStore: Effect.succeed({
                deletedEventCount: 0,
                deletedReceiptCount: 0,
                reclaimableBytes: 0,
              }),
            }),
          ),
        ),
      );
      yield* TestClock.adjust("59 seconds");
      assert.equal(calls, 0);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(first);
      assert.equal(calls, 1);
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(second);
      assert.equal(calls, 2);
    }),
  ),
);
