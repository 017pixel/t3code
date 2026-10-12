// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import * as ProviderProcessLedger from "./ProviderProcessLedger.ts";
import * as OwnedProcesses from "./ownedProcesses.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";
import { agentSliceMemoryLimits, classifyScope, make, type ScopeState } from "./agentScope.ts";

const GiB = 1024 ** 3;

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    // The agent pipe can close before systemd handles the kill.
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });

  it("does not wait on a live agent or a scope that ended for another reason", () => {
    expect(classifyScope(running)).toBe("running");
    expect(classifyScope({ ...running, activeState: "inactive", populated: undefined })).toBe(
      "gone",
    );
    expect(classifyScope({ ...running, loadState: "not-found", activeState: "inactive" })).toBe(
      "gone",
    );
  });
});

describe("agentSliceMemoryLimits", () => {
  it("leaves 6 GB before throttling and 4 GB before a kill on large machines", () => {
    expect(agentSliceMemoryLimits(64 * GiB)).toEqual({ high: 58 * GiB, max: 60 * GiB });
  });

  it("still gives agents most of a small machine", () => {
    expect(agentSliceMemoryLimits(8 * GiB)).toEqual({ high: 4 * GiB, max: 6 * GiB });
  });
});

// Runs the real service against a fake user manager. `units` holds the
// ActiveState and Result that `systemctl show` reports for each scope.
const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, { activeState: string; result: string }>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const units = new Map<string, { activeState: string; result: string }>();
    const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        Effect.sync(() => {
          const [, verb, unit = ""] = args;
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n`,
          );
        }),
    });
    const scope = yield* make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
    );
    return yield* body({ scope, units }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const unitOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";

describe("AgentScope service", () => {
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        // The older scope was OOM-killed, but the newest one is still running.
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        // A retried failure reads the same, even after the failed unit is reset.
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        // The next session may run without a scope, for example on Cursor.
        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("live")).toBe(true);
      }),
    ),
  );
});

// The controller models creation identities, including PID reuse and reparenting after a crash.
describe("provider process restart ownership", () => {
  const scenario = (
    body: (input: {
      directory: string;
      processes: Map<
        number,
        { pid: number; ppid: number; pgid: number; startTime: string; zombie: boolean }
      >;
      signals: Array<string>;
      controller: ProviderProcessLedger.ProcessController;
    }) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-ledger-"));
      const processes = new Map([
        [10, { pid: 10, ppid: 1, pgid: 10, startTime: "owner", zombie: false }],
        [20, { pid: 20, ppid: 10, pgid: 20, startTime: "provider", zombie: false }],
        [30, { pid: 30, ppid: 20, pgid: 20, startTime: "child", zombie: false }],
        [90, { pid: 90, ppid: 1, pgid: 90, startTime: "next-owner", zombie: false }],
      ]);
      const signals: Array<string> = [];
      const controller: ProviderProcessLedger.ProcessController = {
        snapshot: () => [...processes.values()],
        exists: (pid) => processes.has(pid),
        signal: (pid, signal) => {
          signals.push(`${pid}:${signal}`);
          if (signal === "SIGKILL") processes.delete(pid);
        },
      };
      try {
        yield* body({ directory, processes, signals, controller });
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    });
  const record = (directory: string, controller: ProviderProcessLedger.ProcessController) =>
    ProviderProcessLedger.make({ stateDir: directory, ownerPid: 10, controller }).pipe(
      Effect.tap((ledger) => ledger.track(20)),
      Effect.scoped,
    );
  const restart = (directory: string, controller: ProviderProcessLedger.ProcessController) =>
    ProviderProcessLedger.make({ stateDir: directory, ownerPid: 90, controller }).pipe(
      Effect.scoped,
    );

  it.effect("samples all tracked trees once per 30 seconds, not once per second", () =>
    scenario(({ directory, controller }) =>
      Effect.gen(function* () {
        let snapshots = 0;
        const counted = {
          ...controller,
          snapshot: () => {
            snapshots++;
            return controller.snapshot();
          },
        };
        const ledger = yield* ProviderProcessLedger.make({
          stateDir: directory,
          ownerPid: 10,
          controller: counted,
        });
        yield* ledger.track(20);
        const initial = snapshots;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("29 seconds");
        expect(snapshots).toBe(initial);
        yield* TestClock.adjust("1 second");
        expect(snapshots).toBe(initial + 1);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("shares one process query between concurrent spawn registrations", () =>
    scenario(({ directory, controller }) =>
      Effect.gen(function* () {
        let snapshots = 0;
        let pending: Promise<Awaited<ReturnType<typeof controller.snapshot>>> | undefined;
        const counted = {
          ...controller,
          snapshot: () => {
            snapshots++;
            return pending ?? controller.snapshot();
          },
        };
        const ledger = yield* ProviderProcessLedger.make({
          stateDir: directory,
          ownerPid: 10,
          controller: counted,
        });
        const query = Promise.withResolvers<Awaited<ReturnType<typeof controller.snapshot>>>();
        pending = query.promise;
        const registrations = yield* Effect.all([ledger.track(20), ledger.track(30)], {
          concurrency: "unbounded",
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        query.resolve(yield* Effect.promise(async () => controller.snapshot()));
        yield* Fiber.join(registrations);
        expect(snapshots).toBe(2); // Owner query plus one shared spawn query.
        pending = undefined;
      }).pipe(Effect.scoped),
    ),
  );

  it.effect.each(["table", "job"] as const)(
    "keeps the server responsive while a Windows %s query is pending",
    (query) =>
      scenario(({ directory, processes, controller }) =>
        Effect.gen(function* () {
          const started = NodePath.join(directory, "query-started");
          const released = NodePath.join(directory, "query-release");
          const executable = NodePath.join(directory, "powershell.exe");
          const leases = NodePath.join(directory, "leases");
          if (query === "job") {
            processes.set(71, {
              pid: 71,
              ppid: 20,
              pgid: 0,
              startTime: "installer",
              zombie: false,
            });
            yield* record(directory, controller);
            processes.delete(10);
            processes.set(71, { ...processes.get(71)!, ppid: 1 });
            NodeFS.mkdirSync(leases);
            NodeFS.writeFileSync(
              NodePath.join(leases, "install.json"),
              JSON.stringify({ pid: 70, job: "t3-provider-install-abcd", descendants: [] }),
            );
          }
          // Stand in for CIM with a real child blocked on the server's acknowledgement.
          NodeFS.writeFileSync(
            executable,
            `#!${process.execPath}
const fs = require("node:fs");
if (${JSON.stringify(query)} === "job" && !process.argv.some(arg => arg.includes("T3InstallJob"))) {
  process.stdout.write(${JSON.stringify(JSON.stringify([...processes.values()]))});
  process.exit(0);
}
const finish = () => {
  if (!fs.existsSync(${JSON.stringify(released)})) return;
  process.stdout.write(${JSON.stringify(query === "job" ? "71\n" : JSON.stringify([...processes.values()]))});
  watcher.close();
};
const watcher = fs.watch(${JSON.stringify(directory)}, finish);
fs.writeFileSync(${JSON.stringify(started)}, "queried");
finish();
`,
            { mode: 0o700 },
          );
          const queried = Promise.withResolvers<void>();
          const watcher = NodeFS.watch(directory, () => {
            if (NodeFS.existsSync(started)) queried.resolve();
          });
          vi.stubEnv("PATH", `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`);
          try {
            const fiber = yield* ProviderProcessLedger.make({
              stateDir: directory,
              ownerPid: query === "job" ? 90 : 10,
              ...(query === "job" ? { controller, installLeaseDirectory: leases } : {}),
            }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.forkScoped);
            yield* Effect.promise(() => queried.promise);
            // The server must be able to acknowledge the query before it returns.
            NodeFS.writeFileSync(released, "responsive");
            yield* Fiber.join(fiber);
            expect(NodeFS.readFileSync(released, "utf8")).toBe("responsive");
          } finally {
            watcher.close();
            vi.unstubAllEnvs();
          }
        }).pipe(Effect.scoped),
      ),
  );

  it.effect("reaps an orphan provider and its forked children before exposing the spawn hook", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.delete(10);
        yield* restart(directory, controller);
        expect(processes.has(20)).toBe(false);
        expect(processes.has(30)).toBe(false);
        expect(signals.filter((s) => s.endsWith("SIGKILL"))).toEqual(["30:SIGKILL", "20:SIGKILL"]);
        expect(NodeFS.readdirSync(NodePath.join(directory, "provider-processes"))).toEqual([]);
      }),
    ),
  );
  it.effect("resumes a provider tree it froze when cleanup cannot finish", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.delete(10);
        // Each stopped process forks again, so the tree never reaches a fixed point.
        let nextPid = 1000;
        const forking: ProviderProcessLedger.ProcessController = {
          ...controller,
          signal: (pid, signal) => {
            controller.signal(pid, signal);
            if (signal !== "SIGSTOP") return;
            const child = nextPid++;
            processes.set(child, {
              pid: child,
              ppid: pid,
              pgid: 20,
              startTime: `fork-${child}`,
              zombie: false,
            });
          },
        };
        yield* Effect.exit(restart(directory, forking));
        const stopped = signals.filter((s) => s.endsWith(":SIGSTOP")).map((s) => s.split(":")[0]);
        const resumed = signals.filter((s) => s.endsWith(":SIGCONT")).map((s) => s.split(":")[0]);
        expect(stopped.length).toBeGreaterThan(0);
        expect(resumed.toSorted()).toEqual(stopped.toSorted());
        expect(signals.some((s) => s.endsWith(":SIGKILL"))).toBe(false);
      }),
    ),
  );
  it.effect.each(["owner", "managed-owner", "launcher", "handoff"] as const)(
    "resumes frozen providers when the final server protection query cannot verify a live %s",
    (missing) =>
      scenario(({ directory, processes, signals, controller }) =>
        Effect.gen(function* () {
          yield* record(directory, controller);
          const leases = NodePath.join(directory, "leases");
          const managed = missing !== "owner";
          if (managed)
            processes.set(60, {
              pid: 60,
              ppid: 1,
              pgid: 60,
              startTime: "launcher",
              zombie: false,
            });
          processes.set(70, {
            pid: 70,
            ppid: managed ? 60 : 1,
            pgid: 70,
            startTime: "live-server",
            zombie: false,
          });
          const second = ProviderProcessLedger.make({
            stateDir: NodePath.join(directory, "second"),
            ownerPid: 70,
            controller,
            installLeaseDirectory: leases,
          });
          yield* managed
            ? second.pipe(
                Effect.provideService(HostProcess.Environment, {
                  [SERVICE_LAUNCHER_CONTEXT_ENV]: "managed",
                }),
              )
            : second;
          if (missing === "handoff") processes.delete(70);
          processes.delete(10);
          let frozenQueries = 0;
          const result = yield* ProviderProcessLedger.make({
            stateDir: directory,
            ownerPid: 90,
            installLeaseDirectory: leases,
            controller: {
              ...controller,
              identity: (pid) => processes.get(pid),
              snapshot: () => {
                if (signals.filter((signal) => signal.endsWith(":SIGSTOP")).length === 2)
                  frozenQueries++;
                const hidden = missing === "owner" || missing === "managed-owner" ? 70 : 60;
                return [...processes.values()].filter((p) => frozenQueries < 2 || p.pid !== hidden);
              },
            },
          }).pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
          expect(signals).toEqual(["20:SIGSTOP", "30:SIGSTOP", "20:SIGCONT", "30:SIGCONT"]);
          expect(processes.has(20)).toBe(true);
          expect(processes.has(30)).toBe(true);
        }).pipe(Effect.scoped),
      ),
  );
  it.effect("leaves every child of a live owning server alone", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        yield* restart(directory, controller);
        expect(signals).toEqual([]);
        expect(processes.has(20)).toBe(true);
        expect(NodeFS.readdirSync(NodePath.join(directory, "provider-processes"))).toHaveLength(1);
      }),
    ),
  );
  it.effect("does not signal a reused provider pid or admit its new descendants", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.delete(10);
        processes.delete(30);
        processes.set(20, { ...processes.get(20)!, startTime: "reused" });
        processes.set(40, {
          pid: 40,
          ppid: 20,
          pgid: 20,
          startTime: "unrelated-child",
          zombie: false,
        });
        yield* restart(directory, controller);
        expect(signals).toEqual([]);
        expect(processes.has(40)).toBe(true);
      }),
    ),
  );
  it.effect("a reused owner pid cannot pin an orphan", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.set(10, { ...processes.get(10)!, startTime: "reused-owner" });
        yield* restart(directory, controller);
        expect(signals).not.toContain("10:SIGKILL");
        expect(processes.has(20)).toBe(false);
      }),
    ),
  );
  it.effect("retains ownership when a shell wrapper exits and its child is reparented", () =>
    scenario(({ directory, processes, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.delete(10);
        processes.delete(20);
        processes.set(30, { ...processes.get(30)!, ppid: 1 });
        processes.set(40, { pid: 40, ppid: 1, pgid: 20, startTime: "later-fork", zombie: false });
        yield* restart(directory, controller);
        expect(processes.has(30)).toBe(false);
        expect(processes.has(40)).toBe(false);
      }),
    ),
  );
  it.effect("records a private group even if the wrapper exits before registration", () =>
    scenario(({ directory, processes, controller }) =>
      Effect.gen(function* () {
        processes.delete(20);
        processes.set(30, { ...processes.get(30)!, ppid: 1 });
        yield* record(directory, controller);
        processes.delete(10);
        yield* restart(directory, controller);
        expect(processes.has(30)).toBe(false);
      }),
    ),
  );
  it.effect(
    "never owns unrelated siblings, an external server, launcher or install supervisor",
    () =>
      scenario(({ directory, processes, signals, controller }) =>
        Effect.gen(function* () {
          processes.set(50, { pid: 50, ppid: 10, pgid: 10, startTime: "installer", zombie: false });
          processes.set(60, { pid: 60, ppid: 1, pgid: 60, startTime: "external", zombie: false });
          yield* record(directory, controller);
          processes.delete(10);
          yield* restart(directory, controller);
          expect(processes.has(50)).toBe(true);
          expect(processes.has(60)).toBe(true);
          expect(processes.has(90)).toBe(true);
          expect(signals.some((s) => /^(50|60|90):/.test(s))).toBe(false);
        }),
      ),
  );
  it.effect.each([
    { platform: "linux", lease: "legacy" },
    { platform: "win32", lease: "legacy" },
    { platform: "linux", lease: "structured" },
    { platform: "win32", lease: "structured" },
    { platform: "linux", lease: "orphan" },
    { platform: "win32", lease: "orphan" },
    { platform: "linux", lease: "reused" },
    { platform: "win32", lease: "reused" },
    { platform: "linux", lease: "root-reused" },
    { platform: "win32", lease: "root-reused" },
    { platform: "linux", lease: "group" },
    { platform: "linux", lease: "late" },
    { platform: "win32", lease: "job" },
    { platform: "win32", lease: "job-failed" },
  ] as const)(
    "protects a nested installer on $platform with a $lease lease",
    ({ platform, lease }) =>
      scenario(({ directory, processes, signals, controller }) =>
        Effect.gen(function* () {
          // A server launched from the provider started an install that outlives it.
          const childIdentity = platform === "win32" ? "2026-10-11T20:00:00.1234567Z" : "boot:123";
          const childStart = platform === "win32" ? "639273456001234567" : childIdentity;
          const rootReused = lease === "root-reused";
          processes.set(70, {
            pid: 70,
            ppid: 20,
            pgid: 70,
            startTime: rootReused ? "replacement" : "supervisor",
            zombie: false,
          });
          const reused = lease === "reused" || rootReused;
          processes.set(71, {
            pid: 71,
            ppid: 70,
            pgid: 70,
            startTime: reused
              ? platform === "win32"
                ? "639273456001234568"
                : "replacement"
              : childStart,
            zombie: false,
          });
          if (platform === "win32")
            for (const [pid, p] of processes) processes.set(pid, { ...p, pgid: 0 });
          yield* record(directory, controller);
          processes.delete(10);
          processes.set(70, { ...processes.get(70)!, ppid: 1 });
          const job = lease === "job" || lease === "job-failed";
          const orphan = lease === "orphan" || lease === "reused" || lease === "group" || job;
          if (orphan) {
            processes.delete(70);
            processes.set(71, {
              ...processes.get(71)!,
              ppid: 1,
              pgid: platform === "win32" ? 0 : lease === "group" ? 70 : 71,
            });
          }
          const leases = NodePath.join(directory, "leases");
          NodeFS.mkdirSync(leases);
          const contents =
            lease === "legacy"
              ? "70"
              : JSON.stringify({
                  pid: 70,
                  identity: "supervisor",
                  ...(job ? { job: "t3-provider-install-abcd" } : {}),
                  descendants:
                    job || rootReused || lease === "group"
                      ? []
                      : [{ pid: 71, identity: childIdentity }],
                });
          const installLease = NodePath.join(leases, "install.json");
          if (lease !== "late") NodeFS.writeFileSync(installLease, contents);
          if (job)
            NodeFS.writeFileSync(
              NodePath.join(directory, "powershell.exe"),
              `#!${process.execPath}\nprocess.stdout.write("71\\n"); process.exit(${lease === "job-failed" ? 1 : 0});\n`,
              { mode: 0o700 },
            );
          const result = yield* ProviderProcessLedger.make({
            stateDir: directory,
            ownerPid: 90,
            controller:
              lease === "late"
                ? {
                    ...controller,
                    snapshot: () => {
                      if (signals.includes("70:SIGSTOP"))
                        NodeFS.writeFileSync(installLease, contents);
                      return controller.snapshot();
                    },
                  }
                : controller,
            installLeaseDirectory: leases,
          }).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Environment, {
              ...process.env,
              PATH: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
            }),
            Effect.scoped,
            Effect.exit,
          );
          expect(result._tag).toBe(lease === "job-failed" ? "Failure" : "Success");
          if (lease === "job-failed") {
            expect(signals).toEqual([]);
            return;
          }
          expect(processes.has(20)).toBe(false);
          expect(processes.has(70)).toBe(!orphan && !rootReused);
          expect(processes.has(71)).toBe(!reused);
          if (reused) expect(signals).toContain("71:SIGKILL");
          else if (lease === "late") {
            for (const pid of [70, 71]) {
              expect(signals).toContain(`${pid}:SIGSTOP`);
              expect(signals).toContain(`${pid}:SIGCONT`);
              expect(signals).not.toContain(`${pid}:SIGKILL`);
            }
          } else expect(signals.some((s) => /^(70|71):/.test(s))).toBe(false);
        }),
      ),
  );
  it.effect.each(["empty", "corrupt", "unreadable"] as const)(
    "refuses orphan cleanup when the install lease is %s",
    (mode) =>
      scenario(({ directory, processes, signals, controller }) =>
        Effect.gen(function* () {
          processes.set(70, {
            pid: 70,
            ppid: 20,
            pgid: 70,
            startTime: "supervisor",
            zombie: false,
          });
          processes.set(71, { pid: 71, ppid: 70, pgid: 70, startTime: "installer", zombie: false });
          yield* record(directory, controller);
          processes.delete(10);
          const leases = NodePath.join(directory, "leases");
          NodeFS.mkdirSync(leases);
          const lease = NodePath.join(leases, "install.json");
          if (mode === "unreadable") NodeFS.mkdirSync(lease);
          else NodeFS.writeFileSync(lease, mode === "empty" ? "" : "70 partial");
          const result = yield* ProviderProcessLedger.make({
            stateDir: directory,
            ownerPid: 90,
            controller,
            installLeaseDirectory: leases,
          }).pipe(Effect.scoped, Effect.exit);
          expect(result._tag).toBe("Failure");
          expect(signals).toEqual([]);
          expect(processes.has(71)).toBe(true);
        }),
      ),
  );
  it.effect("never reaps the replacement server launched from an orphaned terminal", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        processes.set(90, { ...processes.get(90)!, ppid: 20, pgid: 20 });
        processes.set(91, {
          pid: 91,
          ppid: 90,
          pgid: 20,
          startTime: "new-provider",
          zombie: false,
        });
        yield* record(directory, controller);
        processes.delete(10);
        yield* restart(directory, controller);
        expect(processes.has(20)).toBe(false);
        expect(processes.has(90)).toBe(true);
        expect(processes.has(91)).toBe(true);
        expect(signals.some((s) => /^(90|91):/.test(s))).toBe(false);
      }),
    ),
  );
  it.effect.each([
    { platform: "linux", handoff: false },
    { platform: "win32", handoff: false },
    { platform: "linux", handoff: true },
    { platform: "win32", handoff: true },
  ] as const)(
    "preserves another environment's nested server and launcher on $platform, handoff=$handoff",
    ({ platform, handoff }) =>
      scenario(({ directory, processes, signals, controller }) =>
        Effect.gen(function* () {
          for (const [pid, p] of processes)
            processes.set(pid, { ...p, startTime: String(pid * 10) });
          processes.set(60, { pid: 60, ppid: 20, pgid: 60, startTime: "600", zombie: false });
          processes.set(70, {
            pid: 70,
            ppid: 60,
            pgid: 60,
            startTime: "700",
            zombie: false,
          });
          processes.set(71, {
            pid: 71,
            ppid: 70,
            pgid: 71,
            startTime: "800",
            zombie: false,
          });
          processes.set(72, {
            pid: 72,
            ppid: 60,
            pgid: 60,
            startTime: "800",
            zombie: false,
          });
          if (platform === "win32")
            for (const [pid, p] of processes) processes.set(pid, { ...p, pgid: 0 });
          yield* record(directory, controller);
          const leases = NodePath.join(directory, "leases");
          const second = ProviderProcessLedger.make({
            stateDir: NodePath.join(directory, "second"),
            ownerPid: 70,
            controller,
            installLeaseDirectory: leases,
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (handoff) {
                  processes.delete(70);
                  processes.delete(71);
                }
              }),
            ),
            Effect.provideService(HostProcess.Environment, {
              [SERVICE_LAUNCHER_CONTEXT_ENV]: "managed",
            }),
          );
          yield* handoff ? second.pipe(Effect.scoped) : second;
          if (handoff) {
            yield* Effect.promise(() =>
              OwnedProcesses.make({
                stateDir: NodePath.join(directory, "second"),
                ownerPid: 60,
                controller,
                installLeaseDirectory: leases,
                platform,
                environment: {},
                hostname: NodeOS.hostname(),
              }),
            );
            expect(NodeFS.readdirSync(NodePath.join(leases, "servers"))).toHaveLength(1);
          }
          // A stale parent id must not make an older orphan belong to a reused server or launcher.
          processes.set(30, { ...processes.get(30)!, ppid: handoff ? 60 : 70 });
          processes.delete(10);
          if (handoff) {
            const result = yield* ProviderProcessLedger.make({
              stateDir: directory,
              ownerPid: 90,
              installLeaseDirectory: leases,
              controller: {
                ...controller,
                snapshot: () => [...processes.values()].filter((p) => p.pid !== 60),
              },
            }).pipe(Effect.exit);
            expect(result._tag).toBe("Failure");
            expect(signals).toEqual([]);
            expect(processes.has(72)).toBe(true);
          }
          yield* ProviderProcessLedger.make({
            stateDir: directory,
            ownerPid: 90,
            controller,
            installLeaseDirectory: leases,
          });
          expect(processes.has(20)).toBe(false);
          expect(processes.has(30)).toBe(false);
          expect(signals).toContain("30:SIGKILL");
          expect(signals).not.toContain("30:SIGCONT");
          for (const pid of handoff ? [60, 72, 90] : [60, 70, 71, 72, 90])
            expect(processes.has(pid)).toBe(true);
          expect(signals.some((s) => /^(60|70|71|72|90):/.test(s))).toBe(false);
        }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, platform)),
      ),
  );
  it.effect.each(["gone", "reused", "zombie"] as const)(
    "prunes managed server registrations whose owner is %s without dropping live servers",
    (mode) =>
      scenario(({ directory, processes, signals, controller }) =>
        Effect.gen(function* () {
          const leases = NodePath.join(directory, "leases");
          processes.set(60, { pid: 60, ppid: 20, pgid: 60, startTime: "launcher", zombie: false });
          const publish = (pid: number) =>
            Effect.promise(() =>
              OwnedProcesses.make({
                stateDir: NodePath.join(directory, String(pid)),
                ownerPid: pid,
                controller,
                installLeaseDirectory: leases,
                registerServer: true,
                platform: "linux",
                environment: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "managed" },
                hostname: "test-host",
              }),
            );
          processes.set(70, {
            pid: 70,
            ppid: 60,
            pgid: 60,
            startTime: "live-server",
            zombie: false,
          });
          const live = yield* publish(70);
          const liveRegistration = NodePath.join(
            leases,
            "servers",
            NodeFS.readdirSync(NodePath.join(leases, "servers"))[0]!,
          );
          for (let generation = 0; generation < 5; generation++) {
            processes.set(80, {
              pid: 80,
              ppid: 60,
              pgid: 60,
              startTime: String(generation),
              zombie: false,
            });
            const next = yield* publish(80);
            expect(NodeFS.readdirSync(NodePath.join(leases, "servers"))).toHaveLength(2);
            expect(NodeFS.existsSync(liveRegistration)).toBe(true);
            next.release();
            if (mode === "gone") processes.delete(80);
            else
              processes.set(80, {
                ...processes.get(80)!,
                startTime: "reused",
                zombie: mode === "zombie",
              });
          }
          // A launcher handoff retains protection until the replacement publishes.
          yield* publish(90);
          expect(NodeFS.readdirSync(NodePath.join(leases, "servers"))).toHaveLength(2);
          expect(signals).toEqual([]);
          live.release();
        }),
      ),
  );

  it.effect.each(["", "{", "{}"])(
    "discards an invalid server registration %j before recovering orphaned providers",
    (contents) =>
      scenario(({ directory, processes, signals, controller }) =>
        Effect.gen(function* () {
          yield* record(directory, controller);
          const leases = NodePath.join(directory, "leases");
          processes.set(70, {
            pid: 70,
            ppid: 20,
            pgid: 70,
            startTime: "live-server",
            zombie: false,
          });
          processes.set(71, {
            pid: 71,
            ppid: 70,
            pgid: 71,
            startTime: "live-provider",
            zombie: false,
          });
          yield* ProviderProcessLedger.make({
            stateDir: NodePath.join(directory, "second"),
            ownerPid: 70,
            controller,
            installLeaseDirectory: leases,
          });
          const servers = NodePath.join(leases, "servers");
          const liveRegistration = NodePath.join(servers, NodeFS.readdirSync(servers)[0]!);
          const invalid = NodePath.join(servers, "invalid.json");
          NodeFS.writeFileSync(invalid, contents);
          processes.delete(10);
          yield* ProviderProcessLedger.make({
            stateDir: directory,
            ownerPid: 90,
            controller,
            installLeaseDirectory: leases,
          });
          expect(NodeFS.existsSync(invalid)).toBe(false);
          expect(NodeFS.existsSync(liveRegistration)).toBe(true);
          expect(processes.has(20)).toBe(false);
          expect(processes.has(30)).toBe(false);
          expect(signals).toContain("20:SIGKILL");
          expect(processes.has(70)).toBe(true);
          expect(processes.has(71)).toBe(true);
          expect(signals.some((s) => /^(70|71|90):/.test(s))).toBe(false);
        }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "retains a server registration when its live owner is missing from the process query",
    () =>
      scenario(({ directory, processes, controller }) =>
        Effect.gen(function* () {
          const leases = NodePath.join(directory, "leases");
          const input = {
            stateDir: directory,
            ownerPid: 10,
            controller,
            installLeaseDirectory: leases,
          };
          const server = yield* ProviderProcessLedger.make(input);
          yield* ProviderProcessLedger.make({
            ...input,
            stateDir: NodePath.join(directory, "second"),
            ownerPid: 90,
            controller: {
              ...controller,
              snapshot: () => [...processes.values()].filter((p) => p.pid !== 10),
            },
          });
          expect(NodeFS.readdirSync(NodePath.join(leases, "servers"))).toHaveLength(2);
          yield* server.track(20);
        }).pipe(Effect.scoped),
      ),
  );

  it.effect("does not delete a server registration published after the cleanup process query", () =>
    scenario(({ directory, processes, controller }) =>
      Effect.gen(function* () {
        const leases = NodePath.join(directory, "leases");
        const registration = NodePath.join(leases, "servers", "new-server.json");
        processes.set(70, { pid: 70, ppid: 20, pgid: 70, startTime: "old-pid", zombie: false });
        let publishing = 0;
        const ledger = yield* ProviderProcessLedger.make({
          stateDir: directory,
          ownerPid: 10,
          installLeaseDirectory: leases,
          controller: {
            ...controller,
            snapshot: () => {
              const table = [...processes.values()];
              if (publishing > 0 && --publishing === 0) {
                processes.set(70, { ...processes.get(70)!, startTime: "new-server" });
                NodeFS.writeFileSync(
                  registration,
                  JSON.stringify({
                    version: 1,
                    instanceId: "new",
                    hostname: NodeOS.hostname(),
                    stateDir: NodePath.join(directory, "second"),
                    owner: { pid: 70, startTime: "new-server" },
                    processes: [],
                  }),
                );
              }
              return table;
            },
          },
        });
        const records = NodePath.join(directory, "provider-processes");
        NodeFS.rmSync(records, { recursive: true });
        NodeFS.writeFileSync(records, "unwritable");
        publishing = 2;
        expect((yield* ledger.track(20).pipe(Effect.exit))._tag).toBe("Failure");
        expect(processes.has(70)).toBe(true);
        expect(NodeFS.existsSync(registration)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("starts after power loss leaves an empty process record", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.delete(10);
        const records = NodePath.join(directory, "provider-processes");
        NodeFS.writeFileSync(
          NodePath.join(records, "00000000-0000-0000-0000-000000000000-1.json"),
          "",
        );
        yield* restart(directory, controller);
        expect(processes.has(20)).toBe(false);
        expect(signals).toContain("20:SIGKILL");
        expect(NodeFS.readdirSync(records)).toEqual([]);
      }),
    ),
  );
  it.effect("rejects copied state without signalling the original environment", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.delete(10);
        const copied = NodePath.join(directory, "copy");
        NodeFS.cpSync(
          NodePath.join(directory, "provider-processes"),
          NodePath.join(copied, "provider-processes"),
          { recursive: true },
        );
        yield* restart(copied, controller);
        expect(signals).toEqual([]);
        expect(processes.has(20)).toBe(true);
      }),
    ),
  );
  it.effect("does not treat an unreadable living owner as dead", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        const restricted = {
          ...controller,
          snapshot: () => [...processes.values()].filter((p) => p.pid !== 10),
        };
        const result = yield* restart(directory, restricted).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(signals).toEqual([]);
      }),
    ),
  );
  it.effect("windows cleanup checks each identity without taskkill tree selection", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        for (const [pid, p] of processes) processes.set(pid, { ...p, pgid: 0 });
        yield* record(directory, controller);
        processes.delete(10);
        yield* restart(directory, controller).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        );
        expect(signals).toEqual(["30:SIGKILL", "20:SIGKILL"]);
      }),
    ),
  );
  it.effect("rejects Windows stale parent ids from children born before their reused parent", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        for (const [pid, p] of processes)
          processes.set(pid, { ...p, pgid: 0, startTime: String(pid * 100) });
        processes.set(40, { pid: 40, ppid: 20, pgid: 0, startTime: "100", zombie: false });
        yield* record(directory, controller);
        processes.delete(10);
        yield* restart(directory, controller).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        );
        expect(processes.has(40)).toBe(true);
        expect(signals.some((s) => s.startsWith("40:"))).toBe(false);
      }),
    ),
  );
  it.effect("freezes children forked during cleanup before killing their parents", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        yield* record(directory, controller);
        processes.delete(10);
        const forking = {
          ...controller,
          signal: (pid: number, signal: NodeJS.Signals) => {
            controller.signal(pid, signal);
            if (pid === 20 && signal === "SIGSTOP")
              processes.set(40, {
                pid: 40,
                ppid: 20,
                pgid: 40,
                startTime: "racing-child",
                zombie: false,
              });
          },
        };
        yield* restart(directory, forking);
        expect(signals.indexOf("40:SIGSTOP")).toBeLessThan(signals.indexOf("20:SIGKILL"));
        expect(processes.has(40)).toBe(false);
      }),
    ),
  );
  it.effect.each([false, true])(
    "stops the new tree if its durable ownership record cannot be written (direct identity: %s)",
    (direct) =>
      scenario(({ directory, processes, controller }) =>
        Effect.gen(function* () {
          const ledger = yield* ProviderProcessLedger.make({
            stateDir: directory,
            ownerPid: 10,
            controller: direct
              ? { ...controller, identity: (pid) => processes.get(pid) }
              : controller,
          }).pipe(Effect.scoped);
          const records = NodePath.join(directory, "provider-processes");
          NodeFS.rmSync(records, { recursive: true });
          NodeFS.writeFileSync(records, "unwritable records directory");
          const result = yield* ledger.track(20).pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
          expect(processes.has(20)).toBe(false);
          expect(processes.has(30)).toBe(false);
        }),
      ),
  );
  it.effect("a failed process record write leaves a nested live server running", () =>
    scenario(({ directory, processes, signals, controller }) =>
      Effect.gen(function* () {
        const leases = NodePath.join(directory, "leases");
        const ledger = yield* ProviderProcessLedger.make({
          stateDir: directory,
          ownerPid: 10,
          controller,
          installLeaseDirectory: leases,
        });
        processes.set(70, {
          pid: 70,
          ppid: 20,
          pgid: 70,
          startTime: "second-server",
          zombie: false,
        });
        processes.set(71, {
          pid: 71,
          ppid: 70,
          pgid: 70,
          startTime: "second-provider",
          zombie: false,
        });
        yield* ProviderProcessLedger.make({
          stateDir: NodePath.join(directory, "second"),
          ownerPid: 70,
          controller,
          installLeaseDirectory: leases,
        });
        const records = NodePath.join(directory, "provider-processes");
        NodeFS.rmSync(records, { recursive: true });
        NodeFS.writeFileSync(records, "full disk");
        const result = yield* ledger.track(20).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(processes.has(20)).toBe(false);
        expect(processes.has(70)).toBe(true);
        expect(processes.has(71)).toBe(true);
        expect(signals.some((s) => /^(70|71):/.test(s))).toBe(false);
      }).pipe(Effect.scoped),
    ),
  );
});
