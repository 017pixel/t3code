// @effect-diagnostics nodeBuiltinImport:off - The ownership lock is a native SQLite handle held for the server's lifetime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import {
  BOOT_SERVICE_LAUNCHD_LABEL,
  BOOT_SERVICE_PLIST_FILE,
  BOOT_SERVICE_UNIT_FILE,
  bootServiceBaseDirOf,
} from "./cloud/bootService.ts";
import { ServiceLauncherHostProcess } from "./cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  compareExactServiceVersions,
  serviceStateActiveVersion,
} from "./cloud/serviceProtocol.ts";
import * as ProcessRunner from "./processRunner.ts";
import {
  clearPersistedServerRuntimeState,
  isProcessAlive,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
  type PersistedServerRuntimeState,
} from "./serverRuntimeState.ts";

export class ServerAlreadyRunningError extends Schema.TaggedError<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  { stateDir: Schema.String },
) {
  // Distinct process exit code so a supervisor can tell "owned by another
  // server" apart from a crash and stop restarting.
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;

  override get message(): string {
    return `A T3 Code server already owns ${this.stateDir}. Stop that server, or use a separate T3 home and pair with it, then retry. Never delete server-owner.sqlite: it is that server's lock, not a stale file. No server was stopped.`;
  }
}

export class OlderBootServiceError extends Schema.TaggedError<OlderBootServiceError>()(
  "OlderBootServiceError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;

  override get message(): string {
    return `A T3 Code background service set up for ${this.baseDir} may still run a release without the ownership lock. On that machine, try \`t3 update\` and let it restart (or run \`t3 service restart\` if the update is already installed). If the older launcher cannot update, run \`t3 service uninstall\`, then reinstall with \`t3 service install\` from a current CLI. You can also leave the service uninstalled. Pass \`--base-dir ${this.baseDir}\` to each command, and use \`npx t3@latest\` if \`t3\` is not installed or is outdated. Then retry. No server was stopped.`;
  }
}

export class ServerOwnershipError extends Schema.TaggedError<ServerOwnershipError>()(
  "ServerOwnershipError",
  { stateDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not acquire server ownership of ${this.stateDir}.`;
  }
}

export class ServerOwnershipLostError extends Schema.TaggedError<ServerOwnershipLostError>()(
  "ServerOwnershipLostError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return `server-owner.sqlite in ${this.stateDir} was deleted or replaced while this server owned it, so another T3 Code server can now start in the same T3 home. Stopping this server to protect its data. Never delete server-owner.sqlite while a server runs.`;
  }
}

// One stat per interval. It bounds how late a loss is noticed, not how long two
// servers share a home: scheduling and graceful shutdown add to the overlap.
const OWNERSHIP_CHECK_INTERVAL = Duration.seconds(5);

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

/**
 * Servers from before this lock only publish `server-runtime.json`. Treat
 * their record as stale only when the process start time proves PID reuse.
 */
const legacyOwnerIsLive = Effect.fn("legacyOwnerIsLive")(function* (
  state: PersistedServerRuntimeState,
) {
  if (!isProcessAlive(state.pid)) return false;
  const recordedAt = Date.parse(state.startedAt);
  if (!Number.isFinite(recordedAt)) return true;
  const windows = (yield* HostProcess.Platform) === "win32";
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      command: windows ? "powershell.exe" : "ps",
      args: windows
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${state.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
          ]
        : ["-p", String(state.pid), "-o", "lstart="],
      env: { LC_ALL: "C", TZ: "UTC" },
      timeout: Duration.seconds(2),
      maxOutputBytes: 16_384,
    })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) return true;
  const output = result.value.stdout.trim();
  const startedAt = Date.parse(windows ? output : `${output} UTC`);
  // ps reports whole seconds. Unknown identity stays conservative.
  return !Number.isFinite(startedAt) || startedAt <= recordedAt + 1_000;
});

// Pre-lock services become invisible when another server replaces their runtime
// record. Unreadable configuration or an unavailable manager allows startup.
const olderBootServiceHome = Effect.fn("olderBootServiceHome")(
  function* (stateDir: string) {
    if (
      (yield* ServiceLauncherHostProcess).connected &&
      (yield* HostProcess.Environment)[SERVICE_LAUNCHER_CONTEXT_ENV] !== undefined
    ) {
      return undefined;
    }
    const platform = yield* HostProcess.Platform;
    const uid = yield* HostProcess.UserId;
    if (platform !== "linux" && (platform !== "darwin" || uid === undefined)) return undefined;

    const homeDir = yield* HostProcess.HomeDirectory;
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const unitPath =
      platform === "darwin"
        ? NodePath.join(homeDir, "Library", "LaunchAgents", BOOT_SERVICE_PLIST_FILE)
        : NodePath.join(homeDir, ".config", "systemd", "user", BOOT_SERVICE_UNIT_FILE);
    const baseDir = bootServiceBaseDirOf(yield* fs.readFileString(unitPath));
    if (
      baseDir === undefined ||
      (yield* fs.realPath(NodePath.join(baseDir, "userdata"))) !== (yield* fs.realPath(stateDir))
    ) {
      return undefined;
    }
    const runtimeDir = NodePath.join(baseDir, "runtime");
    const version = serviceStateActiveVersion(
      yield* fs.readFileString(NodePath.join(runtimeDir, SERVICE_STATE_FILE)),
    );
    if (version === undefined) return undefined;
    const run = (command: string, args: ReadonlyArray<string>) =>
      runner.run({ command, args, timeout: Duration.seconds(5), maxOutputBytes: 65_536 });
    let loaded: boolean;
    if (platform === "darwin") {
      loaded =
        (yield* run("launchctl", ["print", `gui/${uid}/${BOOT_SERVICE_LAUNCHD_LABEL}`])).code === 0;
      if (!loaded) {
        const disabled = yield* run("launchctl", ["print-disabled", `gui/${uid}`]);
        // Older macOS versions print `true` instead of `disabled`.
        if (
          disabled.code !== 0 ||
          disabled.stdout.includes(`"${BOOT_SERVICE_LAUNCHD_LABEL}" => disabled`) ||
          disabled.stdout.includes(`"${BOOT_SERVICE_LAUNCHD_LABEL}" => true`)
        )
          return undefined;
      }
    } else {
      const active = yield* run("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]);
      // A unit waiting out its Restart= delay is activating, with exit code 3.
      loaded = active.code === 0 || (active.code === 3 && active.stdout.trim() === "activating");
      if (!loaded) {
        const enabled = yield* run("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]);
        if (enabled.code !== 0 || enabled.stdout.trim() !== "enabled") return undefined;
      }
    }
    // A deferred update names the staged runtime, not the loaded service's runtime.
    if (loaded && (yield* fs.exists(NodePath.join(runtimeDir, SERVICE_RESTART_PENDING_FILE)))) {
      return baseDir;
    }
    // Stable 0.1.0 shipped the ownership lock. Earlier lock-aware prereleases
    // are conservatively refused because older runtimes expose no capability marker.
    return compareExactServiceVersions(version, "0.1.0") < 0 ? baseDir : undefined;
  },
  Effect.orElseSucceed(() => undefined),
);

/**
 * Hold an exclusive lock on the state directory until the scope closes. The
 * lock is an exclusive transaction on `server-owner.sqlite`, which never holds
 * data and must never be unlinked: the OS releases it when the process exits,
 * even on SIGKILL, so a crashed owner never blocks the next start.
 */
export const acquireServerOwnership = Effect.fn("acquireServerOwnership")(function* (
  statePath: string,
) {
  const stateDir = NodePath.dirname(statePath);
  const lockPath = NodePath.join(stateDir, "server-owner.sqlite");
  const crypto = yield* Crypto.Crypto;
  const ownerId = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => new ServerOwnershipError({ stateDir, cause })));
  // Only a missing or different file counts as lost: other stat failures
  // prove nothing about the lock.
  const verify = (lockFile: NodeFS.BigIntStats) =>
    Effect.try({
      try: () => NodeFS.statSync(lockPath, { bigint: true, throwIfNoEntry: false }),
      catch: (cause) => new ServerOwnershipError({ stateDir, cause }),
    }).pipe(
      Effect.flatMap((current) =>
        current !== undefined && current.dev === lockFile.dev && current.ino === lockFile.ino
          ? Effect.void
          : Effect.fail(new ServerOwnershipLostError({ stateDir })),
      ),
    );
  const { lockFile } = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        NodeFS.mkdirSync(stateDir, { recursive: true });
        const db = new NodeSqlite.DatabaseSync(lockPath);
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
          // The lock lives on this inode. Deleting or replacing the path
          // leaves it held but lets the next server lock a fresh file.
          return { db, lockFile: NodeFS.statSync(lockPath, { bigint: true }) };
        } catch (cause) {
          db.close();
          throw cause;
        }
      },
      catch: (cause) =>
        isSqliteBusy(cause)
          ? new ServerAlreadyRunningError({ stateDir })
          : new ServerOwnershipError({ stateDir, cause }),
    }),
    ({ db, lockFile }) =>
      readPersistedServerRuntimeState(statePath).pipe(
        // Once the lock file is gone, a successor may publish its record at
        // this path at any moment, so the record is left for it to replace.
        Effect.flatMap((state) =>
          Option.isSome(state) && state.value.ownerId === ownerId
            ? verify(lockFile).pipe(
                Effect.andThen(clearPersistedServerRuntimeState(statePath)),
                Effect.catchTag("ServerOwnershipLostError", () => Effect.void),
              )
            : Effect.void,
        ),
        Effect.ignore({ log: true }),
        Effect.ensuring(Effect.sync(() => db.close())),
      ),
  );

  const previous = yield* readPersistedServerRuntimeState(statePath).pipe(
    Effect.orElseSucceed(() => Option.none<PersistedServerRuntimeState>()),
  );
  if (
    Option.isSome(previous) &&
    previous.value.ownerId === undefined &&
    (yield* legacyOwnerIsLive(previous.value))
  ) {
    return yield* new ServerAlreadyRunningError({ stateDir });
  }
  const olderServiceHome = yield* olderBootServiceHome(stateDir);
  if (olderServiceHome !== undefined) {
    return yield* new OlderBootServiceError({ baseDir: olderServiceHome });
  }

  return {
    publish: (state: PersistedServerRuntimeState) =>
      verify(lockFile).pipe(
        Effect.andThen(
          persistServerRuntimeState({ path: statePath, state: { ...state, ownerId } }),
        ),
      ),
    /** Fails once the lock file is gone or replaced. Never reacquires it. */
    awaitLoss: verify(lockFile).pipe(
      Effect.catchTags({
        ServerOwnershipError: (error) =>
          Effect.logWarning("Could not check the server ownership lock", { cause: error }),
      }),
      Effect.andThen(Effect.sleep(OWNERSHIP_CHECK_INTERVAL)),
      Effect.forever,
      Effect.tapError((error) => Effect.logError(error.message)),
    ),
  };
});
