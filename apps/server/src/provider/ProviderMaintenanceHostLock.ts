// @effect-diagnostics nodeBuiltinImport:off - Host leases coordinate independent Node servers.
// oxlint-disable t3code/no-global-process-runtime -- Leases belong to the OS user and process, not an environment.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Maintenance from "@t3tools/provider-core/server/maintenance";

const HeldWrite = Context.Reference<{ readonly owner: object; active: boolean } | null>(
  "t3/provider/ProviderMaintenanceHostLock/HeldWrite",
  { defaultValue: () => null },
);

interface ReadToken {
  readonly lease: { readonly owner: object; readonly file: string; users: number };
  active: boolean;
}
const HeldRead = Context.Reference<ReadToken | null>(
  "t3/provider/ProviderMaintenanceHostLock/HeldRead",
  { defaultValue: () => null },
);

const HeldGate = Context.Reference<{
  readonly handoff: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
} | null>("t3/provider/ProviderMaintenanceHostLock/HeldGate", { defaultValue: () => null });

// Linux exposes a process start identity, so recycled PIDs cannot pin a dead reader.
const processIdentity = (pid: number) => {
  if (NodeOS.platform() !== "linux") return null;
  const fields = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
  return fields[0] === "Z" ? "" : fields[19]!;
};

export const installLeasePath = (directory: string) => NodePath.join(directory, "install.json");

/** Start identity includes the Linux boot so leases cannot survive a reboot's PID reuse. */
export const readProcessIdentity = (pid: number): string | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const platform = NodeOS.platform();
    if (platform === "linux") {
      const start = processIdentity(pid);
      return start
        ? `${NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`
        : null;
    }
    if (platform !== "darwin" && platform !== "win32") return null;
    const scan =
      platform === "win32"
        ? NodeChildProcess.spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop).CreationDate.ToUniversalTime().ToString('o')`,
            ],
            { encoding: "utf8", timeout: 10_000, windowsHide: true },
          )
        : NodeChildProcess.spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          });
    return scan.error || scan.status !== 0 ? null : scan.stdout.trim() || null;
  } catch {
    return null;
  }
};

export const isProcessAlive = (pid: number, identity?: string | null) => {
  try {
    process.kill(pid, 0);
    if (processIdentity(pid) === "") return false;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "ENOENT")
    )
      return false;
    return true;
  }
  if (identity == null) return true;
  const current = readProcessIdentity(pid);
  return current === null || current === identity;
};

const decodeInstallLease = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Number,
      Schema.Struct({
        pid: Schema.Number,
        identity: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ]),
  ),
);

/** A dead supervisor's installer still owns admission until its entire process group exits. */
export const installIsAlive = (directory: string): boolean => {
  const file = installLeasePath(directory);
  let pid: number;
  let identity: string | null | undefined;
  try {
    const lease = decodeInstallLease(NodeFS.readFileSync(file, "utf8"));
    pid = typeof lease === "number" ? lease : lease.pid;
    identity = typeof lease === "number" ? undefined : lease.identity;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid provider install lease");
  if (isProcessAlive(pid, identity)) return true;
  return installChildrenAreAlive(pid);
};

/** The installer can leave children writing after its root exits. Failed scans keep admission closed. */
export const installChildrenAreAlive = (pid: number): boolean => {
  const windows = NodeOS.platform() === "win32";
  const scan = windows
    ? NodeChildProcess.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)" }',
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      )
    : NodeChildProcess.spawnSync("ps", ["-ax", "-o", "pid=", "-o", "pgid=", "-o", "stat="], {
        encoding: "utf8",
        timeout: 10_000,
      });
  if (scan.error || scan.status !== 0)
    throw new Error("Could not inspect provider installer processes");
  if (windows) {
    const descendants = new Set([pid]);
    const rows = scan.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("|").map(Number));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [child, parent] of rows) {
        if (
          parent !== undefined &&
          child !== undefined &&
          child !== scan.pid &&
          descendants.has(parent) &&
          !descendants.has(child)
        ) {
          descendants.add(child);
          changed = true;
        }
      }
    }
    if (descendants.size > 1) return true;
  } else if (
    scan.stdout.split(/\r?\n/).some((line) => {
      const [child, group, state] = line.trim().split(/\s+/);
      return (
        Number(child) !== pid &&
        Number(child) !== scan.pid &&
        Number(group) === pid &&
        state !== undefined &&
        !state.startsWith("Z")
      );
    })
  )
    return true;
  return false;
};

/**
 * One user-wide reader/writer gate, deliberately covering every CLI: package
 * managers can replace several providers in one installation. Readers overlap;
 * an installer closes admission before waiting for active turns to drain.
 */
export const make = (directory: string) => {
  const owner = {};
  const readers = NodePath.join(directory, "readers");
  const prepare = Effect.sync(() => NodeFS.mkdirSync(readers, { recursive: true }));
  const acquireGate = (compromised: Deferred.Deferred<never>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* prepare;
        const services = yield* Effect.context<never>();
        while (true) {
          while (yield* Effect.sync(() => installIsAlive(directory))) {
            yield* Effect.interruptible(restore(Effect.sleep("1 second")));
          }
          let preserve = false;
          const result = yield* Effect.tryPromise(() =>
            lock(NodePath.join(directory, "gate"), {
              realpath: false,
              stale: 120_000,
              update: 10_000,
              fs: {
                ...NodeFS,
                rmdir: (
                  path: NodeFS.PathLike,
                  callback: (error: NodeJS.ErrnoException | null) => void,
                ) => {
                  if (preserve) callback(null);
                  else NodeFS.rmdir(path, callback);
                },
              },
              onCompromised: (error) =>
                Effect.runSyncWith(services)(Deferred.die(compromised, error)),
            }),
          ).pipe(Effect.result);
          if (result._tag === "Success") {
            // An installer may have registered after our first check, before its
            // server died and this gate's heartbeat expired.
            const alive = yield* Effect.sync(() => {
              const alive = installIsAlive(directory);
              // Reclaim under the gate so no scan can erase a newer install lease.
              if (!alive) NodeFS.rmSync(installLeasePath(directory), { force: true });
              return alive;
            }).pipe(Effect.onError(() => Effect.promise(() => result.success())));
            if (alive) {
              yield* Effect.promise(() => result.success());
              continue;
            }
            return {
              release: result.success,
              handoff: async () => {
                preserve = true;
                await result.success();
              },
            };
          }
          const cause = result.failure.cause;
          if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ELOCKED") {
            return yield* Effect.die(cause);
          }
          yield* Effect.interruptible(restore(Effect.sleep("100 millis")));
        }
      }),
    );
  const withGate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const compromised = yield* Deferred.make<never>();
        let current = yield* acquireGate(compromised);
        let held = true;
        const token = {
          handoff: Effect.promise(async () => {
            await current.handoff();
            held = false;
          }),
          resume: Effect.map(acquireGate(compromised), (gate) => {
            current = gate;
            held = true;
          }),
        };
        return {
          token,
          compromised,
          release: () => (held ? current.release() : Promise.resolve()),
        };
      }),
      ({ token, compromised }) =>
        effect.pipe(
          Effect.provideService(HeldGate, token),
          Effect.raceFirst(Deferred.await(compromised)),
        ),
      ({ release }) => Effect.promise(release),
    );
  // Stop this process's heartbeat and exit hook without opening the gate. The
  // acknowledged supervisor maintains the same gate, then releases it on exit.
  const handoff = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(HeldGate, (gate) =>
      gate === null
        ? Effect.die(new Error("Provider install requires the host write lease"))
        : Effect.uninterruptibleMask((restore) =>
            gate.handoff.pipe(
              Effect.andThen(restore(effect)),
              Effect.onExit((exit) =>
                exit._tag === "Failure" && Cause.hasInterrupts(exit.cause)
                  ? Effect.void
                  : restore(gate.resume),
              ),
            ),
          ),
    );

  const readPermit = Semaphore.makeUnsafe(1);
  const readTokens = new WeakMap<Effect.Effect<void>, ReadToken>();
  const registerRead = Effect.sync(() => {
    const file = NodePath.join(readers, `${process.pid}-${NodeCrypto.randomUUID()}`);
    NodeFS.writeFileSync(file, processIdentity(process.pid) ?? "", { flag: "wx" });
    return file;
  });
  // A provider can launch helper CLIs while its turn holds a read lease.
  // Joining that lease must not wait behind an installer draining this turn.
  const acquireRead = Effect.uninterruptible(
    Effect.gen(function* () {
      const inherited = yield* HeldRead;
      const held = yield* HeldWrite;
      const lease =
        inherited?.lease.owner === owner && inherited.active
          ? inherited.lease
          : {
              owner,
              // An install's scoped verification keeps its own reader if it outlives the writer.
              file: yield* held?.owner === owner && held.active
                ? registerRead
                : Effect.acquireUseRelease(
                    Effect.interruptible(readPermit.take(1)),
                    () => withGate(registerRead),
                    () => Effect.asVoid(readPermit.release(1)),
                  ),
              users: 0,
            };
      lease.users++;
      const token = { lease, active: true };
      const release = Effect.sync(() => {
        if (!token.active) return;
        token.active = false;
        if (--lease.users === 0) NodeFS.rmSync(lease.file, { force: true });
      });
      readTokens.set(release, token);
      return release;
    }),
  );
  const withRead = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    inheritedRelease?: Effect.Effect<void>,
  ) => {
    const inherited = inheritedRelease === undefined ? undefined : readTokens.get(inheritedRelease);
    const read = Effect.acquireUseRelease(
      acquireRead,
      (release) => effect.pipe(Effect.provideService(HeldRead, readTokens.get(release)!)),
      (release) => release,
    );
    return inherited === undefined ? read : read.pipe(Effect.provideService(HeldRead, inherited));
  };
  const drained = Effect.sync(() => {
    let busy = false;
    for (const file of NodeFS.readdirSync(readers)) {
      const pid = Number(file.split("-")[0]);
      try {
        process.kill(pid, 0);
        const identity = processIdentity(pid);
        if (
          identity !== null &&
          identity !== NodeFS.readFileSync(NodePath.join(readers, file), "utf8")
        ) {
          NodeFS.rmSync(NodePath.join(readers, file), { force: true });
        } else {
          busy = true;
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "ESRCH" && error.code !== "ENOENT")
        ) {
          throw error;
        }
        NodeFS.rmSync(NodePath.join(readers, file), { force: true });
      }
    }
    return !busy;
  });
  /** `onBusy` runs once if active turns or CLI calls, here or on another server, must drain first. */
  const withWrite = <A, E, R, E2 = never, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    onBusy?: Effect.Effect<void, E2, R2>,
  ) =>
    withGate(
      Effect.gen(function* () {
        if (!(yield* drained)) {
          if (onBusy) yield* onBusy;
          while (!(yield* drained)) yield* Effect.sleep("100 millis");
        }
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => ({ owner, active: true })),
          (token) => effect.pipe(Effect.provideService(HeldWrite, token)),
          (token) =>
            Effect.sync(() => {
              token.active = false;
            }),
        );
      }),
    );
  return { directory, acquireRead, withRead, withWrite, handoff };
};

/** Every T3 server on the host shares the user's provider CLIs, so servers share one gate. */
export const userDirectory = () =>
  NodePath.join(
    process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache"),
    "t3",
    "provider-maintenance",
  );

/**
 * Servers provide the user-wide gate through `layer`. Anything else, such as a
 * test, gets a private gate so it never waits on or blocks a live T3.
 */
export class ProviderMaintenanceHostLock extends Context.Reference<ReturnType<typeof make>>(
  "t3/provider/ProviderMaintenanceHostLock",
  {
    defaultValue: () => {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-maintenance-"),
      );
      process.once("exit", () => NodeFS.rmSync(directory, { recursive: true, force: true }));
      return make(directory);
    },
  },
) {}

export const layer = Layer.effectContext(
  Effect.sync(() => {
    const host = make(userDirectory());
    const admission = Maintenance.ProviderMaintenanceAdmission.defaultValue();
    return Context.make(ProviderMaintenanceHostLock, host).pipe(
      Context.add(Maintenance.ProviderMaintenanceAdmission, {
        // Taking the host lease first prevents a probe nested in an update
        // window from waiting behind a writer that needs local admission.
        withPermit: (effect) => host.withRead(admission.withPermit(effect)),
        withLaunchPermit: (effect) => host.withRead(admission.withLaunchPermit(effect)),
        withScopedLaunchPermit: (effect) =>
          Effect.acquireRelease(host.acquireRead, (release) => release, {
            interruptible: true,
          }).pipe(
            Effect.flatMap((release) =>
              host.withRead(admission.withScopedLaunchPermit(effect), release),
            ),
          ),
      }),
    );
  }),
);
