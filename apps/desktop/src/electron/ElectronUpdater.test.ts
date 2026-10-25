import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as NodeEvents from "node:events";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    channel: "latest",
    events: undefined as unknown as NodeEvents.EventEmitter,
    quitAndInstall: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: new Proxy(autoUpdaterMock, {
    // electron-updater's autoUpdater is an EventEmitter; forward emitter methods.
    get: (target, property) => {
      if (property in target) return target[property as keyof typeof target];
      const value = Reflect.get(target.events, property);
      return typeof value === "function" ? value.bind(target.events) : value;
    },
  }),
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater.quitAndInstall", () => {
  beforeEach(() => {
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.events = new NodeEvents.EventEmitter();
    autoUpdaterMock.quitAndInstall.mockReset();
  });

  it.effect("fails with the error electron-updater emits instead of throwing", () =>
    Effect.gen(function* () {
      const cause = new Error("No update filepath provided, can't quit and install");
      // electron-updater reports most install failures by emitting `error` and returning.
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        autoUpdaterMock.events.emit("error", cause);
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;

      const result = yield* Effect.scoped(
        updater
          .on("error", () => {})
          .pipe(
            Effect.andThen(updater.quitAndInstall({ isSilent: true, isForceRunAfter: true })),
            Effect.result,
          ),
      );

      assert.isTrue(Result.isFailure(result), "quitAndInstall should fail");
      const error = Result.getFailure(result).pipe(Option.getOrThrow);
      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.channel, "latest");
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, true]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("succeeds without an emitted error and keeps later errors on listeners", () =>
    Effect.gen(function* () {
      const later = new Error("background check failed");
      const errorListener = vi.fn();
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* updater.on("error", errorListener);
          yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });

          autoUpdaterMock.events.emit("error", later);
          assert.deepEqual(errorListener.mock.calls, [[later]]);
        }),
      );

      assert.equal(autoUpdaterMock.events.listenerCount("error"), 0);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
