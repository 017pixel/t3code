import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    runMainContentsCommand: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

describe("DesktopLifecycle", () => {
  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "disarms quit installation before a settings relaunch on %s",
    (platform) =>
      Effect.gen(function* () {
        const exited = yield* Deferred.make<void>();
        const events: string[] = [];
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(new Map())),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(
            layerDesktopWindow({
              flushMainWindowBounds: Effect.sync(() => {
                events.push("flush");
              }),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform,
              isDevelopment: false,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
          Layer.provideMerge(
            Layer.mock(ElectronUpdater.ElectronUpdater)({
              setAutoInstallOnAppQuit: (value) =>
                Effect.sync(() => {
                  events.push(`autoInstall:${value}`);
                }),
            }),
          ),
          Layer.provideMerge(DesktopShutdown.layer),
          Layer.provideMerge(DesktopState.layer),
        );
        yield* Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const app = yield* ElectronApp.ElectronApp;
          const shutdown = yield* DesktopShutdown.DesktopShutdown;
          yield* lifecycle.relaunch("settings").pipe(
            Effect.provideService(ElectronApp.ElectronApp, {
              ...app,
              relaunch: () =>
                Effect.sync(() => {
                  events.push("relaunch");
                }),
              exit: (code) =>
                Effect.sync(() => {
                  events.push(`exit:${code}`);
                }).pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid),
            }),
          );
          yield* shutdown.awaitRequest;
          assert.deepEqual(events, ["flush"]);
          yield* shutdown.markComplete;
          yield* Deferred.await(exited);
          assert.deepEqual(events, ["flush", "autoInstall:false", "relaunch", "exit:0"]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["quit", "SIGTERM"] as const)(
    "blocks repeated quit events during %s staging",
    (trigger) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const stagingStarted = yield* Deferred.make<void>();
        const finishStaging = yield* Deferred.make<void>();
        const quitFinished = yield* Deferred.make<void>();
        let installs = 0;
        const attemptQuit = () => {
          let prevented = false;
          appListeners.get("before-quit")?.({
            preventDefault: () => {
              prevented = true;
            },
          });
          return prevented;
        };
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(
            layerElectronApp(
              appListeners,
              Effect.sync(() => {
                assert.isFalse(attemptQuit());
              }).pipe(Effect.andThen(Deferred.succeed(quitFinished, undefined)), Effect.asVoid),
            ),
          ),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(layerElectronWindow()),
          Layer.provideMerge(layerDesktopWindow()),
          Layer.provideMerge(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform: "darwin",
              isDevelopment: false,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
          Layer.provideMerge(
            Layer.succeed(DesktopShutdown.DesktopShutdown, {
              request: Effect.void,
              awaitRequest: Effect.void,
              markComplete: Effect.void,
              awaitComplete: Effect.void,
              isComplete: Effect.succeed(true),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(DesktopUpdates.DesktopUpdates, {
              installOnQuit: Effect.sync(() => {
                installs++;
              }).pipe(
                Effect.andThen(Deferred.succeed(stagingStarted, undefined)),
                Effect.andThen(Deferred.await(finishStaging)),
                // MacUpdater calls app.quit synchronously from its native event.
                Effect.tap(() => Effect.sync(() => assert.isTrue(attemptQuit()))),
                Effect.as(true),
              ),
            } as DesktopUpdates.DesktopUpdates["Service"]),
          ),
          Layer.provideMerge(DesktopState.layer),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            const previousSignals = process.listeners("SIGTERM");
            yield* lifecycle.register;
            if (trigger === "quit") assert.isTrue(attemptQuit());
            else
              process
                .listeners("SIGTERM")
                .find((listener) => !previousSignals.includes(listener))?.("SIGTERM");
            yield* Deferred.await(stagingStarted);
            assert.isTrue(attemptQuit());
            yield* Deferred.succeed(finishStaging, undefined);
            yield* Deferred.await(quitFinished);
            assert.equal(installs, 1);
          }),
        ).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let windowsDestroyed = false;
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          Layer.succeed(DesktopUpdates.DesktopUpdates, {
            installOnQuit: Effect.succeed(false),
          } as DesktopUpdates.DesktopUpdates["Service"]),
        ),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              windowsDestroyed = true;
            }),
          ),
        ),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([false, true])(
    "destroys windows before waiting for backend shutdown (install: %s)",
    (installOnQuit) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const shutdownRequested = yield* Deferred.make<void>();
        const allowShutdown = yield* Deferred.make<void>();
        const quitRequested = yield* Deferred.make<void>();
        const events: string[] = [];

        const quit = Effect.sync(() => {
          events.push("quit");
        }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
        const destroyAll = Effect.sync(() => {
          events.push("destroy");
        });
        const flushMainWindowBounds = Effect.sync(() => {
          events.push("flush");
        });

        const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
          request: Effect.sync(() => {
            events.push("request");
          }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
          awaitRequest: Deferred.await(shutdownRequested),
          markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
          awaitComplete: Deferred.await(allowShutdown),
          isComplete: Deferred.isDone(allowShutdown),
        });

        const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]);

        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(layerElectronApp(appListeners, quit)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(
            Layer.succeed(DesktopUpdates.DesktopUpdates, {
              installOnQuit: Effect.sync(() => {
                events.push("installOnQuit");
                return installOnQuit;
              }),
            } as DesktopUpdates.DesktopUpdates["Service"]),
          ),
          Layer.provideMerge(layerElectronWindow(destroyAll)),
          Layer.provideMerge(layerDesktopWindow({ flushMainWindowBounds })),
          Layer.provideMerge(layerEnvironment),
          Layer.provideMerge(layerDesktopShutdown),
          Layer.provideMerge(DesktopState.layer),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            yield* lifecycle.register;

            const event = { preventDefault: () => undefined } as Electron.Event;
            appListeners.get("before-quit")?.(event);

            appListeners.get("before-quit")?.(event);
            yield* Deferred.await(shutdownRequested);
            const eventsBeforeCleanup = [...events];
            yield* Deferred.succeed(allowShutdown, undefined);
            yield* Deferred.await(quitRequested);

            assert.deepEqual(eventsBeforeCleanup, ["flush", "destroy", "request"]);
            assert.deepEqual(events, ["flush", "destroy", "request", "installOnQuit", "quit"]);
          }),
        ).pipe(Effect.provide(layer));
      }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          Layer.succeed(DesktopUpdates.DesktopUpdates, {
            installOnQuit: Effect.succeed(false),
          } as DesktopUpdates.DesktopUpdates["Service"]),
        ),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow({ activate })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
