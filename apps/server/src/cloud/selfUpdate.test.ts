import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSelfUpdateError, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerAutoUpdater from "../updates/ServerAutoUpdater.ts";
import * as UpdateWindow from "../updates/UpdateWindow.ts";
import * as ServerSettings from "../serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
}

// The staged runtime is a release archive: the fake client serves SHA256SUMS
// and the tarball, and the fake runner stands in for tar before it answers
// the staged preflight.
const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (order: string[]) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("/SHA256SUMS")) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${hex}  t3-1.1.0-linux-x64.tar.gz\n`),
        );
      }
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const order: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
          yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0", reason: "local update required" }
            : {
                status: "ready",
                version: "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
                orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
              };
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
    lastOutcome: undefined,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents.pipe(
    Effect.provide(ServerLifecycleEvents.layer),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ServerLifecycleEvents.ServerLifecycleEvents, lifecycle),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(HttpClient.HttpClient, releaseHttpClient(order)),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(ServerConfig.layer({ ...config, mode: options.mode ?? "web" })),
  );
  return { selfUpdate, order, lifecycle };
});

const withoutStaging = { capability: null, stage: () => Effect.die("unused") } as const;

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("announces an accepted service restart to every lifecycle subscriber", () =>
    Effect.gen(function* () {
      const { selfUpdate, lifecycle } = yield* makeHarness();
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" });
      const snapshot = yield* lifecycle.snapshot;
      expect(snapshot.events).toContainEqual({
        version: 1,
        sequence: 1,
        type: "updateRestart",
        payload: {
          fromVersion: "0.0.45",
          targetVersion: "1.1.0",
          updateId: result.updateId,
          expiresAt: 300_000,
        },
      });
    }),
  );

  it.effect("expires an accepted handoff without permitting concurrent updates", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness();
      yield* selfUpdate.update({ targetVersion: "1.1.0" });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* TestClock.adjust("5 minutes");
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).updateId).toBe("launcher-id");
    }),
  );

  it.effect("expires the handoff latch by elapsed time despite wall clock corrections", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness();
      const clock = yield* Clock.Clock;
      let wallTime = 0n;
      const update = selfUpdate.update({ targetVersion: "1.1.0" }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeNanos: Effect.sync(() => wallTime),
          currentTimeNanosUnsafe: () => wallTime,
        }),
      );
      yield* update;
      wallTime = 600_000_000_000n;
      expect((yield* update.pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      wallTime = -600_000_000_000n;
      yield* TestClock.adjust("5 minutes");
      expect((yield* update).updateId).toBe("launcher-id");
    }),
  );

  it.effect.each(["withdrawn", "disabled", "rolled-back", "failed"] as const)(
    "rechecks a staged release at handoff: %s",
    (scenario) =>
      Effect.gen(function* () {
        let latest = "1.1.0";
        let open = false;
        let enabled = true;
        const staged: string[] = [];
        const installed: string[] = [];
        const config = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-background-update-test-" }),
          ),
        );
        const { run: pass } = yield* ServerAutoUpdater.makeUpdatePass().pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layer({ ...config, devUrl: undefined }),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.sync(() => ({
                  ...DEFAULT_SERVER_SETTINGS,
                  automaticUpdates: enabled,
                })),
              }),
            ),
          ),
          Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, {
            managed: true,
            lastOutcome:
              scenario === "rolled-back" || scenario === "failed"
                ? {
                    id: "crash-loop",
                    fromVersion: "1.0.0",
                    targetVersion: "1.1.0",
                    status: scenario,
                    reason: "candidate-crash-loop",
                  }
                : undefined,
            requestUpdate: () => Effect.succeed("id"),
            prepareTrial: Effect.undefined,
          }),
          Effect.provideService(ServerSelfUpdate.ServerSelfUpdate, {
            capability: "boot-service",
            commitDesktopUpdate: () => Effect.never,
            stage: (target) =>
              Effect.sync(() => {
                staged.push(target);
                return { orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION };
              }),
            update: ({ targetVersion }) =>
              Effect.sync(() => {
                installed.push(targetVersion);
                return { targetVersion, method: "boot-service" as const };
              }),
          }),
          Effect.provideService(UpdateWindow.UpdateWindow, {
            runIfOpen: (effect) =>
              open ? Effect.map(effect, Option.some) : Effect.succeed(Option.none()),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                if (open && scenario === "disabled") enabled = false;
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify([{ tag_name: `v${latest}` }])),
                );
              }),
            ),
          ),
        );
        yield* pass;
        if (scenario === "rolled-back" || scenario === "failed") {
          expect(staged).toEqual([]);
          latest = "1.2.0";
          yield* TestClock.adjust("1 hour");
          yield* pass;
          expect(staged).toEqual(["1.2.0"]);
          return;
        }
        expect(staged).toEqual(["1.1.0"]);
        latest = "1.2.0";
        yield* TestClock.adjust("1 hour");
        yield* pass;
        expect(staged).toEqual(["1.1.0", "1.2.0"]);
        if (scenario === "withdrawn") latest = "1.0.0";
        open = true;
        const handoff = yield* pass.pipe(Effect.forkChild);
        yield* TestClock.adjust("5 minutes");
        yield* Fiber.join(handoff);
        expect(installed).toEqual([]);
      }),
  );

  it.effect("marks running threads at the boot-service handoff", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          ...withoutStaging,
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({
                targetVersion: "1.1.0",
                method: "boot-service" as const,
                updateId: "update-id",
              }),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-running")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );

      expect(events).toEqual(["downloading", "prepare", "installing"]);
    }),
  );

  it.effect("marks desktop threads only when the prepared update commits", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-running-desktop");
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          ...withoutStaging,
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(
              Effect.as({
                targetVersion: "1.2.0",
                method: "desktop-app" as const,
                desktopUpdateToken: "desktop-token",
              }),
            ),
          commitDesktopUpdate: () =>
            Effect.sync(() => events.push("commit")).pipe(Effect.andThen(Effect.fail(commitError))),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [threadId];
        }),
        clear: (threadIds) => Effect.sync(() => void events.push(`clear:${threadIds.join(",")}`)),
      });

      yield* selfUpdate.update({ targetVersion: "1.2.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );
      expect(events).toEqual(["installing"]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual(["installing", "prepare", "commit", `clear:${threadId}`]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual([
        "installing",
        "prepare",
        "commit",
        `clear:${threadId}`,
        "prepare",
        "commit",
        `clear:${threadId}`,
      ]);
    }),
  );

  it.effect("reports a failed continuation-marker cleanup", () =>
    Effect.gen(function* () {
      const updateError = new ServerSelfUpdateError({ reason: "update failed" });
      const clearError = new ServerSelfUpdateError({ reason: "marker cleanup failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          ...withoutStaging,
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(Effect.andThen(Effect.fail(updateError))),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.succeed([ThreadId.make("thread-cleanup-failure")]),
        clear: () => Effect.fail(clearError),
      });

      expect(
        yield* selfUpdate
          .update({ targetVersion: "1.1.0", continueRunningThreads: true })
          .pipe(Effect.flip),
      ).toBe(clearError);
    }),
  );

  it.effect("keeps continuation markers after the boot-service handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          ...withoutStaging,
          update: (
            _input,
            reportProgress = () => Effect.void,
            onHandoffAccepted = () => Effect.void,
          ) =>
            reportProgress("installing").pipe(
              Effect.andThen(onHandoffAccepted()),
              Effect.andThen(Effect.interrupt),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-boot-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      const exit = yield* selfUpdate
        .update({ targetVersion: "1.1.0", continueRunningThreads: true })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("keeps continuation markers after the desktop handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          ...withoutStaging,
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "accepted-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(Effect.andThen(Effect.interrupt)),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-desktop-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate
        .commitDesktopUpdate("accepted-desktop-token")
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("clears continuation markers for mixed failure and interrupt causes", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          ...withoutStaging,
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "failed-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(
              Effect.andThen(
                Effect.failCause(
                  Cause.fromReasons([
                    Cause.makeFailReason(commitError),
                    Cause.makeInterruptReason(),
                  ]),
                ),
              ),
            ),
        },
        prepare: Effect.sync(() => [ThreadId.make("thread-failed-desktop-install")]),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate.commitDesktopUpdate("failed-desktop-token").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
      }
      expect(events).toEqual(["clear"]);
    }),
  );

  it.effect("stages and preflights before asking the launcher for an update ID", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      expect(yield* selfUpdate.update({ targetVersion: "1.1.0" })).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      // The launcher staging path must not run on the desktop path.
      expect(order).toEqual([]);
    }),
  );

  it.effect("preserves the preflight refusal reason", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness({ preflight: "blocked" });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "local update required",
      );
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );
});
