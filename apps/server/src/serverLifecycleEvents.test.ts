import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";

it.effect(
  "publishes lifecycle events without subscribers and snapshots the latest welcome/ready",
  () =>
    Effect.gen(function* () {
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const environment = {
        environmentId: EnvironmentId.make("environment-test"),
        label: "Test environment",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      };

      const welcome = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "welcome",
          payload: {
            environment,
            cwd: "/tmp/project",
            projectName: "project",
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(welcome));
      assert.equal(welcome.value.sequence, 1);

      const ready = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "ready",
          payload: {
            at: "2026-01-01T00:00:00.000Z",
            environment,
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(ready));
      assert.equal(ready.value.sequence, 2);

      yield* lifecycleEvents.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: {
          status: "running",
          totalThreadCount: 12,
        },
      });
      yield* lifecycleEvents.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: {
          status: "complete",
          totalThreadCount: 12,
        },
      });

      const snapshot = yield* lifecycleEvents.snapshot;
      assert.equal(snapshot.sequence, 4);
      assert.deepEqual(snapshot.events.map((event) => event.type).toSorted(), [
        "legacyThreadMigration",
        "ready",
        "welcome",
      ]);
      const migration = snapshot.events.find((event) => event.type === "legacyThreadMigration");
      assert.equal(migration?.payload.status, "complete");
    }).pipe(Effect.provide(ServerLifecycleEvents.layer)),
);

it.effect("announces restarts only to capable clients and expires abandoned handoffs", () =>
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    yield* lifecycle.publish({
      version: 1,
      type: "updateRestart",
      payload: {
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        updateId: "background",
        expiresAt: 300_000,
      },
    });
    const events = Stream.fromIterable((yield* lifecycle.snapshot).events);
    yield* TestClock.adjust("1 minute");
    const capable = yield* ServerLifecycleEvents.eventsForClient(events, {
      updateRestarts: true,
    }).pipe(Stream.runCollect);
    assert.equal(capable.length, 1);
    assert.equal(
      capable[0]?.type === "updateRestart" ? capable[0].payload.expiresInMs : undefined,
      240_000,
    );
    assert.equal(
      (yield* ServerLifecycleEvents.eventsForClient(events, {}).pipe(Stream.runCollect)).length,
      0,
    );
    yield* TestClock.adjust("4 minutes");
    assert.equal((yield* lifecycle.snapshot).events.length, 0);
    assert.equal(
      (yield* ServerLifecycleEvents.eventsForClient(events, { updateRestarts: true }).pipe(
        Stream.runCollect,
      )).length,
      0,
    );
  }).pipe(Effect.provide(ServerLifecycleEvents.layer)),
);
