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
import * as Schedule from "effect/Schedule";
import * as Maintenance from "@t3tools/provider-core/server/maintenance";
import * as WindowsInstallJob from "../process/windowsInstallJob.ts";

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

export const installLeasePath = (directory: string) => NodePath.join(directory, "install.json");

/** Start identity includes the Linux boot so leases cannot survive a reboot's PID reuse. */
export const readProcessIdentity = (pid: number): string | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const platform = NodeOS.platform();
    if (platform === "linux") {
      const fields = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8")
        .split(") ")
        .at(-1)!
        .split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return "";
      const start = fields[19];
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
        : NodeChildProcess.spawnSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "lstart="], {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          });
    if (scan.error || scan.status !== 0) return null;
    const value = scan.stdout.trim();
    if (platform === "darwin") {
      const state = /^([A-Z][A-Z+<NLsEs]*?)\s+(.*)$/.exec(value);
      if (state) return state[1]!.startsWith("Z") ? "" : state[2]!;
    }
    return value || null;
  } catch {
    return null;
  }
};

/** Unknown identities keep admission closed; only death or a different start proves release safe. */
export const isProcessAlive = (pid: number, identity?: string | null, observed?: string | null) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // A live table row is already a liveness observation. Rechecking death here
  // could lose a helper spawned between the scan and its parent's exit.
  if (observed === undefined) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      // Permission to signal and permission to read creation identity can differ.
    }
  }
  const current = observed === undefined ? readProcessIdentity(pid) : observed;
  if (current === "") return false;
  if (!identity || current === null) return true;
  // Readers written by older Linux servers contain only the start tick.
  return (
    current === identity ||
    (NodeOS.platform() === "linux" && /^\d+$/.test(identity) && current.endsWith(`:${identity}`))
  );
};

// A named Windows job retains every descendant in the kernel, even when a
// short-lived parent exits between observations or the supervisor is killed.
const ownedJobs = new Set<string>();
const windowsJobProcesses = (
  pid: number,
  job: string,
  create: boolean,
  includeRoot = false,
  identity?: string | null,
) => {
  const children = WindowsInstallJob.processes(pid, job, create);
  const local = pid === process.pid && ownedJobs.has(job);
  const current = includeRoot || local || !identity ? null : readProcessIdentity(pid);
  const supervisor =
    !includeRoot &&
    (local || (identity != null && current !== null && isProcessAlive(pid, identity, current)));
  return children.some((child) => includeRoot || child !== pid || !supervisor);
};
export const createInstallJob = (pid: number, job: string) => {
  if (NodeOS.platform() !== "win32") return;
  windowsJobProcesses(pid, job, true);
  if (pid === process.pid) ownedJobs.add(job);
};

const ProcessIdentity = Schema.Struct({
  pid: Schema.Number,
  identity: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeInstallLease = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Number,
      Schema.Struct({
        ...ProcessIdentity.fields,
        descendants: Schema.optional(Schema.Array(ProcessIdentity)),
        job: Schema.optional(Schema.String),
      }),
    ]),
  ),
);
export type InstallDescendants = Map<number, string | null>;
const installs = new Map<
  string,
  {
    pid: number;
    identity: string | null | undefined;
    job: string | undefined;
    descendants: InstallDescendants;
  }
>();

/** Retain ancestors for the lease's whole lifetime, including after they exit or are reparented. */
export const installChildrenAreAlive = (
  pid: number,
  identity?: string | null,
  descendants: InstallDescendants = new Map(),
  job?: string,
): boolean => {
  const windows = NodeOS.platform() === "win32";
  if (windows && job) return windowsJobProcesses(pid, job, false, false, identity);
  const scan = windows
    ? NodeChildProcess.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))\" }",
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      )
    : NodeChildProcess.spawnSync("ps", ["-ax", "-o", "pid=", "-o", "pgid=", "-o", "stat="], {
        encoding: "utf8",
        timeout: 10_000,
      });
  if (scan.error || scan.status !== 0)
    throw new Error("Could not inspect provider installer processes");
  const rows = scan.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [child, parent, state] = windows ? line.split("|") : line.trim().split(/\s+/);
      if (
        !Number.isSafeInteger(Number(child)) ||
        Number(child) <= 0 ||
        !Number.isSafeInteger(Number(parent)) ||
        !state
      )
        throw new Error("Could not inspect provider installer processes");
      return {
        pid: Number(child),
        parent: Number(parent),
        identity: windows ? state : undefined,
        zombie: !windows && state.startsWith("Z"),
      };
    });
  const groupAlive =
    !windows &&
    rows.some(
      (row) => row.pid !== pid && row.pid !== scan.pid && row.parent === pid && !row.zombie,
    );
  const roots = new Map(descendants);
  roots.set(pid, identity ?? null);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const retained = descendants.has(row.pid);
      if (
        row.pid === pid ||
        row.pid === scan.pid ||
        row.zombie ||
        (retained && (windows ? descendants.get(row.pid) === row.identity : row.parent !== pid))
      )
        continue;
      if (!windows) {
        if (row.parent !== pid) continue;
      } else {
        if (!roots.has(row.parent)) continue;
        const parent = rows.find((candidate) => candidate.pid === row.parent);
        const expected = roots.get(row.parent);
        // Replacing a retained PID needs live ancestry, not an orphan's stale parent PID.
        if (retained && !parent) continue;
        // A recycled ancestor cannot introduce descendants belonging to its new owner.
        if (parent && expected && parent.identity !== expected) continue;
        const parentStart = expected ? Date.parse(expected) : NaN;
        if (Number.isFinite(parentStart) && Date.parse(row.identity!) < parentStart) continue;
      }
      const start = row.identity ?? readProcessIdentity(row.pid);
      if (start === "" || (retained && descendants.get(row.pid) === start)) continue;
      descendants.set(row.pid, start);
      roots.set(row.pid, start);
      changed = true;
    }
  }
  return (
    groupAlive ||
    Array.from(descendants).some(([child, start]) => {
      const row = rows.find((candidate) => candidate.pid === child);
      return (
        !row?.zombie &&
        isProcessAlive(child, start, row ? (row.identity ?? readProcessIdentity(child)) : undefined)
      );
    })
  );
};

/** Observe even live supervisors so a later scan can retain orphaned Windows helpers. */
export const installIsAlive = (directory: string): boolean => {
  let lease;
  try {
    lease = decodeInstallLease(NodeFS.readFileSync(installLeasePath(directory), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      installs.delete(directory);
      return false;
    }
    throw error;
  }
  const pid = typeof lease === "number" ? lease : lease.pid;
  const identity = typeof lease === "number" ? undefined : lease.identity;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid provider install lease");
  const job = typeof lease === "number" ? undefined : lease.job;
  if (NodeOS.platform() === "win32" && job) return windowsJobProcesses(pid, job, false, true);
  let tracked = installs.get(directory);
  if (!tracked || tracked.pid !== pid || tracked.identity !== identity || tracked.job !== job) {
    tracked = { pid, identity, job, descendants: new Map() };
    installs.set(directory, tracked);
  }
  const uncertain: number[] = [];
  if (typeof lease !== "number") {
    for (const descendant of lease.descendants ?? []) {
      if (!Number.isSafeInteger(descendant.pid) || descendant.pid <= 0)
        throw new Error("Invalid provider install descendant");
      const durable = descendant.identity ?? null;
      // A stale receipt cannot replace a newer observation of the same helper PID.
      if (!tracked.descendants.has(descendant.pid)) {
        tracked.descendants.set(descendant.pid, durable);
      } else if (durable !== null && tracked.descendants.get(descendant.pid) !== durable) {
        const current = readProcessIdentity(descendant.pid);
        if (current === durable) tracked.descendants.set(descendant.pid, durable);
        // Retry conflicting generations next time without erasing either ownership observation.
        else if (current === null) uncertain.push(descendant.pid);
      }
    }
  }
  const supervisor = isProcessAlive(pid, identity);
  const children = installChildrenAreAlive(pid, identity, tracked.descendants, job);
  return supervisor || children || uncertain.some((child) => isProcessAlive(child));
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
  const handoff = <A, E, R, E2 = never, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    acknowledge: Effect.Effect<void, E2, R2> = Effect.void,
  ) =>
    Effect.flatMap(HeldGate, (gate) =>
      gate === null
        ? Effect.die(new Error("Provider install requires the host write lease"))
        : Effect.uninterruptibleMask((restore) =>
            gate.handoff.pipe(
              Effect.andThen(acknowledge),
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
  // A stale reader file can pin admission for this process's entire lifetime.
  const retryReadCleanup = <A>(cleanup: () => A) =>
    Effect.try(cleanup).pipe(Effect.retry(Schedule.spaced("1 second")), Effect.orDie);
  const registerRead = Effect.gen(function* () {
    const file = yield* Effect.sync(() =>
      NodePath.join(readers, `${process.pid}-${NodeCrypto.randomUUID()}`),
    );
    yield* Effect.sync(() =>
      NodeFS.writeFileSync(file, readProcessIdentity(process.pid) ?? "", { flag: "wx" }),
    ).pipe(
      Effect.onError((cause) => {
        const error = Cause.squash(cause);
        return error instanceof Error && "code" in error && error.code === "EEXIST"
          ? Effect.void
          : retryReadCleanup(() => NodeFS.rmSync(file, { force: true }));
      }),
    );
    return file;
  });
  // A provider can launch helper CLIs while its turn holds a read lease.
  // Joining that lease must not wait behind an installer draining this turn.
  const acquireRead = Effect.uninterruptible(
    Effect.gen(function* () {
      let created: string | undefined;
      const register = Effect.tap(registerRead, (file) =>
        Effect.sync(() => {
          created = file;
        }),
      );
      return yield* Effect.gen(function* () {
        const inherited = yield* HeldRead;
        const held = yield* HeldWrite;
        const lease =
          inherited?.lease.owner === owner && inherited.active
            ? inherited.lease
            : {
                owner,
                // An install's scoped verification keeps its own reader if it outlives the writer.
                file: yield* held?.owner === owner && held.active
                  ? register
                  : Effect.acquireUseRelease(
                      Effect.interruptible(readPermit.take(1)),
                      () => withGate(register),
                      () => Effect.asVoid(readPermit.release(1)),
                    ),
                users: 0,
              };
        lease.users++;
        const token = { lease, active: true };
        const release = retryReadCleanup(() => {
          if (!token.active) return;
          if (lease.users === 1) NodeFS.rmSync(lease.file, { force: true });
          lease.users--;
          token.active = false;
        });
        readTokens.set(release, token);
        return release;
      }).pipe(
        Effect.onError(() =>
          retryReadCleanup(() => {
            if (created) NodeFS.rmSync(created, { force: true });
          }),
        ),
      );
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
      const path = NodePath.join(readers, file);
      const pid = Number(file.split("-")[0]);
      let identity;
      try {
        identity = NodeFS.readFileSync(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (isProcessAlive(pid, identity)) busy = true;
      else NodeFS.rmSync(path, { force: true });
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
