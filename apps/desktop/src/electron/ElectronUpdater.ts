import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { AppImageUpdater, autoUpdater } from "electron-updater";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { verifyAppImageInstalls } from "./AppImageInstall.ts";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const runSync = Effect.runSyncWith(context);
  const log = makeComponentLogger("desktop-updater");
  const bridge =
    (level: "logDebug" | "logInfo" | "logWarning" | "logError") =>
    (...args: Array<unknown>) => {
      const message = args.map(String).join(" ");
      runSync(
        log[level](message).pipe(
          Effect.withSpan("desktop.updater", {
            attributes: { component: "desktop-updater", level },
          }),
        ),
      );
    };
  let instance: AutoUpdater | undefined;
  let restoreLogger = () => {};
  yield* Effect.addFinalizer(() => Effect.sync(() => restoreLogger()));

  const getUpdater = () => {
    if (instance !== undefined) return instance;
    const updater = autoUpdater;
    const previousLogger = updater.logger;
    updater.logger = {
      debug: bridge("logDebug"),
      info: bridge("logInfo"),
      warn: bridge("logWarning"),
      error: bridge("logError"),
    };
    restoreLogger = () => {
      updater.logger = previousLogger;
    };
    if (updater instanceof AppImageUpdater) {
      // The dependency's onQuit handler can install after this scope closes.
      verifyAppImageInstalls(updater);
    }
    instance = updater;
    return updater;
  };

  return ElectronUpdater.of({
    setFeedURL: (options) =>
      Effect.suspend(() => {
        getUpdater().setFeedURL(options);
        return Effect.void;
      }),
    setAutoDownload: (value) =>
      Effect.suspend(() => {
        getUpdater().autoDownload = value;
        return Effect.void;
      }),
    setAutoInstallOnAppQuit: (value) =>
      Effect.suspend(() => {
        getUpdater().autoInstallOnAppQuit = value;
        return Effect.void;
      }),
    setChannel: (channel) =>
      Effect.suspend(() => {
        getUpdater().channel = channel;
        return Effect.void;
      }),
    setAllowPrerelease: (value) =>
      Effect.suspend(() => {
        getUpdater().allowPrerelease = value;
        return Effect.void;
      }),
    allowDowngrade: Effect.sync(() => getUpdater().allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.suspend(() => {
        getUpdater().allowDowngrade = value;
        return Effect.void;
      }),
    setFullChangelog: (value) =>
      Effect.suspend(() => {
        getUpdater().fullChangelog = value;
        return Effect.void;
      }),
    setDisableDifferentialDownload: (value) =>
      Effect.suspend(() => {
        getUpdater().disableDifferentialDownload = value;
        return Effect.void;
      }),
    checkForUpdates: Effect.suspend(() => {
      const updater = getUpdater();
      const channel = updater.channel;
      return Effect.tryPromise({
        try: () => updater.checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    downloadUpdate: Effect.suspend(() => {
      const updater = getUpdater();
      const channel = updater.channel;
      return Effect.tryPromise({
        try: () => updater.downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.suspend(() => {
        const updater = getUpdater();
        const channel = updater.channel;
        return Effect.try({
          try: () => updater.quitAndInstall(isSilent, isForceRunAfter),
          catch: (cause) =>
            new ElectronUpdaterQuitAndInstallError({
              channel,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        });
      }),
    on: (eventName, listener) =>
      Effect.suspend(() => {
        const eventTarget = getUpdater() as unknown as {
          on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
          removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
        };
        const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
        return Effect.acquireRelease(
          Effect.sync(() => {
            eventTarget.on(eventName, untypedListener);
          }),
          () =>
            Effect.sync(() => {
              eventTarget.removeListener(eventName, untypedListener);
            }),
        ).pipe(Effect.asVoid);
      }),
  });
});

export const layer = Layer.effect(ElectronUpdater, make);
