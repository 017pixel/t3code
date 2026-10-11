// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import * as ProviderProcessLedger from "./ProviderProcessLedger.ts";
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
  it.effect("stops the new tree if its durable ownership record cannot be written", () =>
    scenario(({ directory, processes, controller }) =>
      Effect.gen(function* () {
        const ledger = yield* ProviderProcessLedger.make({
          stateDir: directory,
          ownerPid: 10,
          controller,
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
});
