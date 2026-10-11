// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off -- Standalone launcher shares this Node-only process ownership core.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

interface Identity {
  readonly pid: number;
  readonly startTime: string;
}
interface OwnedProcess extends Identity {
  readonly pgid: number;
}
interface Entry {
  readonly version: 1;
  readonly instanceId: string;
  readonly hostname: string;
  readonly stateDir: string;
  readonly owner: Identity;
  readonly processes: ReadonlyArray<OwnedProcess>;
}
interface ObservedProcess extends OwnedProcess {
  readonly ppid: number;
  readonly zombie: boolean;
}
export interface ProcessController {
  readonly snapshot: () => ReadonlyArray<ObservedProcess> | Promise<ReadonlyArray<ObservedProcess>>;
  readonly identity?: (pid: number) => ObservedProcess | undefined;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly exists: (pid: number) => boolean;
}
const same = (a: Identity, b: Identity) => a.pid === b.pid && a.startTime === b.startTime;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const identity = (value: unknown): value is Identity =>
  object(value) &&
  Number.isSafeInteger(value.pid) &&
  Number(value.pid) > 0 &&
  typeof value.startTime === "string" &&
  value.startTime.length > 0;
const owned = (value: unknown): value is OwnedProcess =>
  identity(value) && "pgid" in value && Number.isSafeInteger(value.pgid);
function decodeEntry(text: string): Entry {
  const value: unknown = JSON.parse(text);
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.instanceId !== "string" ||
    !value.instanceId ||
    typeof value.hostname !== "string" ||
    typeof value.stateDir !== "string" ||
    !identity(value.owner) ||
    !Array.isArray(value.processes) ||
    !value.processes.every(owned)
  )
    throw new Error("Invalid provider process record");
  return value as unknown as Entry;
}
function decodeProcessTable(value: unknown): ReadonlyArray<ObservedProcess> {
  if (
    !Array.isArray(value) ||
    !value.every(
      (p: unknown) =>
        owned(p) &&
        "ppid" in p &&
        Number.isSafeInteger(p.ppid) &&
        "zombie" in p &&
        typeof p.zombie === "boolean",
    )
  )
    throw new Error("Invalid process table");
  return value as ReadonlyArray<ObservedProcess>;
}

/** Linux boot/start ticks, macOS ps and Windows CIM supply creation identities. */
function controllerFor(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ProcessController {
  const boot =
    platform === "linux"
      ? NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      : "";
  const parseLinux = (pid: number, stat: string): ObservedProcess => {
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return {
      pid,
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      startTime: `${boot}:${fields[19]}`,
      zombie: fields[0] === "Z" || fields[0] === "X",
    };
  };
  return {
    ...(platform === "linux"
      ? {
          identity: (pid: number) => {
            try {
              return parseLinux(pid, NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8"));
            } catch {
              return undefined;
            }
          },
        }
      : {}),
    snapshot: async () => {
      if (platform === "linux") {
        const pids = (await NodeFSP.readdir("/proc")).filter((name) => /^[1-9][0-9]*$/.test(name));
        const table: Array<ObservedProcess> = [];
        // Bound concurrent reads without blocking the server on the whole process table.
        for (let offset = 0; offset < pids.length; offset += 32) {
          const rows = await Promise.all(
            pids.slice(offset, offset + 32).map(async (name) => {
              try {
                return parseLinux(
                  Number(name),
                  await NodeFSP.readFile(`/proc/${name}/stat`, "utf8"),
                );
              } catch {
                return undefined;
              }
            }),
          );
          for (const row of rows) if (row) table.push(row);
        }
        return table;
      }
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
        const { stdout: output } = await execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -and $_.ProcessId -gt 0 } | ForEach-Object { @{pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; pgid=0; startTime=$_.CreationDate.ToUniversalTime().Ticks.ToString(); zombie=$false} }) | ConvertTo-Json -Compress",
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            env: environment,
          },
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

/** Node-only core shared with the launcher, including older-runtime fallback. */
export async function make(input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
  readonly controller?: ProcessController;
  readonly installLeaseDirectory?: string;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly hostname: string;
}) {
  const { platform, environment, hostname } = input;
  const controller = input.controller ?? controllerFor(platform, environment);
  const directory = NodePath.join(input.stateDir, "provider-processes");
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ownerPid = input.ownerPid ?? process.pid;
  const owner = (await controller.snapshot()).find((p) => p.pid === ownerPid && !p.zombie);
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
      leader = Number(
        NodeFS.readFileSync(NodePath.join(input.installLeaseDirectory, "install.json"), "utf8"),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return entry;
      throw cause;
    }
    if (!Number.isSafeInteger(leader) || leader <= 0)
      throw new Error("Invalid provider install lease");
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
  const reap = async (file: string, entry: Entry) => {
    let table = await controller.snapshot();
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
          await signal(p, "SIGSTOP");
          stopped.add(`${p.pid}:${p.startTime}`);
        }
        table = await controller.snapshot();
        next = withoutInstaller(discover(next, table), table);
        if (attempt === 99) throw new Error("Provider process tree did not stop for cleanup");
      }
    }
    // Persist newly discovered children before signalling: recovery can itself be killed.
    write(file, next);
    for (const p of survivors(next, await controller.snapshot()).toReversed())
      await signal(p, "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt++) {
      table = await controller.snapshot();
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Recorded provider processes did not stop");
  };
  // Await every reap before exposing the spawn hook, and therefore before restart recovery launches work.
  for (const name of NodeFS.readdirSync(directory)) {
    if (!/^[\da-f-]+\.json$/.test(name)) continue;
    const file = NodePath.join(directory, name);
    let entry: Entry;
    try {
      entry = decodeEntry(NodeFS.readFileSync(file, "utf8"));
    } catch {
      // Records are not fsynced, so power loss can leave an empty one. It names
      // no process to reap, and keeping it would fail every later startup.
      NodeFS.rmSync(file, { force: true });
      continue;
    }
    if (entry.hostname !== hostname || entry.stateDir !== input.stateDir) {
      NodeFS.rmSync(file, { force: true });
      continue;
    }
    await reap(file, entry);
  }
  let pendingSnapshot: Promise<ReadonlyArray<ObservedProcess>> | undefined;
  const spawnSnapshot = () => {
    pendingSnapshot ??= Promise.resolve()
      .then(() => controller.snapshot())
      .finally(() => {
        pendingSnapshot = undefined;
      });
    return pendingSnapshot;
  };
  const track = async (pid: number) => {
    const direct = controller.identity?.(pid);
    const table = direct && !direct.zombie ? [direct] : await spawnSnapshot();
    const root =
      table.find((p) => p.pid === pid && !p.zombie) ??
      table.find((p) => p.pgid === pid && !p.zombie);
    if (!root) return;
    // Process groups shared with the server are never a source of ownership.
    let entry = discover(
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
      if (direct) {
        // Persist the root before awaiting I/O, then capture its initial children.
        entry = discover(entry, await spawnSnapshot());
        write(file, entry);
        tracked.set(file, entry);
      }
    } catch (cause) {
      // The first root write may fail before the initial descendant query.
      try {
        entry = discover(entry, await spawnSnapshot());
      } catch {
        /* Still stop the identities already established. */
      }
      for (const child of entry.processes.toReversed()) await signal(child, "SIGKILL");
      throw cause;
    }
  };
  return { track, refresh };
}
