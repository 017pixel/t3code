import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  listLoginShellCandidates,
  LoginShellEnvironment,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  setWindowsPath,
} from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

type ShellEnvironment = Partial<Record<string, string>>;

// mise's record of the PATH entries it added. It must travel with the shell's
// PATH, or `mise x` can rebuild PATH behind a same-named wrapper
// (`exec mise x claude -- claude`) that then re-runs itself forever.
const LOGIN_SHELL_ENVIRONMENT_NAMES = ["PATH", "__MISE_DIFF", "JAVA_HOME"];

function applyShellEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  shellEnvironment: ShellEnvironment,
  fallbackPath?: string,
): void {
  const shellPath = shellEnvironment.PATH;
  const mergedPath = mergePathEntries(shellPath ?? fallbackPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  if (shellPath && shellEnvironment.__MISE_DIFF) {
    env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  }
  // Android SDK tools are Java programs. A keg-only JDK (Homebrew's openjdk)
  // is only reachable through the JAVA_HOME the shell profile sets.
  if (!env.JAVA_HOME && shellEnvironment.JAVA_HOME) {
    env.JAVA_HOME = shellEnvironment.JAVA_HOME;
  }
}

/**
 * Environments whose startup login-shell probe failed (a slow profile, say),
 * with the time of the last attempt. Until one succeeds, providers would keep
 * launching with the service manager's bare PATH.
 */
const unresolvedLoginShellPaths = new WeakMap<
  NodeJS.ProcessEnv,
  { lastAttemptAt: number; inFlight: Deferred.Deferred<void> | undefined }
>();

const LOGIN_SHELL_RETRY_INTERVAL_MS = 30_000;

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  let shellEnvironment: ShellEnvironment = {};
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellEnvironment = readEnvironmentFromLoginShell(shell, LOGIN_SHELL_ENVIRONMENT_NAMES);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellEnvironment.PATH) break;
  }

  const launchctlPath =
    platform === "darwin" && !shellEnvironment.PATH ? readPathFromLaunchctl() : undefined;
  applyShellEnvironment(env, platform, shellEnvironment, launchctlPath);
  return shellEnvironment.PATH !== undefined;
}

const readLoginShellEnvironment = Effect.fn("readLoginShellEnvironment")(function* (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  const readEnvironment = yield* LoginShellEnvironment;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    const shellEnvironment = yield* readEnvironment(shell, LOGIN_SHELL_ENVIRONMENT_NAMES).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
          return {} as ShellEnvironment;
        }),
      ),
    );
    if (shellEnvironment.PATH) return shellEnvironment;
  }
  return undefined;
});

/**
 * Retries the login-shell probe that failed at startup, at most once per
 * interval, without blocking the event loop. Provider launches await it so a
 * CLI installed after the shell recovers is found without a server restart.
 */
export const recoverLoginShellPath = Effect.fn("recoverLoginShellPath")(function* () {
  const env = yield* HostProcess.Environment;
  const pending = unresolvedLoginShellPaths.get(env);
  if (pending === undefined) return;
  if (pending.inFlight) return yield* Deferred.await(pending.inFlight);
  const now = yield* Clock.currentTimeMillis;
  if (now - pending.lastAttemptAt < LOGIN_SHELL_RETRY_INTERVAL_MS) return;

  const platform = yield* HostProcess.Platform;
  const inFlight = yield* Deferred.make<void>();
  pending.lastAttemptAt = now;
  pending.inFlight = inFlight;
  // Detached so an interrupted launch cannot strand callers awaiting this attempt.
  yield* readLoginShellEnvironment(env, platform).pipe(
    Effect.map((shellEnvironment) => {
      if (shellEnvironment === undefined) return;
      applyShellEnvironment(env, platform, shellEnvironment);
      unresolvedLoginShellPaths.delete(env);
    }),
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        logPathHydrationWarning("Failed to recover the login-shell PATH.", Cause.pretty(cause)),
      ),
    ),
    Effect.ensuring(
      Effect.suspend(() => {
        pending.inFlight = undefined;
        return Deferred.done(inFlight, Exit.void);
      }),
    ),
    Effect.forkDetach,
  );
  yield* Deferred.await(inFlight);
});

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentPrepared?: boolean | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;

  if (platform === "win32") {
    // The desktop already ran both PowerShell probes into the env this child
    // extends. Repeating them here costs seconds of startup on Windows.
    if (options?.shellEnvironmentPrepared === true) return;
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value === undefined) continue;
      if (key === "PATH") {
        setWindowsPath(env, value);
      } else {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  if (options?.shellEnvironmentPrepared === true) return;
  const shellPathResolved = yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
        return false;
      }),
    ),
  );
  if (!shellPathResolved) {
    unresolvedLoginShellPaths.set(env, {
      lastAttemptAt: yield* Clock.currentTimeMillis,
      inFlight: undefined,
    });
  }
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(yield* HostProcess.HomeDirectory, ".t3");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
