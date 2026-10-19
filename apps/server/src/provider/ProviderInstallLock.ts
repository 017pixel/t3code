import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

/** A lock file this old is stale even if a process with its pid is alive (pid reuse). */
const MAX_LOCK_AGE = Duration.hours(1);
/** A reclaim sentinel this old was left by a process that died mid-reclaim. */
const MAX_SENTINEL_AGE = Duration.seconds(10);
const IDLE_POLL_INTERVAL = Duration.seconds(1);

export class ProviderInstallLockError extends Schema.TaggedError<ProviderInstallLockError>()(
  "ProviderInstallLockError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not use the provider install lock directory.";
  }
}

/**
 * A lock on running a provider installer, shared by every T3 server on this
 * host. Two servers must never run `npm i -g` on the same prefix at once, and
 * a CLI must not be replaced while another server is launching it.
 */
export class ProviderInstallLock extends Context.Service<
  ProviderInstallLock,
  {
    /**
     * Runs `run` while holding the lock for `lockKey`, or returns `None` without
     * running when another process holds it. `run` calls `recordChildPid` with the
     * installer's pid: a detached installer outlives this server, and the lock
     * stays held until both `run` completes and the installer exits.
     */
    readonly tryRun: <A, E, R>(
      lockKey: string,
      run: (recordChildPid: (pid: number) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E | ProviderInstallLockError, R>;
    /** Completes once no installer holds any lock, or when the lock directory cannot be read. */
    readonly untilIdle: Effect.Effect<void>;
    /** Whether any lock is held right now. A failed read is an error, not "free". */
    readonly anyHeld: Effect.Effect<boolean, ProviderInstallLockError>;
  }
>()("t3/provider/ProviderInstallLock") {}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const cacheHome = environment.XDG_CACHE_HOME || path.join(homeDirectory, ".cache");
  const directory = path.join(cacheHome, "t3", "provider-install");

  const toLockError = (cause: unknown) => new ProviderInstallLockError({ cause });
  const ignoreNotFound =
    <B>(fallback: B) =>
    <A>(effect: Effect.Effect<A, PlatformError>): Effect.Effect<A | B, PlatformError> =>
      effect.pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(fallback) : Effect.fail(error),
        }),
      );

  /** Held while a recorded process is alive; a file mid-write counts as held until it ages out. */
  const isHeld = Effect.fn("ProviderInstallLock.isHeld")(function* (file: string) {
    const info = yield* fileSystem.stat(file);
    const modifiedAt = Option.match(info.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    });
    if ((yield* Clock.currentTimeMillis) - modifiedAt >= Duration.toMillis(MAX_LOCK_AGE)) {
      return false;
    }
    // The first line holds pids; the second identifies the owning run, including within one server.
    const [pids = ""] = (yield* fileSystem.readFileString(file)).split("\n");
    return pids.split(" ").some((value) => {
      const pid = Number.parseInt(value, 10);
      return Number.isNaN(pid) || isPidAlive(pid);
    });
  });

  /** Creates `file` exclusively; false when it already exists. */
  const createExclusively = (file: string, contents = String(process.pid)) =>
    Effect.gen(function* () {
      const handle = yield* fileSystem.open(file, { flag: "wx" });
      yield* handle
        .writeAll(new TextEncoder().encode(contents))
        .pipe(Effect.onError(() => fileSystem.remove(file, { force: true }).pipe(Effect.ignore)));
    }).pipe(
      Effect.scoped,
      Effect.as(true),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
      }),
    );

  /** Takes the short-lived sentinel that serializes reclaimers; one left by a crashed process is removed. */
  const claimSentinel = Effect.fn("ProviderInstallLock.claimSentinel")(function* (
    sentinel: string,
  ) {
    if (yield* createExclusively(sentinel)) return true;
    const info = yield* fileSystem.stat(sentinel).pipe(ignoreNotFound(undefined));
    if (info !== undefined) {
      const modifiedAt = Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      if ((yield* Clock.currentTimeMillis) - modifiedAt < Duration.toMillis(MAX_SENTINEL_AGE)) {
        return false;
      }
      yield* fileSystem.remove(sentinel, { force: true });
    }
    return yield* createExclusively(sentinel);
  });

  /**
   * Creates the lock file exclusively; false when it exists and is held. A stale one is
   * reclaimed under a sentinel, so a second reclaimer cannot delete the first one's fresh lock.
   */
  const acquire = Effect.fn("ProviderInstallLock.acquire")(function* (
    file: string,
    contents: string,
  ) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    if (yield* createExclusively(file, contents)) return true;
    if (yield* isHeld(file).pipe(ignoreNotFound(false))) return false;
    const sentinel = `${file}.reclaim`;
    if (!(yield* claimSentinel(sentinel))) return false;
    return yield* Effect.gen(function* () {
      if (yield* isHeld(file).pipe(ignoreNotFound(false))) return false;
      yield* fileSystem.remove(file, { force: true });
      return yield* createExclusively(file, contents);
    }).pipe(Effect.ensuring(fileSystem.remove(sentinel, { force: true }).pipe(Effect.ignore)));
  });

  const tryRun: ProviderInstallLock["Service"]["tryRun"] = (lockKey, run) =>
    Effect.gen(function* () {
      const file = path.join(directory, `${encodeURIComponent(lockKey)}.lock`);
      const owner = yield* crypto.randomUUIDv4().pipe(Effect.mapError(toLockError));
      const contents = `${process.pid}\n${owner}`;
      // Written aside and renamed over the lock, so a failed write (disk full)
      // leaves the previous complete record instead of an empty, held file.
      const replace = (next: string) => {
        const temporary = `${file}.${owner}.tmp`;
        return fileSystem.writeFileString(temporary, next).pipe(
          Effect.andThen(fileSystem.rename(temporary, file)),
          Effect.onError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        );
      };
      return yield* Effect.acquireUseRelease(
        acquire(file, contents).pipe(
          Effect.mapError(toLockError),
          Effect.flatMap((acquired) =>
            acquired
              ? Ref.make<{ pid: number | undefined; contents: string }>({
                  pid: undefined,
                  contents,
                })
              : Effect.succeed(undefined),
          ),
        ),
        (ownerState) =>
          ownerState === undefined
            ? Effect.succeedNone
            : run((pid) =>
                Ref.update(ownerState, (state) => ({ ...state, pid })).pipe(
                  Effect.andThen(replace(`${process.pid} ${pid}\n${owner}`)),
                  Effect.andThen(
                    Ref.set(ownerState, { pid, contents: `${process.pid} ${pid}\n${owner}` }),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("Could not record the provider installer in its lock", {
                      cause,
                    }),
                  ),
                ),
              ).pipe(Effect.map(Option.some)),
        (ownerState) =>
          ownerState === undefined
            ? Effect.void
            : Ref.get(ownerState).pipe(
                Effect.flatMap((state) =>
                  Effect.gen(function* () {
                    if ((yield* fileSystem.readFileString(file)) !== state.contents) return;
                    // Once `run` ends, only a surviving detached installer keeps the lock held.
                    if (state.pid !== undefined && isPidAlive(state.pid)) {
                      yield* replace(`${state.pid}\n${owner}`);
                    } else {
                      yield* fileSystem.remove(file, { force: true });
                    }
                  }),
                ),
                Effect.ignore,
              ),
      );
    });

  const anyHeld = Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(directory).pipe(ignoreNotFound([]));
    for (const name of names) {
      if (!name.endsWith(".lock")) continue;
      if (yield* isHeld(path.join(directory, name)).pipe(ignoreNotFound(false))) return true;
    }
    return false;
  }).pipe(Effect.mapError(toLockError));

  const untilIdle: Effect.Effect<void> = Effect.suspend(() =>
    anyHeld.pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((held) =>
        held ? Effect.sleep(IDLE_POLL_INTERVAL).pipe(Effect.andThen(untilIdle)) : Effect.void,
      ),
    ),
  );

  return ProviderInstallLock.of({ tryRun, untilIdle, anyHeld });
});

export const layer = Layer.effect(ProviderInstallLock, make);
