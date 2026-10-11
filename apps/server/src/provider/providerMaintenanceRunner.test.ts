// @effect-diagnostics nodeBuiltinImport:off - Separate processes exercise host-wide maintenance leases.
import { describe, it, assert } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as HostLock from "./ProviderMaintenanceHostLock.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { ServerProviderUpdateError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderAutoUpdater from "../updates/ProviderAutoUpdater.ts";
import * as UpdateWindow from "../updates/UpdateWindow.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const NATIVE_CLI_DRIVER = ProviderDriverKind.make("nativeCli");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const NATIVE_CLI_INSTANCE_ID = ProviderInstanceId.make("nativeCli");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();

// Pin a non-win32 platform so `resolveSpawnCommand` is a no-op and the raw
// `{ command, args }` assertions below hold deterministically on any host
// (including Windows). Windows-specific resolution is covered by the dedicated
// win32 case at the end of this suite.
const layerNonWindowsPlatform = Layer.merge(
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostLock.ProviderMaintenanceHostLock, {
    acquireRead: Effect.succeed(Effect.void),
    withRead: (effect) => effect,
    withWrite: (effect) => effect,
  }),
);

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === NATIVE_CLI_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "native-agent",
      updateArgs: ["update"],
      updateLockKey: "native-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: "0.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseNativeCliProvider: ServerProvider = {
  ...baseProvider,
  instanceId: NATIVE_CLI_INSTANCE_ID,
  driver: NATIVE_CLI_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const layerLatestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv | undefined },
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: NodeJS.ProcessEnv | undefined };
      };
      return Effect.succeed(
        mockHandle(handler(childProcess.command, childProcess.args, childProcess.options)),
      );
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });

    const registry: ProviderRegistry.ProviderRegistry["Service"] = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    return {
      registry,
      providersRef,
      updateStatesRef,
    };
  });
}

const makeTestRunner = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  // Generic updater fixtures use synthetic versions. Keep their compatibility
  // unknown so real harness minimums do not bypass the command under test.
  manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [CODEX_DRIVER, OPENCODE_DRIVER].map((driver) => ({
      driver,
      t3CodeRange: ">=0.0.42",
      ranges: [],
    })),
  },
) =>
  Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.succeed(manifest),
              refreshInBackground: Effect.void,
            }),
            // Fresh per runner so a version cached by one test cannot leak into another.
            ProviderLatestVersions.layer,
          ),
        ),
      ),
    ),
  );

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "native-agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => [state.status, state.message]),
        [
          ["queued", "Waiting for another provider update to finish."],
          ["running", "Checking for the latest version"],
          ["running", "Running native-agent update"],
          ["running", "Verifying the installed version"],
          ["succeeded", "Provider updated."],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("reports unchanged when the updater exits 0 but the provider is gone", () => {
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry(baseProvider);
      // After the update, the refreshed snapshot no longer sees an install.
      const updater = yield* makeTestRunner({
        ...registry,
        refreshInstance: () =>
          Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) => ({ ...provider, installed: false, version: null })),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
      assert.match(result.providers[0]?.updateState?.message ?? "", /could not verify/);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });

  it.effect(
    "keeps a successful update when the binary is present but its version is unreadable",
    () => {
      return Effect.gen(function* () {
        const { registry, providersRef } = yield* makeRegistry(baseNativeCliProvider);
        // A native CLI version probe can fail immediately after a successful update.
        const updater = yield* makeTestRunner({
          ...registry,
          refreshInstance: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({ ...provider, installed: true, version: null })),
            ),
        });

        const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      );
    },
  );

  it.effect("spawns the updater with the environment its capabilities declare", () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed({
            ...lifecycleFor(provider),
            update: {
              command: "codex update",
              executable: "/work/codex-home/packages/standalone/bin/codex",
              args: ["update"],
              lockKey: "codex-native",
              env: { CODEX_HOME: "/work/codex-home" },
            },
          }),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(seen, [{ CODEX_HOME: "/work/codex-home" }]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((_command, _args, options) => {
            seen.push(options.env);
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("re-resolves ownership before running and executes the fresh command", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const fresh: Array<boolean> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider, options) => {
          fresh.push(options?.fresh === true);
          return Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: options?.fresh ? "/opt/homebrew/bin/brew" : "brew",
              updateArgs: ["upgrade", "--cask", "codex"],
              updateLockKey: "homebrew",
            }),
          );
        },
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      // Cached read picks the lock; the two fresh reads bracket the command.
      assert.deepStrictEqual(fresh, [false, true, true]);
      assert.deepStrictEqual(calls, [
        { command: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("reports the installer's latest output line while the update runs", () => {
    const exited = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>();
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);
      const runningMessages = Ref.get(updateStatesRef).pipe(
        Effect.map((states) =>
          states.filter((state) => state.status === "running").map((state) => state.message),
        ),
      );

      const fiber = yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.deepStrictEqual(yield* runningMessages, [
        "Checking for the latest version",
        "Running native-agent update",
        "80%",
      ]);

      yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({
            stdout: "Checking for updates\nDownloading 2.1.293\n\u001b[32m 40%\u001b[0m\r 80%",
            exitCode: Deferred.await(exited),
          })),
        ),
      ),
    );
  });

  it("splits installer output into clean status lines", () => {
    assert.deepStrictEqual(ProviderMaintenanceRunner.splitOutputLines("Down", "loading\r\n 5"), {
      lines: ["Downloading"],
      partialLine: " 5",
    });
    assert.strictEqual(
      ProviderMaintenanceRunner.toProgressLine("\u001b[1m==>\u001b[0m  Pouring"),
      "==> Pouring",
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(" \t "), null);
    assert.strictEqual(
      ProviderMaintenanceRunner.splitOutputLines("x".repeat(5_000), "y").partialLine.length,
      4_096,
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine("x".repeat(300))?.length, 200);
  });

  it.effect("aborts without running when the installation changed since the advisory", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider, options) =>
          Effect.succeed(
            options?.fresh
              ? makeProviderMaintenanceCapabilities({
                  provider,
                  packageName: "@openai/codex",
                  updateExecutable: null,
                  updateArgs: [],
                  updateLockKey: null,
                })
              : lifecycleFor(provider),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
      assert.strictEqual(
        result.providers[0]?.updateState?.message,
        "Provider installation changed. Refresh and try again.",
      );
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "failed"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command) => {
            calls.push(command);
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("uses the resolved provider capabilities when choosing the update executable", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.0.14",
          latestVersion: "2.1.123",
          updateCommand: "bun i -g @anthropic-ai/claude-code@latest",
          canUpdate: true,
          checkedAt: "2026-04-30T12:00:00.000Z",
          message: "Update available.",
        },
      });
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "bun",
              updateArgs: ["i", "-g", "@openai/codex@latest"],
              updateLockKey: "bun-global",
            }),
          ),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "bun",
          args: ["i", "-g", "@openai/codex@latest"],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "runs update commands through Effect ChildProcess when no test runner is injected",
    () => {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        const runner = yield* makeTestRunner(registry);

        const result = yield* runner.updateProvider(CODEX_DRIVER);

        assert.deepStrictEqual(calls, [
          {
            command: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
          },
        ]);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner((command, args) => {
              calls.push({ command, args });
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("updates a single provider instance without touching sibling instances", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const personalInstanceId = ProviderInstanceId.make("codex_personal");
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const refreshedInstanceIds: Array<ProviderInstanceId> = [];
      const { registry } = yield* makeRegistry([
        {
          ...baseProvider,
          instanceId: personalInstanceId,
          version: "0.124.0-alpha.3",
        },
        {
          ...baseProvider,
          instanceId: workInstanceId,
          version: "0.124.0-alpha.3",
        },
      ]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex-instance-test",
              updateExecutable: "vp",
              updateArgs: ["i", "-g", "@openai/codex"],
              updateLockKey: "vite-plus-global",
            }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => assert.strictEqual(instanceId, personalInstanceId))),
          ),
        refreshInstance: (instanceId) =>
          registry.refreshInstance(instanceId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                refreshedInstanceIds.push(instanceId);
              }),
            ),
          ),
      });

      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        instanceId: personalInstanceId,
      });

      assert.deepStrictEqual(calls, [
        {
          command: "vp",
          args: ["i", "-g", "@openai/codex"],
        },
      ]);
      assert.deepStrictEqual(refreshedInstanceIds, [personalInstanceId]);
      assert.strictEqual(result.providers[0]?.instanceId, personalInstanceId);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(result.providers[1]?.instanceId, workInstanceId);
      assert.strictEqual(result.providers[1]?.updateState, undefined);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.124.0-alpha.3"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("records command failure output in provider update state", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      const updateState = result.providers[0]?.updateState;

      assert.strictEqual(updateState?.status, "failed");
      assert.strictEqual(updateState?.message, "Update command exited with code 1.");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stderr: "permission denied", code: 1 })),
        ),
      ),
    ),
  );

  it.effect(
    "marks successful commands as unchanged when the refreshed provider is still outdated",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry({
          ...baseProvider,
          installed: true,
          version: "0.1.0",
        });
        const updater = yield* makeTestRunner(registry);

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
        assert.include(result.providers[0]?.updateState?.message ?? "", "still detects");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("9.9.9"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("prevents concurrent updates for the same provider", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started);

      const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(second), true);
      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);
        if (isServerProviderUpdateError(error)) {
          assert.include(error.reason, "already running");
        }
      }

      releaseLatch.resolve();
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("serializes different providers that share the same update lock key", () => {
    const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
              updateExecutable: "npm",
              updateArgs:
                provider === OPENCODE_DRIVER
                  ? ["install", "-g", "opencode-ai@latest"]
                  : ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
            }),
          ),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstStarted);

      const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
      let providersWhileQueued: ReadonlyArray<ServerProvider> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        providersWhileQueued = yield* registry.getProviders;
        const queuedStatus = providersWhileQueued.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;
        if (queuedStatus === "queued") {
          break;
        }
        yield* Effect.yieldNow;
      }
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      assert.strictEqual(
        providersWhileQueued.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );

      releaseFirstLatch.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(calls, [
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            if (calls.length === 1) {
              firstStartedLatch.resolve();
              return {
                stdout: "updated",
                exitCode: Effect.promise(() => releaseFirst).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("accepts arbitrary driver-provided update lock keys", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "unknown-lock-key",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        let blockQueuedState = true;
        const queuedStateWrittenLatch: { resolve: () => void } = { resolve: () => {} };
        const releaseQueuedStateLatch: { resolve: () => void } = { resolve: () => {} };
        const queuedStateWritten = new Promise<void>((resolve) => {
          queuedStateWrittenLatch.resolve = resolve;
        });
        const releaseQueuedState = new Promise<void>((resolve) => {
          releaseQueuedStateLatch.resolve = resolve;
        });

        const updater = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: Effect.fn(
            "providerMaintenanceRunner.test.blockQueuedState",
          )(function* (input) {
            const providers = yield* registry.setProviderMaintenanceActionState(input);
            if (input.state?.status === "queued" && blockQueuedState) {
              queuedStateWrittenLatch.resolve();
              yield* Effect.promise(() => releaseQueuedState);
            }
            return providers;
          }),
        });

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => queuedStateWritten);
        blockQueuedState = false;

        yield* Fiber.interrupt(first);
        releaseQueuedStateLatch.resolve();
        const canceled = (yield* registry.getProviders)[0]?.updateState;
        assert.strictEqual(canceled?.status, "failed");
        assert.strictEqual(canceled?.message, "Update canceled before installation started.");

        const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(second), true);
        if (Exit.isSuccess(second)) {
          assert.strictEqual(second.value.providers[0]?.updateState?.status, "succeeded");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("resolves npm to a .cmd shim and routes through the shell on win32", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean | string | undefined;
    }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const runner = yield* makeTestRunner(registry);

      const result = yield* runner.updateProvider(CODEX_DRIVER);

      // On win32, resolveSpawnCommand resolves `npm` to the `.cmd` shim and
      // routes the spawn through cmd.exe (shell: true), escaping every arg.
      assert.strictEqual(captured.length, 1);
      const call = captured[0];
      assert.ok(call, "expected the spawner to be invoked once");
      // The resolved command is the escaped `.cmd` path. Asserting the precise
      // escaped string is brittle, so verify it carries the resolved shim and
      // that shell mode was used.
      assert.match(call.command, /npm\.cmd/i);
      assert.strictEqual(call.shell, true);
      // Args are escaped for cmd.exe shell mode (each quoted) but still carry
      // the original install command (`install -g @openai/codex@latest`) in order.
      assert.strictEqual(call.args.length, 3);
      assert.match(call.args[0] ?? "", /install/);
      assert.match(call.args[1] ?? "", /-g/);
      assert.match(call.args[2] ?? "", /@openai\/codex@latest/);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Environment, {
            PATH: "C:\\fake\\npm",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command) =>
            command === "npm" ? "C:\\fake\\npm\\npm.cmd" : undefined,
          ),
          layerLatestVersionHttpClient("0.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const childProcess = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options: { readonly shell?: boolean | string | undefined };
              };
              captured.push({
                command: childProcess.command,
                args: childProcess.args,
                shell: childProcess.options.shell,
              });
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });
});

it.effect("refuses incompatible latest versions and unapproved or unpinnable targets", () => {
  const calls: string[] = [];
  const manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [
      {
        driver: "codex",
        t3CodeRange: ">=0.0.42",
        recommendedVersion: "2.0.0",
        ranges: [
          { range: "=2.0.0", status: "supported" },
          { range: ">2.0.0", status: "broken" },
        ],
      },
    ],
  };
  return Effect.gen(function* () {
    const { registry, providersRef } = yield* makeRegistry();
    const pinnedCapabilities = makeProviderMaintenanceCapabilities({
      provider: CODEX_DRIVER,
      packageName: "@openai/codex",
      updateExecutable: "npm",
      updateArgs: ["install", "-g", "@openai/codex@latest"],
      updateLockKey: "npm-global:/fixture",
    });
    const updater = yield* makeTestRunner(
      {
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(pinnedCapabilities),
      },
      manifest,
    );
    for (const targetVersion of [undefined, "", "1.0.0", "2.0.0; echo unsafe"]) {
      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        ...(targetVersion !== undefined ? { targetVersion } : {}),
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
    }
    assert.deepStrictEqual(calls, []);
    yield* Ref.update(providersRef, (providers) =>
      providers.map((entry) => ({ ...entry, version: "2.0.0" })),
    );
    const installed = yield* updater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.deepStrictEqual(calls, ["install -g @openai/codex@2.0.0"]);
    assert.strictEqual(installed.providers[0]?.updateState?.status, "succeeded");
    yield* Ref.update(providersRef, (providers) =>
      providers.map((entry) => ({ ...entry, version: "1.0.0" })),
    );
    const unchanged = yield* updater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.strictEqual(unchanged.providers[0]?.updateState?.status, "unchanged");
    const nativeUpdater = yield* makeTestRunner(
      {
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed({
            ...pinnedCapabilities,
            update: { ...pinnedCapabilities.update!, lockKey: "codex-native" },
          }),
      },
      manifest,
    );
    const refused = yield* nativeUpdater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.strictEqual(refused.providers[0]?.updateState?.status, "failed");
    assert.strictEqual(calls.length, 2);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerNonWindowsPlatform,
        layerLatestVersionHttpClient("3.0.0"),
        layerMockSpawner((_command, args) => {
          calls.push(args.join(" "));
          return { stdout: "installed" };
        }),
      ),
    ),
  );
});

it.effect.each([
  { exitCode: 0, targetVersion: "2.0.0" },
  { exitCode: 1, targetVersion: "2.0.0" },
  { exitCode: 0, targetVersion: "2.0.0-beta.1" },
])(
  "background installs pin $targetVersion and refresh shared instances after exit $exitCode",
  ({ exitCode, targetVersion }) => {
    const calls: string[] = [];
    const refreshed: ProviderInstanceId[] = [];
    let installedVersion = "1.0.0";
    const sibling = ProviderInstanceId.make("codex-work");
    const unrelated = ProviderInstanceId.make("codex-other");
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry([
        baseProvider,
        { ...baseProvider, instanceId: sibling },
        { ...baseProvider, instanceId: unrelated },
      ]);
      const capabilities = makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "npm",
        updateArgs: ["install", "-g", "--prefix", "/owned", "@openai/codex@latest"],
        updateLockKey: "npm-global:/owned",
        installationKey: "codex:/owned",
        env: { PATH: "/instance/node/bin", npm_config_registry: "https://private.invalid/" },
      });
      const runner = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (id) =>
          Effect.succeed(
            id === unrelated
              ? {
                  ...capabilities,
                  update: { ...capabilities.update!, installationKey: "codex:/other" },
                }
              : capabilities,
          ),
        refreshInstance: (id) =>
          Effect.sync(() => refreshed.push(id)).pipe(
            Effect.andThen(
              Ref.updateAndGet(providersRef, (providers) =>
                providers.map((entry) =>
                  entry.instanceId === id ? { ...entry, version: installedVersion } : entry,
                ),
              ),
            ),
          ),
      });
      const result = yield* runner.updateProvider({
        provider: CODEX_DRIVER,
        ...(exitCode === 0 ? { targetVersion } : {}),
        quiet: true,
        background: true,
      });
      assert.deepStrictEqual(calls, [`install -g --prefix /owned @openai/codex@${targetVersion}`]);
      assert.deepStrictEqual(refreshed, [CODEX_INSTANCE_ID, CODEX_INSTANCE_ID, sibling]);
      assert.strictEqual(
        result.providers[0]?.updateState?.status,
        exitCode === 0 ? "succeeded" : "failed",
      );
      assert.strictEqual(result.providers[1]?.version, targetVersion);
      assert.strictEqual(result.providers[2]?.version, "0.0.0");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient(exitCode === 0 ? "9.0.0" : "2.0.0"),
          layerMockSpawner((_command, args, options) => {
            calls.push(args.join(" "));
            assert.strictEqual(options.env?.npm_config_registry, "https://private.invalid/");
            // The configured registry's latest is older than the checked public release.
            installedVersion = args.includes(`@openai/codex@${targetVersion}`)
              ? targetVersion
              : "0.9.0";
            return { stdout: "updated", code: exitCode };
          }),
        ),
      ),
    );
  },
);

it.effect.each(["2.0.0", "3.0.0", "v3.0.0", "unknown"])(
  "background installs never downgrade a freshly probed %s",
  (version) =>
    Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const capabilities = makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "npm",
        updateArgs: ["install", "-g", "@openai/codex@latest"],
        updateLockKey: "npm-global:/owned",
        installationKey: "codex:/owned",
      });
      const runner = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(capabilities),
        refreshInstance: () =>
          Ref.updateAndGet(providersRef, (providers) =>
            providers.map((entry) => ({ ...entry, version })),
          ),
      });
      const result = yield* runner.updateProvider({
        provider: CODEX_DRIVER,
        background: true,
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner(() => {
            throw new Error("must not install or downgrade");
          }),
        ),
      ),
    ),
);

it.effect.each([false, true])(
  "background installs reject unproven or replaced ownership (%s)",
  (changed) => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const capabilities = makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "/opt/pinned/codex",
        updateArgs: ["update"],
        updateLockKey: "codex-native",
        ...(changed ? { installationKey: "old" } : {}),
      });
      const runner = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_id, _provider, options) =>
          Effect.succeed(
            changed && options?.fresh
              ? {
                  ...capabilities,
                  update: { ...capabilities.update!, installationKey: "replacement" },
                }
              : capabilities,
          ),
      });
      const result = yield* runner.updateProvider({
        provider: CODEX_DRIVER,
        background: true,
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner((command) => {
            calls.push(command);
            return {};
          }),
        ),
      ),
    );
  },
);

it.effect("Windows updater lookup uses the same instance PATH as the spawned process", () => {
  const captured: string[] = [];
  return Effect.gen(function* () {
    const { registry } = yield* makeRegistry();
    const runner = yield* makeTestRunner({
      ...registry,
      getProviderMaintenanceCapabilitiesForInstance: () =>
        Effect.succeed(
          makeProviderMaintenanceCapabilities({
            provider: CODEX_DRIVER,
            packageName: "@openai/codex",
            updateExecutable: "npm",
            updateArgs: ["install", "-g", "@openai/codex@latest"],
            updateLockKey: "npm-global:instance",
            env: { PATH: "C:\\instance\\bin", PATHEXT: ".CMD" },
          }),
        ),
    });
    yield* runner.updateProvider(CODEX_DRIVER);
    assert.strictEqual(captured.length, 1);
    assert.include(captured[0]!, "instance");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "win32"),
        Layer.succeed(HostProcess.Environment, { PATH: "C:\\host\\bin" }),
        Layer.succeed(
          SpawnExecutableResolution,
          (_command, _platform, env) => `${env.PATH}\\npm.cmd`,
        ),
        layerLatestVersionHttpClient("0.0.0"),
        layerMockSpawner((command, _args, options) => {
          captured.push(command);
          assert.strictEqual(options.env?.PATH, "C:\\instance\\bin");
          return {};
        }),
      ),
    ),
  );
});

it.effect(
  "background passes share retries per installation, pin targets and skip custom binaries",
  () =>
    Effect.gen(function* () {
      const instances = ["a", "b", "separate", "pinned"].map((id) => ProviderInstanceId.make(id));
      const { registry, providersRef } = yield* makeRegistry(
        instances.map((id) => ({
          ...baseProvider,
          instanceId: id,
          versionAdvisory: {
            status: "behind_latest",
            currentVersion: "1.0.0",
            latestVersion: id === instances[1] ? "3.0.0" : "2.0.0",
            updateCommand: "npm install",
            canUpdate: true,
            canInstallVersion: true,
            checkedAt: null,
            message: null,
          },
        })),
      );
      const calls: Array<{
        instanceId: ProviderInstanceId | undefined;
        targetVersion: string | undefined;
      }> = [];
      const finished = yield* Deferred.make<void>();
      const secondPass = yield* Deferred.make<void>();
      const thirdPass = yield* Deferred.make<void>();
      const retried = yield* Deferred.make<void>();
      let windowCalls = 0;
      const capabilitiesFor = (id: ProviderInstanceId) =>
        makeProviderMaintenanceCapabilities({
          provider: CODEX_DRIVER,
          packageName: "@openai/codex",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@openai/codex@latest"],
          updateLockKey: "npm-global:/owned",
          ...(id === instances[3]
            ? {}
            : { installationKey: id === instances[2] ? "separate" : "shared" }),
        });
      yield* Layer.build(
        ProviderAutoUpdater.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig.ServerConfig, {
                devUrl: undefined,
              } as ServerConfig.ServerConfig["Service"]),
              Layer.succeed(ProviderRegistry.ProviderRegistry, {
                ...registry,
                getProviderMaintenanceCapabilitiesForInstance: (id) =>
                  Effect.succeed(capabilitiesFor(id)),
              }),
              Layer.succeed(ProviderMaintenanceRunner.ProviderMaintenanceRunner, {
                updateProvider: (target) =>
                  Effect.gen(function* () {
                    assert.notStrictEqual(typeof target, "string");
                    if (typeof target === "string") throw new Error("instance target expected");
                    calls.push({
                      instanceId: target.instanceId,
                      targetVersion: target.targetVersion,
                    });
                    assert.strictEqual(target.background, true);
                    assert.strictEqual(target.quiet, true);
                    return yield* new ServerProviderUpdateError({
                      provider: CODEX_DRIVER,
                      reason: "isolated installer failure",
                    });
                  }),
              }),
              Layer.succeed(UpdateWindow.UpdateWindow, {
                runIfOpen: (install) =>
                  install.pipe(
                    Effect.tap(() => {
                      windowCalls += 1;
                      return windowCalls === 4
                        ? Deferred.succeed(finished, undefined)
                        : windowCalls === 8
                          ? Deferred.succeed(secondPass, undefined)
                          : windowCalls === 12
                            ? Deferred.succeed(thirdPass, undefined)
                            : windowCalls === 156
                              ? Deferred.succeed(retried, undefined)
                              : Effect.void;
                    }),
                    Effect.asSome,
                  ),
              }),
              Layer.succeed(ServerSettings.ServerSettingsService, {
                start: Effect.void,
                ready: Effect.void,
                getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                updateSettings: () => Effect.die("unused"),
                updateProviderInstance: () => Effect.die("unused"),
                withSettingsSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.succeed(Stream.empty),
              }),
            ),
          ),
        ),
      );
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.await(finished);
      assert.deepStrictEqual(calls, [
        { instanceId: instances[0], targetVersion: "2.0.0" },
        { instanceId: instances[2], targetVersion: "2.0.0" },
      ]);
      yield* Ref.update(providersRef, (providers) =>
        providers.map((entry) => ({
          ...entry,
          versionAdvisory: { ...entry.versionAdvisory!, latestVersion: "2.0.0" },
        })),
      );
      yield* TestClock.adjust("10 minutes");
      yield* Deferred.await(secondPass);
      assert.strictEqual(calls.length, 2);
      yield* Ref.update(providersRef, (providers) =>
        providers.map((entry) => ({
          ...entry,
          versionAdvisory: { ...entry.versionAdvisory!, latestVersion: "3.0.0" },
        })),
      );
      yield* TestClock.adjust("10 minutes");
      yield* Deferred.await(thirdPass);
      assert.deepStrictEqual(calls.slice(2), [
        { instanceId: instances[0], targetVersion: "3.0.0" },
        { instanceId: instances[2], targetVersion: "3.0.0" },
      ]);
      yield* TestClock.adjust("6 hours");
      // At 6h after the first pass, the newer release has had only 5h40m; at 6h after its attempt it retries.
      yield* Deferred.await(retried);
      assert.strictEqual(calls.length, 6);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect(
  "background native updates recheck the owning channel instead of a stale advisory target",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const capabilities = makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "brew",
        updateArgs: ["upgrade", "codex"],
        updateLockKey: "homebrew",
        installationKey: "codex:/brew",
        latestVersion: "3.0.0",
      });
      const runner = yield* makeTestRunner(
        {
          ...registry,
          getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(capabilities),
        },
        {
          version: 1,
          currentModels: {},
          compatibility: [
            {
              driver: "codex",
              t3CodeRange: ">=0.0.42",
              recommendedVersion: "2.0.0",
              ranges: [
                { range: "=2.0.0", status: "supported" },
                { range: "=3.0.0", status: "broken" },
              ],
            },
          ],
        },
      );
      const result = yield* runner.updateProvider({
        provider: CODEX_DRIVER,
        targetVersion: "2.0.0",
        background: true,
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner((command) => {
            calls.push(command);
            return {};
          }),
        ),
      ),
    );
  },
);

describe("provider maintenance host leases", () => {
  const coordinatedWrite = <A>(directory: string, run: Effect.Effect<A>) =>
    Effect.gen(function* () {
      const coordinator = yield* makeProviderMaintenanceCommandCoordinator({
        makeAlreadyRunningError: () => new Error("already running"),
      });
      return yield* coordinator.withCommandLock({ targetKey: "provider", lockKey: "install", run });
    }).pipe(Effect.provideService(HostLock.ProviderMaintenanceHostLock, HostLock.make(directory)));
  const childLease = (directory: string, mode: "withRead" | "withWrite") =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import * as Effect from "effect/Effect";
          import { make } from ${JSON.stringify(new URL("./ProviderMaintenanceHostLock.ts", import.meta.url).href)};
          await Effect.runPromise(make(process.argv[1])[process.argv[2]](Effect.promise(() =>
            new Promise(resolve => { process.stdout.write("held\\n"); process.stdin.once("data", resolve); })
          )));
        `,
            directory,
            mode,
          ],
          { cwd: NodePath.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
        );
        const held = new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve());
          child.once("error", reject);
          child.once("exit", (code) => code && reject(new Error(`holder exited ${code}`)));
        });
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        return { child, held, exited };
      }),
      ({ child, exited }) =>
        Effect.promise(async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await exited;
        }),
    );

  const waitForGate = (directory: string) =>
    Effect.callback<void>((resume) => {
      const gate = NodePath.join(directory, "gate.lock");
      const watcher = NodeFS.watch(directory, () => {
        if (NodeFS.existsSync(gate)) resume(Effect.void);
      });
      watcher.once("error", (error) => resume(Effect.die(error)));
      if (NodeFS.existsSync(gate)) resume(Effect.void);
      return Effect.sync(() => watcher.close());
    });

  it.live("holds another server's install through a turn and admits nested CLI calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const holder = yield* childLease(directory, "withRead");
        yield* Effect.promise(() => holder.held);
        const local = HostLock.make(directory);
        const release = yield* local.acquireRead;
        const entered = yield* Deferred.make<void>();
        const gate = Effect.raceFirst(
          waitForGate(directory),
          Deferred.await(entered).pipe(Effect.andThen(Effect.die("install bypassed active turn"))),
        );
        const install = yield* coordinatedWrite(
          directory,
          Deferred.succeed(entered, undefined),
        ).pipe(Effect.forkScoped);
        yield* gate;
        assert.isFalse(yield* Deferred.isDone(entered));
        yield* local.withRead(Effect.void);
        yield* release;
        assert.isFalse(yield* Deferred.isDone(entered));
        holder.child.stdin.end("release");
        yield* Effect.promise(() => holder.exited);
        yield* Fiber.join(install);
        assert.isTrue(yield* Deferred.isDone(entered));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("serializes installs across independent server processes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const holder = yield* childLease(directory, "withWrite");
        yield* Effect.promise(() => holder.held);
        const entered = yield* Deferred.make<void>();
        const install = yield* coordinatedWrite(
          directory,
          Deferred.succeed(entered, undefined),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(entered));
        holder.child.stdin.end("release");
        yield* Effect.promise(() => holder.exited);
        yield* Fiber.join(install);
        assert.isTrue(yield* Deferred.isDone(entered));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("releases active and waiting host leases on interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const local = HostLock.make(directory);
        const entered = yield* Deferred.make<void>();
        const turn = yield* local
          .withRead(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const gate = waitForGate(directory);
        const install = yield* local.withWrite(Effect.never).pipe(Effect.forkScoped);
        yield* gate;
        yield* Fiber.interrupt(install);
        yield* Fiber.interrupt(turn);
        assert.equal(NodeFS.readdirSync(NodePath.join(directory, "readers")).length, 0);
        assert.equal(yield* local.withWrite(Effect.succeed("installed")), "installed");
        const writer = yield* childLease(directory, "withWrite");
        yield* Effect.promise(() => writer.held);
        const queued = yield* local.withRead(Effect.never).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(queued);
        writer.child.stdin.end("release");
        yield* Effect.promise(() => writer.exited);
        assert.equal(yield* local.withWrite(Effect.succeed("installed")), "installed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reclaims a dead reader whose PID has been reused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) !== "linux") return;
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const readers = NodePath.join(directory, "readers");
        NodeFS.mkdirSync(readers);
        NodeFS.writeFileSync(
          NodePath.join(readers, `${process.pid}-old-reader`),
          "previous-process-start",
        );
        assert.equal(
          yield* HostLock.make(directory).withWrite(Effect.succeed("installed")),
          "installed",
        );
        assert.deepEqual(NodeFS.readdirSync(readers), []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reclaims a crashed server's turn and install leases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        for (const mode of ["withRead", "withWrite"] as const) {
          const holder = yield* childLease(directory, mode);
          yield* Effect.promise(() => holder.held);
          holder.child.kill("SIGKILL");
          yield* Effect.promise(() => holder.exited);
          if (mode === "withWrite") {
            // Advance the dead heartbeat, without sleeping through its stale interval.
            NodeFS.utimesSync(NodePath.join(directory, "gate.lock"), 0, 0);
          }
          assert.equal(
            yield* HostLock.make(directory).withWrite(Effect.succeed("installed")),
            "installed",
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
