// @effect-diagnostics nodeBuiltinImport:off -- Process ownership survives server crashes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { installLeasePath } from "../provider/ProviderMaintenanceHostLock.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const Identity = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  startTime: Schema.NonEmptyString,
});
const OwnedProcess = Schema.Struct({ ...Identity.fields, pgid: Schema.Int });
const Entry = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: Schema.NonEmptyString,
  hostname: Schema.String,
  stateDir: Schema.String,
  owner: Identity,
  processes: Schema.Array(OwnedProcess),
});
type Identity = typeof Identity.Type;
type Entry = typeof Entry.Type;
interface ObservedProcess extends Identity {
  readonly ppid: number;
  readonly pgid: number;
  readonly zombie: boolean;
}

export interface ProcessController {
  readonly snapshot: () => ReadonlyArray<ObservedProcess> | Promise<ReadonlyArray<ObservedProcess>>;
  readonly identity?: (pid: number) => ObservedProcess | undefined;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly exists: (pid: number) => boolean;
}

const same = (a: Identity, b: Identity) => a.pid === b.pid && a.startTime === b.startTime;
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry));
const decodeProcessTable = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      ...Identity.fields,
      ppid: Schema.Int,
      pgid: Schema.Int,
      zombie: Schema.Boolean,
    }),
  ),
);

/** Uses the ACP Linux identities; macOS ps and Windows CIM supply the same creation identity. */
function controllerFor(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ProcessController {
  const linux =
    platform === "linux" ? AcpSessionRuntime.makePosixProcessTreeController(platform) : undefined;
  // Start ticks repeat after reboot. Including boot id keeps power-loss records safe.
  const boot = linux ? NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "";
  return {
    ...(linux
      ? {
          identity: (pid: number) => {
            const p = linux.identity(pid);
            return p
              ? {
                  pid,
                  ppid: p.ppid,
                  pgid: p.pgid,
                  startTime: `${boot}:${p.startTime}`,
                  zombie: AcpSessionRuntime.posixProcessIsZombie(p),
                }
              : undefined;
          },
        }
      : {}),
    snapshot: async () => {
      if (linux)
        return linux.snapshot().map((p) => ({
          pid: p.pid,
          ppid: p.ppid,
          pgid: p.pgid,
          startTime: `${boot}:${p.startTime}`,
          zombie: AcpSessionRuntime.posixProcessIsZombie(p),
        }));
      if (platform === "darwin") {
        const { stdout: output } = await execFile(
          "/bin/ps",
          ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
          {
            encoding: "utf8",
            timeout: 5_000,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...environment, LC_ALL: "C", TZ: "UTC" },
          },
        );
        return output.split("\n").flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
          return match
            ? [
                {
                  pid: Number(match[1]),
                  ppid: Number(match[2]),
                  pgid: Number(match[3]),
                  zombie: match[4]!.startsWith("Z"),
                  startTime: match[5]!,
                },
              ]
            : [];
        });
      }
      if (platform === "win32") {
        const output = NodeChildProcess.execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -and $_.ProcessId -gt 0 } | ForEach-Object { @{pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; pgid=0; startTime=$_.CreationDate.ToUniversalTime().Ticks.ToString(); zombie=$false} }) | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        );
        return decodeProcessTable(JSON.parse(output));
      }
      throw new Error(`Provider process ownership is unsupported on ${platform}`);
    },
    signal: (pid, signal) => {
      process.kill(pid, signal);
    },
    exists: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause) {
        return (cause as NodeJS.ErrnoException).code !== "ESRCH";
      }
    },
  };
}

function creationTime(identity: Identity): bigint | undefined {
  const ticks = identity.startTime.split(":").at(-1)!;
  if (/^\d+$/.test(ticks)) return BigInt(ticks);
  const parsed = Date.parse(`${identity.startTime} UTC`);
  return Number.isFinite(parsed) ? BigInt(parsed) : undefined;
}

/** Admits descendants only through a live, matching identity, or its still-owned private process group. */
function discover(entry: Entry, table: ReadonlyArray<ObservedProcess>): Entry {
  const found = new Map(entry.processes.map((p) => [`${p.pid}:${p.startTime}`, p]));
  const live = table.filter((p) => !p.zombie && entry.processes.some((owned) => same(owned, p)));
  const groups = new Set(
    live
      .filter(
        (p) =>
          p.pgid > 0 && entry.processes.some((owned) => owned.pgid > 0 && owned.pgid === p.pgid),
      )
      .map((p) => p.pgid),
  );
  const parents = new Map(live.map((p) => [p.pid, p]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of table) {
      if (p.zombie || found.has(`${p.pid}:${p.startTime}`)) continue;
      const parent = parents.get(p.ppid);
      const parentBirth = parent ? creationTime(parent) : undefined;
      const childBirth = creationTime(p);
      const childOfParent =
        parent !== undefined &&
        (parentBirth === undefined || childBirth === undefined || childBirth >= parentBirth);
      if (!childOfParent && !groups.has(p.pgid)) continue;
      found.set(`${p.pid}:${p.startTime}`, {
        pid: p.pid,
        startTime: p.startTime,
        pgid: groups.has(p.pgid) ? p.pgid : 0,
      });
      parents.set(p.pid, p);
      changed = true;
    }
  }
  return { ...entry, processes: [...found.values()] };
}

/** One instance's local children only. External servers, launchers and install supervisors never register. */
export const make = Effect.fn("ProviderProcessLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
  readonly controller?: ProcessController;
  /** Host install lease directory. Its supervisor's process group is never stopped. */
  readonly installLeaseDirectory?: string;
}) {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const controller = input.controller ?? controllerFor(platform, environment);
  const directory = NodePath.join(input.stateDir, "provider-processes");
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hostname = yield* HostProcess.Hostname;
  const ownerPid = input.ownerPid ?? process.pid;
  const owner = (yield* Effect.promise(async () => controller.snapshot())).find(
    (p) => p.pid === ownerPid && !p.zombie,
  );
  if (!owner) throw new Error("Could not identify the provider process owner");
  const instanceId = NodeCrypto.randomUUID();
  const tracked = new Map<string, Entry>();
  const write = (file: string, entry: Entry) => {
    const temporary = `${file}.tmp`;
    NodeFS.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
    NodeFS.renameSync(temporary, file);
  };
  const survivors = (entry: Entry, table: ReadonlyArray<ObservedProcess>) =>
    table.filter((p) => !p.zombie && entry.processes.some((owned) => same(owned, p)));
  const refresh = async () => {
    if (tracked.size === 0) return;
    const table = await controller.snapshot();
    for (const [file, entry] of tracked) {
      const discovered = discover(entry, table);
      const next = {
        ...discovered,
        processes: discovered.processes.filter(
          (p) =>
            table.some((observed) => same(p, observed) && !observed.zombie) ||
            (!table.some((observed) => observed.pid === p.pid) && controller.exists(p.pid)),
        ),
      };
      if (next.processes.length === 0) {
        NodeFS.rmSync(file, { force: true });
        tracked.delete(file);
      } else if (JSON.stringify(next.processes) !== JSON.stringify(entry.processes)) {
        write(file, next);
        tracked.set(file, next);
      }
    }
  };
  const signal = async (p: Identity, signal: NodeJS.Signals) => {
    // Refresh immediately before each signal, including escalation. Never signal by group id or taskkill /t.
    const observed = controller.identity
      ? controller.identity(p.pid)
      : (await controller.snapshot()).find((candidate) => candidate.pid === p.pid);
    if (!observed || observed.zombie || !same(p, observed)) return;
    try {
      controller.signal(p.pid, signal);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  };
  // A server started from a provider or terminal can descend from it with its own
  // detached install supervisor. Stopping that group would corrupt a shared CLI.
  const withoutInstaller = (entry: Entry, table: ReadonlyArray<ObservedProcess>): Entry => {
    if (input.installLeaseDirectory === undefined) return entry;
    let leader: number;
    try {
      leader = Number(NodeFS.readFileSync(installLeasePath(input.installLeaseDirectory), "utf8"));
    } catch {
      return entry;
    }
    if (!Number.isSafeInteger(leader) || leader <= 0) return entry;
    // Windows has no process groups, so its installer is found through parents.
    const installer = new Set([leader]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of table) {
        if (!installer.has(p.pid) && (p.pgid === leader || installer.has(p.ppid))) {
          installer.add(p.pid);
          changed = true;
        }
      }
    }
    return {
      ...entry,
      processes: entry.processes.filter(
        (p) => !table.some((observed) => installer.has(observed.pid) && same(p, observed)),
      ),
    };
  };
  const reap = (file: string, entry: Entry) =>
    Effect.gen(function* () {
      let table = yield* Effect.promise(async () => controller.snapshot());
      const liveOwner = table.find((p) => same(entry.owner, p));
      if (liveOwner && !liveOwner.zombie) return;
      // A restricted/failed process query cannot establish that an owner died.
      if (
        !liveOwner &&
        !table.some((p) => p.pid === entry.owner.pid) &&
        controller.exists(entry.owner.pid)
      ) {
        throw new Error("Could not verify the recorded provider owner");
      }
      let next = withoutInstaller(discover(entry, table), table);
      if (platform !== "win32") {
        // Freeze to a fixed point. A child may fork while its parent is being stopped.
        const stopped = new Set<string>();
        for (let attempt = 0; attempt < 100; attempt++) {
          const pending = survivors(next, table).filter(
            (p) => !stopped.has(`${p.pid}:${p.startTime}`),
          );
          if (pending.length === 0) break;
          for (const p of pending) {
            yield* Effect.promise(() => signal(p, "SIGSTOP"));
            stopped.add(`${p.pid}:${p.startTime}`);
          }
          table = yield* Effect.promise(async () => controller.snapshot());
          next = withoutInstaller(discover(next, table), table);
          if (attempt === 99) throw new Error("Provider process tree did not stop for cleanup");
        }
      }
      // Persist newly discovered children before signalling: recovery can itself be killed.
      write(file, next);
      for (const p of survivors(
        next,
        yield* Effect.promise(async () => controller.snapshot()),
      ).toReversed())
        yield* Effect.promise(() => signal(p, "SIGKILL"));
      for (let attempt = 0; attempt < 100; attempt++) {
        table = yield* Effect.promise(async () => controller.snapshot());
        if (
          next.processes.some(
            (p) => !table.some((observed) => observed.pid === p.pid) && controller.exists(p.pid),
          )
        ) {
          throw new Error("Could not verify a recorded provider process");
        }
        if (survivors(next, table).length === 0) {
          NodeFS.rmSync(file, { force: true });
          return;
        }
        yield* Effect.sleep("20 millis");
      }
      throw new Error("Recorded provider processes did not stop");
    });
  // Await every reap before exposing the spawn hook, and therefore before restart recovery launches work.
  for (const name of NodeFS.readdirSync(directory)) {
    if (!/^[\da-f-]+\.json$/.test(name)) continue;
    const file = NodePath.join(directory, name);
    let entry: Entry;
    try {
      entry = decodeEntry(NodeFS.readFileSync(file, "utf8"));
    } catch (cause) {
      // Records are not fsynced, so power loss can leave an empty one. It names
      // no process to reap, and keeping it would fail every later startup.
      yield* Effect.logWarning("Discarding an unreadable provider process record", { cause });
      NodeFS.rmSync(file, { force: true });
      continue;
    }
    if (entry.hostname !== hostname || entry.stateDir !== input.stateDir) {
      NodeFS.rmSync(file, { force: true });
      continue;
    }
    yield* reap(file, entry);
  }
  const track = (pid: number) =>
    Effect.promise(async () => {
      const table = await controller.snapshot();
      const root =
        table.find((p) => p.pid === pid && !p.zombie) ??
        table.find((p) => p.pgid === pid && !p.zombie);
      if (!root) return;
      // Process groups shared with the server are never a source of ownership.
      const entry = discover(
        {
          version: 1,
          instanceId,
          hostname,
          stateDir: input.stateDir,
          owner: { pid: owner.pid, startTime: owner.startTime },
          processes: [
            { pid: root.pid, startTime: root.startTime, pgid: root.pgid === pid ? pid : 0 },
          ],
        },
        table,
      );
      const file = NodePath.join(directory, `${instanceId}-${pid}.json`);
      try {
        write(file, entry);
        tracked.set(file, entry);
      } catch (cause) {
        for (const child of entry.processes.toReversed()) await signal(child, "SIGKILL");
        throw cause;
      }
    });
  yield* Effect.forever(
    Effect.sleep("1 second").pipe(
      Effect.andThen(
        Effect.tryPromise(refresh).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not record provider descendants", { cause }),
          ),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);
  // Leave surviving entries for the next startup. A graceful provider stop makes refresh remove them.
  yield* Effect.addFinalizer(() => Effect.tryPromise(refresh).pipe(Effect.ignore));
  return { track };
});
