// @effect-diagnostics nodeBuiltinImport:off - Separate processes exercise host-wide maintenance leases.
import * as Maintenance from "@t3tools/provider-core/server/maintenance";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Option from "effect/Option";
import * as ThreadContracts from "@t3tools/contracts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { describe, it, assert, vi } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostLock from "./ProviderMaintenanceHostLock.ts";
import * as InstallSupervisor from "./ProviderInstallSupervisor.ts";
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
import * as Context from "effect/Context";
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
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { PiDriver } from "@t3tools/provider-pi/server";
import { GrokDriver } from "@t3tools/provider-grok/server";
import { MuseDriver } from "@t3tools/provider-muse/server";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);
const decodeInstallLease = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ pid: Schema.Number, identity: Schema.NullOr(Schema.String) }),
  ),
);

it.effect.each([
  "claude",
  "codex",
  "codex-custom",
  "codex-linked",
  "opencode",
  "pi",
  "grok",
  "muse",
  "npm",
  "pnpm-5",
  "pnpm-11",
  "bun",
  "yarn",
  "volta",
  "vp-legacy",
  "vp-split",
  "brew-formula",
  "brew-cask",
] as const)(
  "background updates execute the official %s install's owning command",
  (method) => {
    let root = "";
    let updated = false;
    const calls: Array<{ command: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv }> =
      [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      root = yield* fs.makeTempDirectoryScoped({ prefix: "r3-03-runner-" });
      const write = (file: string, source = '#!/bin/sh\nprintf "%s\\n" "$@"\n') => {
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, source);
        NodeFS.chmodSync(file, 0o755);
      };
      const link = (target: string, alias: string) => {
        NodeFS.mkdirSync(NodePath.dirname(alias), { recursive: true });
        NodeFS.symlinkSync(NodePath.relative(NodePath.dirname(alias), target), alias);
      };
      const bin = NodePath.join(root, ".local/bin");
      const cli =
        method === "claude"
          ? "claude"
          : method === "opencode"
            ? "opencode"
            : method === "pi"
              ? "pi"
              : method === "grok"
                ? "grok"
                : method === "muse"
                  ? "muse"
                  : "codex";
      const alias = NodePath.join(bin, cli);
      const kind = ProviderDriverKind.make(cli === "claude" ? "claudeAgent" : cli);
      const packageName =
        cli === "claude"
          ? "@anthropic-ai/claude-code"
          : cli === "opencode"
            ? "opencode-ai"
            : cli === "pi"
              ? "@earendil-works/pi-coding-agent"
              : cli === "grok"
                ? "@xai-official/grok"
                : "@openai/codex";
      let expectedExecutable = alias;
      let expectedArgs: ReadonlyArray<string> = [cli === "opencode" ? "upgrade" : "update"];
      let codexHome = NodePath.join(root, ".codex");
      const env = { HOME: root, PATH: bin, GROK_HOME: NodePath.join(root, ".grok") };
      if (method === "claude") {
        const release = NodePath.join(root, ".local/share/claude/versions/2.1.293");
        write(release);
        link(release, alias);
      } else if (method.startsWith("codex")) {
        if (method === "codex-custom") codexHome = NodePath.join(root, "custom-codex");
        const release = NodePath.join(
          codexHome,
          "packages/standalone/releases/0.162.1-x86_64/bin/codex",
        );
        write(release);
        const current = NodePath.join(codexHome, "packages/standalone/current");
        link(NodePath.dirname(NodePath.dirname(release)), current);
        if (method === "codex-linked") {
          const linkedHome = NodePath.join(root, "linked-codex");
          link(codexHome, linkedHome);
          codexHome = linkedHome;
        }
        link(NodePath.join(codexHome, "packages/standalone/current/bin/codex"), alias);
      } else if (method === "opencode") {
        const native = NodePath.join(root, ".opencode/bin/opencode");
        write(native);
        link(native, alias);
      } else if (method === "pi") {
        const agent = NodePath.join(root, ".pi/agent");
        const launcher = NodePath.join(agent, "bin/pi");
        const release = NodePath.join(
          agent,
          "install/releases/1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        );
        write(release);
        link(release, NodePath.join(agent, "install/releases/1.0.0/node_modules/.bin/pi"));
        write(NodePath.join(agent, "install/current-version"), "1.0.0\n");
        write(
          NodePath.join(agent, "install/managed-install.json"),
          JSON.stringify({
            kind: "pi-managed-install",
            schemaVersion: 1,
            layout: "releases-v1",
            entrypoint: { type: "symlink", path: alias },
          }),
        );
        write(
          launcher,
          '#!/bin/sh\npi_bin_dir=${0%/*}\npi_agent_dir=${pi_bin_dir%/*}\npi_current_file=$pi_agent_dir/install/current-version\nIFS= read -r pi_current_version < "$pi_current_file"\npi_release_bin=$pi_agent_dir/install/releases/$pi_current_version/node_modules/.bin/pi\nPI_MANAGED_INSTALL_ROOT=$pi_agent_dir/install\nexport PI_MANAGED_INSTALL_ROOT\nexec "$pi_release_bin" "$@"\n',
        );
        link(launcher, alias);
        expectedArgs = ["update", "--self"];
      } else if (method === "grok") {
        const download = NodePath.join(env.GROK_HOME, "downloads/grok-linux-x86_64");
        write(download);
        link(download, NodePath.join(env.GROK_HOME, "bin/grok"));
        link(NodePath.join(env.GROK_HOME, "bin/grok"), alias);
      } else if (method === "muse") {
        write(
          alias,
          '#!/bin/bash\n# muse-code/launcher-2\nMUSE_SYNC_UPDATE=${MUSE_SYNC_UPDATE:-0}\nexec "${0%/*}/muse-bin-2.0.0-R1" "$@"\n',
        );
        write(NodePath.join(bin, "muse-bin-2.0.0-R1"));
        expectedArgs = ["--version"];
      } else if (method === "volta") {
        const shim = NodePath.join(root, ".volta/bin/volta-shim");
        write(shim);
        NodeFS.mkdirSync(NodePath.join(root, ".volta/tools/image/packages/@openai/codex/1.0.0"), {
          recursive: true,
        });
        const voltaAlias = NodePath.join(root, ".volta/bin/codex");
        link(shim, voltaAlias);
        link(voltaAlias, alias);
        expectedExecutable = "volta";
        expectedArgs = ["install", "@openai/codex@2.0.0"];
      } else if (method.startsWith("vp-")) {
        const data = NodePath.join(
          root,
          method === "vp-legacy" ? ".vite-plus" : ".local/share/vite-plus",
        );
        const vp = NodePath.join(data, "1.1.0/bin/vp");
        write(vp);
        link(NodePath.dirname(NodePath.dirname(vp)), NodePath.join(data, "current"));
        write(
          NodePath.join(data, "bins/codex.json"),
          JSON.stringify({
            name: "codex",
            package: packageName,
            version: "1.0.0",
            nodeVersion: "24.13.1",
            source: "vp",
          }),
        );
        write(
          NodePath.join(data, "packages/@openai/codex.json"),
          JSON.stringify({
            name: packageName,
            version: "1.0.0",
            bins: ["codex"],
            jsBins: ["codex"],
            manager: "npm",
            platform: { node: "24.13.1" },
            installedAt: "2026-10-11T00:00:00Z",
          }),
        );
        const vpAlias = NodePath.join(data, "bin/codex");
        link(NodePath.join(data, "current/bin/vp"), vpAlias);
        link(vpAlias, alias);
        expectedExecutable = "vp";
        expectedArgs = ["i", "-g", "@openai/codex@2.0.0"];
      } else if (method.startsWith("brew-")) {
        const real = NodePath.join(
          root,
          method === "brew-cask"
            ? "Caskroom/codex/0.162.1/bin/codex"
            : "Cellar/opencode/2.0.25/bin/opencode",
        );
        write(real);
        link(real, alias);
        write(NodePath.join(root, "bin/brew"));
        expectedExecutable = NodePath.join(root, "bin/brew");
        expectedArgs =
          method === "brew-cask" ? ["upgrade", "--cask", "codex"] : ["upgrade", "opencode"];
      } else {
        const prefix =
          method === "npm"
            ? "npm/lib"
            : method === "bun"
              ? ".bun/install/global"
              : method === "yarn"
                ? ".config/yarn/global"
                : method === "pnpm-5"
                  ? ".local/share/pnpm/global/5"
                  : ".local/share/pnpm/global/v11/store/codex/node_modules/.pnpm/@openai+codex@1.0.0";
        const real = NodePath.join(root, prefix, "node_modules/@openai/codex/bin/codex.js");
        write(real);
        const ownerAlias = NodePath.join(
          root,
          method === "bun"
            ? ".bun/bin/codex"
            : method.startsWith("pnpm")
              ? ".local/share/pnpm/bin/codex"
              : ".local/bin/codex-link",
        );
        if (method.startsWith("pnpm")) {
          // pnpm writes a shell shim, not an npm-style executable symlink.
          write(
            ownerAlias,
            `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${NodePath.relative(NodePath.dirname(ownerAlias), real)}" "$@"\n`,
          );
        } else link(real, ownerAlias);
        link(ownerAlias, alias);
        expectedExecutable = method.startsWith("pnpm") ? "pnpm" : method;
        expectedArgs =
          method === "npm"
            ? [
                "install",
                "-g",
                "--prefix",
                NodePath.join(root, "npm"),
                "--allow-scripts=@openai/codex",
                "@openai/codex@2.0.0",
              ]
            : method.startsWith("pnpm")
              ? ["add", "-g", "@openai/codex@2.0.0"]
              : method === "bun"
                ? ["i", "-g", "@openai/codex@2.0.0"]
                : ["global", "add", "@openai/codex@2.0.0"];
      }
      const resolver = makePackageManagedProviderMaintenanceResolver({
        provider: kind,
        npmPackageName: packageName,
        nativeUpdate: {
          args: expectedArgs,
          isCommandPath: (value) =>
            method === "claude"
              ? value.includes("/.local/share/claude/versions/")
              : method.startsWith("codex")
                ? value.includes("/packages/standalone/")
                : method === "opencode"
                  ? value.endsWith("/.opencode/bin/opencode")
                  : false,
          ...(method.startsWith("codex") ? { env: { CODEX_HOME: codexHome } } : {}),
        },
      });
      const instanceId = ProviderInstanceId.make("official-install");
      const instance =
        method === "pi"
          ? yield* PiDriver.create({
              instanceId,
              displayName: undefined,
              enabled: false,
              environment: [],
              config: { ...PiDriver.defaultConfig(), binaryPath: alias },
            })
          : method === "grok"
            ? yield* GrokDriver.create({
                instanceId,
                displayName: undefined,
                enabled: false,
                environment: [{ name: "GROK_HOME", value: env.GROK_HOME, sensitive: false }],
                config: { ...GrokDriver.defaultConfig(), binaryPath: alias },
              })
            : method === "muse"
              ? yield* MuseDriver.create({
                  instanceId,
                  displayName: undefined,
                  enabled: false,
                  environment: [],
                  config: { ...MuseDriver.defaultConfig(), binaryPath: alias },
                })
              : null;
      const resolve = (options?: { fresh?: boolean }) =>
        instance
          ? instance.snapshot.resolveMaintenance(options)
          : resolveProviderMaintenanceCapabilitiesEffect(resolver, { binaryPath: alias, env }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            );
      assert.isDefined((yield* resolve()).update?.installationKey);
      const { registry, providersRef } = yield* makeRegistry({
        ...baseProvider,
        instanceId,
        driver: kind,
        version: "1.0.0",
      });
      const runner = yield* makeTestRunner(
        {
          ...registry,
          getProviderMaintenanceCapabilitiesForInstance: (_id, _driver, options) =>
            resolve(options),
          refreshInstance: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => (updated ? { ...provider, version: "2.0.0" } : provider)),
            ),
        },
        {
          version: 1,
          currentModels: {},
          compatibility: [
            {
              driver: kind,
              t3CodeRange: ">=0.0.42",
              ranges: [{ range: ">=1.0.0", status: "supported" }],
            },
          ],
        },
      );
      const result = yield* runner.updateProvider({
        instanceId,
        provider: kind,
        origin: "background",
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.command, expectedExecutable);
      assert.deepStrictEqual(calls[0]?.args, expectedArgs);
      if (method.startsWith("codex")) assert.strictEqual(calls[0]?.env?.CODEX_HOME, codexHome);
      if (method === "muse") assert.strictEqual(calls[0]?.env?.MUSE_SYNC_UPDATE, "1");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          NodeServices.layer,
          TestProviderHost.layer({ runBackgroundWork: false }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          IdAllocator.layer,
          McpProviderSessions.layer,
          ProviderLatestVersions.layer,
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
          layerMockSpawner((command, args, options) => {
            if (args[0] === "--prefix") return { stdout: root };
            if (args[0] === "info")
              return {
                stdout: JSON.stringify({
                  formulae: [{ versions: { stable: "2.0.0" } }],
                  casks: [{ version: "2.0.0" }],
                }),
              };
            calls.push({ command, args, ...(options.env ? { env: options.env } : {}) });
            updated = true;
            return { stdout: "updated" };
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    version: request.url.includes("meta.ai") ? "2.0.0-R1" : "2.0.0",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.scoped,
    );
  },
  { skip: HostProcess.Platform.defaultValue() === "win32" },
);

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
    directory: "",
    acquireRead: Effect.succeed(Effect.void),
    withRead: (effect) => effect,
    withWrite: (effect) => effect,
    handoff: (effect) => effect,
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
  receipts = Effect.succeed<ReadonlyArray<InstallSupervisor.InstallReceipt>>([]),
  onInstall: (
    input: Parameters<InstallSupervisor.ProviderInstallSupervisor["Service"]["run"]>[0],
  ) => Effect.Effect<void> = () => Effect.void,
) =>
  Layer.build(
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
          Layer.effect(
            InstallSupervisor.ProviderInstallSupervisor,
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              return InstallSupervisor.ProviderInstallSupervisor.of({
                run: (input) =>
                  ProviderMaintenanceRunner.runProviderMaintenanceCommandWithSpawner({
                    ...input,
                    spawner,
                  }).pipe(
                    Effect.tap(() => onInstall(input)),
                    Effect.mapError(
                      (cause) =>
                        new InstallSupervisor.ProviderInstallError({
                          message: cause.message,
                          cause,
                        }),
                    ),
                  ),
                receipts,
              });
            }),
          ),
        ),
      ),
    ),
  ).pipe(
    Effect.map((context) =>
      Context.get(context, ProviderMaintenanceRunner.ProviderMaintenanceRunner),
    ),
  );

describe("providerMaintenanceRunner", () => {
  it.effect.each([
    { origin: "manual" as const, exitCode: 0 },
    { origin: "manual" as const, exitCode: 1 },
  ])("carries $origin origin through every update state ($exitCode)", ({ origin, exitCode }) =>
    Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const runner = yield* makeTestRunner(registry);
      const result = yield* runner.updateProvider({
        provider: NATIVE_CLI_DRIVER,
        origin,
      });
      assert.strictEqual(
        result.providers[0]?.updateState?.status,
        exitCode === 0 ? "succeeded" : "failed",
      );
      const states = yield* Ref.get(updateStatesRef);
      assert.isAtLeast(states.length, 3);
      assert.isTrue(states.every((state) => state.origin === origin));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stdout: "installer output", code: exitCode })),
        ),
      ),
    ),
  );

  it.effect("does not time out or kill an installer still writing after five minutes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      let killed = false;
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed({
            ...mockHandle({}),
            exitCode: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finished)),
            ),
            kill: () =>
              Effect.sync(() => {
                killed = true;
              }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseNativeCliProvider);
        const runner = yield* makeTestRunner(registry);
        const install = yield* runner.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("6 minutes");
        assert.isUndefined(install.pollUnsafe());
        assert.isFalse(killed);
        yield* Deferred.succeed(finished, ChildProcessSpawner.ExitCode(0));
        assert.equal((yield* Fiber.join(install)).providers[0]?.updateState?.status, "succeeded");
      }).pipe(Effect.provide(spawner));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
        ),
      ),
    ),
  );

  it.effect.each([
    { origin: "background" as const, installedVersion: "1.0.0" },
    { origin: "manual" as const, installedVersion: "1.1.0" },
  ])(
    "restores a detached $origin install result and refreshes its installed version on the next server",
    ({ origin, installedVersion }) =>
      Effect.gen(function* () {
        const { registry, providersRef } = yield* makeRegistry();
        const recovered = yield* Deferred.make<void>();
        let receipt: InstallSupervisor.InstallReceipt = {
          id: "install",
          provider: CODEX_DRIVER,
          instanceId: CODEX_INSTANCE_ID,
          instanceIds: [CODEX_INSTANCE_ID],
          origin,
          targetVersion: "1.0.0",
          exactVersion: true,
          startedAt: "2026-04-10T00:00:00.000Z",
          finishedAt: "2026-04-10T00:01:00.000Z",
          command: "npm",
          args: [],
          parentPid: 1,
          directory: "",
          result: {
            stdout: "installed",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        };
        if (origin === "manual") {
          const runner = yield* makeTestRunner(
            {
              ...registry,
              getProviderMaintenanceCapabilitiesForInstance: () =>
                Effect.succeed(
                  makeProviderMaintenanceCapabilities({
                    provider: CODEX_DRIVER,
                    packageName: "@openai/codex",
                    updateExecutable: "npm",
                    updateArgs: ["install", "-g", "@openai/codex@latest"],
                    updateLockKey: "npm-global:/owned",
                  }),
                ),
            },
            undefined,
            undefined,
            (input) =>
              Effect.sync(() => {
                receipt = { ...receipt, ...input };
              }),
          );
          yield* runner.updateProvider({ provider: CODEX_DRIVER, origin });
        }
        yield* makeTestRunner(
          {
            ...registry,
            refreshInstance: () =>
              Ref.updateAndGet(providersRef, (providers) =>
                providers.map((provider) => ({ ...provider, version: installedVersion })),
              ),
            setProviderMaintenanceActionState: (input) =>
              registry
                .setProviderMaintenanceActionState(input)
                .pipe(
                  Effect.tap(() =>
                    input.state?.status === "succeeded" ||
                    input.state?.status === "unchanged" ||
                    input.state?.status === "failed"
                      ? Deferred.succeed(recovered, undefined)
                      : Effect.void,
                  ),
                ),
          },
          undefined,
          Effect.succeed([receipt]),
        );
        yield* Deferred.await(recovered);
        const provider = (yield* registry.getProviders)[0];
        assert.equal(provider?.version, installedVersion);
        assert.equal(provider?.updateState?.status, "succeeded");
        assert.equal(provider?.updateState?.origin, origin);
        assert.equal(provider?.updateState?.output, "installed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("1.0.0"),
            layerMockSpawner(() => ({})),
          ),
        ),
      ),
  );

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
      assert.strictEqual(result.providers[0]?.updateState?.origin, "manual");
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
      const { registry, providersRef, updateStatesRef } = yield* makeRegistry([
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
        origin: "background",
      });
      assert.deepStrictEqual(calls, [`install -g --prefix /owned @openai/codex@${targetVersion}`]);
      assert.deepStrictEqual(refreshed, [CODEX_INSTANCE_ID, CODEX_INSTANCE_ID, sibling]);
      assert.strictEqual(
        result.providers[0]?.updateState?.status,
        exitCode === 0 ? "succeeded" : "failed",
      );
      assert.strictEqual(result.providers[1]?.version, targetVersion);
      assert.strictEqual(result.providers[2]?.version, "0.0.0");
      // Background installs need proven ownership, so their origin is covered here.
      assert.isTrue((yield* Ref.get(updateStatesRef)).every((s) => s.origin === "background"));
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
        origin: "background",
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
        origin: "background",
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
                    assert.strictEqual(target.origin, "background");
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
        origin: "background",
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

it.effect.each(["interaction", "opt-out"] as const)(
  "postpones a queued background update after $0 and retries at the next pass",
  (reason) =>
    Effect.gen(function* () {
      const queued = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const installed = yield* Deferred.make<void>();
      let open = true;
      let automaticUpdates = true;
      let launches = 0;
      const { registry, providersRef } = yield* makeRegistry({
        ...baseProvider,
        version: "1.0.0",
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          canUpdate: true,
          canInstallVersion: true,
          updateCommand: "npm install",
          checkedAt: null,
          message: null,
        },
      });
      const runner = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global:/owned",
              installationKey: "codex:/owned",
            }),
          ),
        setProviderMaintenanceActionState: (input) =>
          registry
            .setProviderMaintenanceActionState(input)
            .pipe(
              Effect.tap(() =>
                input.state?.status === "unchanged" || input.state?.status === "succeeded"
                  ? Deferred.succeed(finished, undefined)
                  : Effect.void,
              ),
            ),
        refreshInstance: () =>
          Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) => ({
              ...provider,
              version: launches > 0 ? "2.0.0" : "1.0.0",
            })),
          ),
      }).pipe(
        Effect.provideService(HostLock.ProviderMaintenanceHostLock, {
          directory: "",
          acquireRead: Effect.succeed(Effect.void),
          withRead: (effect) => effect,
          handoff: (effect) => effect,
          withWrite: (effect) =>
            Deferred.succeed(queued, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(effect),
            ),
        }),
        Effect.provide(
          layerMockSpawner(() => {
            launches++;
            return {
              exitCode: Deferred.succeed(installed, undefined).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      );
      yield* Layer.build(
        ProviderAutoUpdater.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig.ServerConfig, {
                devUrl: undefined,
              } as ServerConfig.ServerConfig["Service"]),
              Layer.succeed(ProviderRegistry.ProviderRegistry, {
                ...registry,
                getProviderMaintenanceCapabilitiesForInstance: () =>
                  Effect.succeed(
                    makeProviderMaintenanceCapabilities({
                      provider: CODEX_DRIVER,
                      packageName: "@openai/codex",
                      updateExecutable: "npm",
                      updateArgs: ["install", "-g", "@openai/codex@latest"],
                      updateLockKey: "npm-global:/owned",
                      installationKey: "codex:/owned",
                    }),
                  ),
              }),
              Layer.succeed(ProviderMaintenanceRunner.ProviderMaintenanceRunner, runner),
              Layer.succeed(UpdateWindow.UpdateWindow, {
                runIfOpen: (effect) =>
                  open ? Effect.asSome(effect) : Effect.succeed(Option.none()),
              }),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.sync(() => ({ ...DEFAULT_SERVER_SETTINGS, automaticUpdates })),
              }),
            ),
          ),
        ),
      );
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.await(queued);
      if (reason === "interaction") open = false;
      else automaticUpdates = false;
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
      assert.strictEqual(launches, 0);
      open = true;
      automaticUpdates = true;
      yield* TestClock.adjust("10 minutes");
      yield* Deferred.await(installed);
      assert.strictEqual(launches, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(layerNonWindowsPlatform, layerLatestVersionHttpClient("2.0.0")),
      ),
    ),
);

describe("provider maintenance host leases", () => {
  it.live("reclaims an install lease whose live PID belongs to another process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        assert.isFalse(HostLock.isProcessAlive(process.pid, "previous-process-start"));
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        NodeFS.writeFileSync(
          HostLock.installLeasePath(directory),
          JSON.stringify({ pid: process.pid, identity: "previous-process-start" }),
        );
        assert.isFalse(HostLock.installIsAlive(directory));
        const host = HostLock.make(directory);
        assert.equal(yield* host.withRead(Effect.succeed("launched")), "launched");
        assert.equal(yield* host.withWrite(Effect.succeed("installed")), "installed");
        assert.isFalse(NodeFS.existsSync(HostLock.installLeasePath(directory)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each(["legacy", "matching", "missing", "unknown"] as const)(
    "keeps a live install exclusive with %s identity",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const identity = HostLock.readProcessIdentity(process.pid);
          assert.isNotNull(identity);
          NodeFS.writeFileSync(
            HostLock.installLeasePath(directory),
            mode === "legacy"
              ? String(process.pid)
              : JSON.stringify({
                  pid: process.pid,
                  ...(mode === "missing" ? {} : { identity: mode === "unknown" ? null : identity }),
                }),
          );
          assert.isTrue(HostLock.installIsAlive(directory));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.each(["darwin", "win32"] as const)(
    "checks %s process creation identity conservatively",
    (platform) => {
      const require = NodeModule.createRequire(import.meta.url);
      const mutableOS = require("node:os") as typeof NodeOS;
      const mutableChildProcess = require("node:child_process") as typeof NodeChildProcess;
      const osSpy = vi.spyOn(mutableOS, "platform").mockReturnValue(platform);
      const scan = vi.spyOn(mutableChildProcess, "spawnSync").mockReturnValue({
        pid: 1,
        output: [null, "current-start\n", ""],
        stdout: "current-start\n",
        stderr: "",
        status: 0,
        signal: null,
      });
      NodeModule.syncBuiltinESMExports();
      try {
        assert.equal(HostLock.readProcessIdentity(process.pid), "current-start");
        assert.isTrue(HostLock.isProcessAlive(process.pid, "current-start"));
        assert.isFalse(HostLock.isProcessAlive(process.pid, "previous-start"));
        scan.mockReturnValue({
          pid: 1,
          output: [null, "", ""],
          stdout: "",
          stderr: "",
          status: 1,
          signal: null,
        });
        assert.isNull(HostLock.readProcessIdentity(process.pid));
        assert.isTrue(HostLock.isProcessAlive(process.pid, "previous-start"));
      } finally {
        scan.mockRestore();
        osSpy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }
    },
  );

  it.effect("keeps an install alive when its Linux identity cannot be read", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") return;
      const mutableFS = NodeModule.createRequire(import.meta.url)("node:fs") as typeof NodeFS;
      const readFile = NodeFS.readFileSync;
      const spy = vi
        .spyOn(mutableFS, "readFileSync")
        .mockImplementation((...args: Parameters<typeof readFile>) => {
          if (
            args[0] === "/proc/sys/kernel/random/boot_id" ||
            args[0] === `/proc/${process.pid}/stat`
          )
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          return readFile(...args);
        });
      NodeModule.syncBuiltinESMExports();
      try {
        assert.isNull(HostLock.readProcessIdentity(process.pid));
        assert.isTrue(HostLock.isProcessAlive(process.pid, "previous-start"));
      } finally {
        spy.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }
    }),
  );

  it.live.each(["live children", "failed scan"] as const)(
    "a reused supervisor PID keeps admission closed for %s",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          if ((yield* HostProcess.Platform) !== "linux") return;
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          NodeFS.writeFileSync(
            HostLock.installLeasePath(directory),
            JSON.stringify({ pid: process.pid, identity: "previous-start" }),
          );
          const mutableChildProcess = NodeModule.createRequire(import.meta.url)(
            "node:child_process",
          ) as typeof NodeChildProcess;
          const scan = vi.spyOn(mutableChildProcess, "spawnSync").mockReturnValue({
            pid: 1,
            output: [null, "", ""],
            stdout: `2 ${process.pid} S\n`,
            stderr: "",
            status: mode === "failed scan" ? 1 : 0,
            signal: null,
          });
          NodeModule.syncBuiltinESMExports();
          try {
            if (mode === "failed scan")
              assert.throws(() => HostLock.installIsAlive(directory), /Could not inspect/);
            else assert.isTrue(HostLock.installIsAlive(directory));
          } finally {
            scan.mockRestore();
            NodeModule.syncBuiltinESMExports();
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

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

  it.live.each(["second check", "lease removal"] as const)(
    "releases the acquired gate when %s fails",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const host = HostLock.make(directory);
          const leaseFile = HostLock.installLeasePath(directory);
          const injected = new Error("injected lease failure");
          let checks = 0;
          const mutableFS = NodeModule.createRequire(import.meta.url)("node:fs") as typeof NodeFS;
          const readFile = NodeFS.readFileSync;
          const remove = NodeFS.rmSync;
          const spy =
            failure === "second check"
              ? vi
                  .spyOn(mutableFS, "readFileSync")
                  .mockImplementation((...args: Parameters<typeof readFile>) => {
                    if (args[0] === leaseFile && ++checks === 2) throw injected;
                    return readFile(...args);
                  })
              : vi
                  .spyOn(mutableFS, "rmSync")
                  .mockImplementation((...args: Parameters<typeof remove>) => {
                    if (args[0] === leaseFile) throw injected;
                    return remove(...args);
                  });
          NodeModule.syncBuiltinESMExports();
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              spy.mockRestore();
              NodeModule.syncBuiltinESMExports();
              const { unlock } = await import("proper-lockfile");
              await unlock(NodePath.join(directory, "gate"), { realpath: false }).catch(() => {});
            }),
          );
          const exit = yield* Effect.exit(host.withRead(Effect.void));
          spy.mockRestore();
          NodeModule.syncBuiltinESMExports();
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.strictEqual(Cause.squash(exit.cause), injected);
          assert.isFalse(NodeFS.existsSync(NodePath.join(directory, "gate.lock")));
          yield* HostLock.make(directory).withWrite(Effect.void);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("a joined helper keeps reentrancy after the original session lease releases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = HostLock.make(yield* fs.makeTempDirectoryScoped());
        const release = yield* host.acquireRead;
        const waiting = yield* Deferred.make<void>();
        const installed = yield* Deferred.make<void>();
        const writer = yield* host
          .withWrite(Deferred.succeed(installed, undefined), Deferred.succeed(waiting, undefined))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        yield* host.withRead(release.pipe(Effect.andThen(host.withRead(Effect.void))), release);
        yield* Fiber.join(writer);
        assert.isTrue(yield* Deferred.isDone(installed));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("server admission keeps probes behind another server's install", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cache = yield* fs.makeTempDirectoryScoped();
        const previous = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cache;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = previous;
          }),
        );
        const context = yield* Layer.build(HostLock.layer);
        const host = yield* HostLock.ProviderMaintenanceHostLock.pipe(Effect.provide(context));
        const admission = yield* Maintenance.ProviderMaintenanceAdmission.pipe(
          Effect.provide(context),
        );
        const holder = yield* childLease(host.directory, "withWrite");
        yield* Effect.promise(() => holder.held);
        const entered = yield* Deferred.make<void>();
        const probe = yield* admission
          .withLaunchPermit(Deferred.succeed(entered, undefined))
          .pipe(Effect.forkChild, Effect.provide(context));
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(entered));
        holder.child.stdin.end("release");
        yield* Effect.promise(() => holder.exited);
        yield* Fiber.join(probe);
        assert.isTrue(yield* Deferred.isDone(entered));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

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
        yield* local.withRead(Effect.void, release);
        yield* release;
        assert.isFalse(yield* Deferred.isDone(entered));
        holder.child.stdin.end("release");
        yield* Effect.promise(() => holder.exited);
        yield* Fiber.join(install);
        assert.isTrue(yield* Deferred.isDone(entered));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("blocks unrelated readers behind a waiting writer while admitting turn helpers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = HostLock.make(yield* fs.makeTempDirectoryScoped());
        const entered = yield* Deferred.make<void>();
        const helper = yield* Deferred.make<void>();
        const helperEntered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const turn = yield* host
          .withRead(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(helper)),
              Effect.andThen(host.withRead(Deferred.succeed(helperEntered, undefined))),
              Effect.andThen(Deferred.await(finish)),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const waiting = yield* Deferred.make<void>();
        const installed = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* host
          .withWrite(
            Deferred.succeed(installed, undefined).pipe(
              Effect.andThen(Deferred.await(releaseWriter)),
            ),
            Deferred.succeed(waiting, undefined),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        const unrelatedEntered = yield* Deferred.make<void>();
        const unrelated = yield* Effect.forkChild(
          host.withRead(Deferred.succeed(unrelatedEntered, undefined)),
          { startImmediately: true },
        );
        yield* Deferred.succeed(helper, undefined);
        yield* Deferred.await(helperEntered);
        assert.isFalse(yield* Deferred.isDone(unrelatedEntered));
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(turn);
        yield* Deferred.await(installed);
        assert.isFalse(yield* Deferred.isDone(unrelatedEntered));
        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Fiber.join(writer);
        yield* Fiber.join(unrelated);
        assert.isTrue(yield* Deferred.isDone(unrelatedEntered));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not let an expired turn lease bypass a later writer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = HostLock.make(yield* fs.makeTempDirectoryScoped());
        const release = yield* host.acquireRead;
        const entered = yield* Deferred.make<void>();
        const lateHelper = host.withRead(Deferred.succeed(entered, undefined), release);
        yield* release;
        const writing = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const writer = yield* host
          .withWrite(
            Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(writing);
        const helper = yield* Effect.forkChild(lateHelper, { startImmediately: true });
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(entered));
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(writer);
        yield* Fiber.join(helper);
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

  it.live("cancels a second host reader before the writer releases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = HostLock.make(yield* fs.makeTempDirectoryScoped());
        const writer = yield* childLease(host.directory, "withWrite");
        yield* Effect.promise(() => writer.held);
        const first = yield* Effect.forkChild(host.withRead(Effect.never), {
          startImmediately: true,
        });
        const second = yield* Effect.forkChild(host.withRead(Effect.never), {
          startImmediately: true,
        });
        const cancel = yield* Effect.forkChild(Fiber.interrupt(second), { startImmediately: true });
        yield* Effect.yieldNow;
        const canceledBeforeRelease = second.pollUnsafe() !== undefined;
        writer.child.stdin.end("release");
        yield* Effect.promise(() => writer.exited);
        yield* Fiber.interrupt(first);
        yield* Fiber.join(cancel);
        assert.isTrue(canceledBeforeRelease);
        assert.equal(NodeFS.readdirSync(NodePath.join(host.directory, "readers")).length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("clears queued update state when the host cache is not writable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32" || process.getuid?.() === 0) return;
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        NodeFS.chmodSync(directory, 0o500);
        yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(directory, 0o700)));
        const { registry } = yield* makeRegistry(baseNativeCliProvider);
        const runner = yield* makeTestRunner(registry).pipe(
          Effect.provideService(HostLock.ProviderMaintenanceHostLock, HostLock.make(directory)),
        );
        const result = yield* runner.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        assert.equal((yield* registry.getProviders)[0]?.updateState?.status, "failed");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => {
            throw new Error("must not install");
          }),
        ),
      ),
    ),
  );

  it.live("retains a verification reader after its owning install releases the gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = HostLock.make(yield* fs.makeTempDirectoryScoped());
        const release = yield* host.withWrite(host.acquireRead);
        const waiting = yield* Deferred.make<void>();
        const installed = yield* Deferred.make<void>();
        const writer = yield* host
          .withWrite(Deferred.succeed(installed, undefined), Deferred.succeed(waiting, undefined))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        assert.isFalse(yield* Deferred.isDone(installed));
        yield* release;
        yield* Fiber.join(writer);
        assert.isTrue(yield* Deferred.isDone(installed));
        assert.equal(NodeFS.readdirSync(NodePath.join(host.directory, "readers")).length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("drains host leases before an install closes CLI admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const admission = yield* Maintenance.ProviderMaintenanceAdmission;
        const release = yield* HostLock.make(directory).acquireRead;
        const entered = yield* Deferred.make<void>();
        const gate = waitForGate(directory);
        const install = yield* coordinatedWrite(
          directory,
          Deferred.succeed(entered, undefined),
        ).pipe(Effect.forkScoped);
        yield* gate;
        // A session holding a lease can still launch its CLI while the install waits.
        assert.equal(yield* admission.withLaunchPermit(Effect.succeed("launched")), "launched");
        assert.isFalse(yield* Deferred.isDone(entered));
        yield* release;
        yield* Fiber.join(install);
        assert.isTrue(yield* Deferred.isDone(entered));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps anything but a server off the user-wide gate", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cache = yield* fs.makeTempDirectoryScoped();
      const previous = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = cache;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.XDG_CACHE_HOME;
          else process.env.XDG_CACHE_HOME = previous;
        }),
      );
      const fallback = yield* HostLock.ProviderMaintenanceHostLock;
      assert.isTrue(fallback.directory.startsWith(NodeOS.tmpdir()));
      assert.notStrictEqual(fallback.directory, HostLock.userDirectory());
      const served = yield* HostLock.ProviderMaintenanceHostLock.pipe(
        Effect.provide(HostLock.layer),
      );
      assert.strictEqual(served.directory, HostLock.userDirectory());
      assert.strictEqual(served.directory, NodePath.join(cache, "t3", "provider-maintenance"));
      yield* served.withRead(Effect.void);
      assert.isTrue(NodeFS.existsSync(NodePath.join(served.directory, "readers")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shows a manual update waiting for turns and cancels it before installing", () => {
    const calls: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const hostLock = HostLock.make(yield* fs.makeTempDirectoryScoped());
        const releaseTurn = yield* hostLock.acquireRead;
        const waiting = yield* Deferred.make<void>();
        const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
        const runner = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: (input) =>
            registry
              .setProviderMaintenanceActionState(input)
              .pipe(
                Effect.tap(() =>
                  input.state?.message === "Waiting for running turns to finish."
                    ? Deferred.succeed(waiting, undefined)
                    : Effect.void,
                ),
              ),
        }).pipe(Effect.provideService(HostLock.ProviderMaintenanceHostLock, hostLock));
        const update = yield* runner.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(update);
        yield* releaseTurn;
        assert.deepStrictEqual(
          (yield* Ref.get(updateStatesRef)).map((state) => [state.status, state.message]),
          [
            ["queued", "Waiting for another provider update to finish."],
            ["queued", "Waiting for running turns to finish."],
            ["failed", "Update canceled before installation started."],
          ],
        );
        assert.deepStrictEqual(calls, []);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command) => {
            calls.push(command);
            return {};
          }),
        ),
      ),
    );
  });

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

  it.live.each(["unacknowledged", "existing owner", "reused parent", "reused relay"] as const)(
    "a late supervisor preserves the current host gate (%s)",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const host = HostLock.make(directory);
          const dead = NodeChildProcess.spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => dead.once("exit", () => resolve())),
          );
          assert.ok(dead.pid);
          const file = NodePath.join(directory, "receipt.json");
          NodeFS.writeFileSync(
            file,
            JSON.stringify({
              id: "late",
              provider: CODEX_DRIVER,
              instanceId: CODEX_INSTANCE_ID,
              instanceIds: [CODEX_INSTANCE_ID],
              startedAt: "2026-04-10T00:00:00.000Z",
              parentPid: mode === "reused parent" ? process.pid : dead.pid,
              ...(mode === "reused parent" ? { parentIdentity: "previous-start" } : {}),
              directory,
              command: process.execPath,
              args: ["-e", ""],
            }),
          );
          yield* host.withWrite(
            Effect.gen(function* () {
              if (mode === "existing owner")
                NodeFS.writeFileSync(HostLock.installLeasePath(directory), String(process.pid));
              const child = NodeChildProcess.spawn(
                process.execPath,
                [
                  NodePath.resolve(import.meta.dirname, "../bin.ts"),
                  "__provider-install",
                  file,
                  String(mode === "reused relay" ? process.pid : dead.pid),
                  "previous-start",
                ],
                { stdio: "ignore" },
              );
              const code = yield* Effect.promise(
                () => new Promise<number | null>((resolve) => child.once("exit", resolve)),
              );
              assert.equal(code, mode === "existing owner" ? 1 : 0);
              if (mode === "existing owner") assert.isTrue(HostLock.installIsAlive(directory));
              // Independent admission must still reject the gate while its writer holds it.
              yield* Effect.promise(async () => {
                const { lock } = await import("proper-lockfile");
                try {
                  const release = await lock(NodePath.join(directory, "gate"), { realpath: false });
                  await release();
                } catch (error) {
                  assert.instanceOf(error, Error);
                  assert.equal((error as NodeJS.ErrnoException).code, "ELOCKED");
                  return;
                }
                assert.fail("Unacknowledged supervisor opened another server's gate");
              });
              NodeFS.rmSync(HostLock.installLeasePath(directory), { force: true });
            }),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live.each(["SIGKILL", "SIGTERM", "supervisor"] as const)(
    "keeps an orphaned installer exclusive until it exits (%s)",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          if ((yield* HostProcess.Platform) === "win32") return;
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const stateDir = NodePath.join(directory, "state");
          const started = NodePath.join(directory, "started");
          const finish = NodePath.join(directory, "finish");
          const done = NodePath.join(directory, "done");
          const readerPending = NodePath.join(directory, "reader-pending");
          const writing = NodePath.join(directory, "writing");
          const receiptFile = NodePath.join(stateDir, "provider-updates", "codex.json");
          const waitForFile = (file: string) =>
            Effect.callback<void>((resume) => {
              const watcher = NodeFS.watch(directory, () => {
                if (NodeFS.existsSync(file)) {
                  watcher.close();
                  resume(Effect.void);
                }
              });
              watcher.once("error", (error) => resume(Effect.die(error)));
              if (NodeFS.existsSync(file)) {
                watcher.close();
                resume(Effect.void);
              }
              return Effect.sync(() => watcher.close());
            });
          const installer = `
        const fs = require("node:fs");
        console.log("installer started");
        fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
        let chunks = 0;
        const ticker = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(readerPending)})) return;
          console.log("installer writing chunk " + (++chunks));
          if (chunks === 2) fs.writeFileSync(${JSON.stringify(writing)}, "writing");
        }, 250);
        const watcher = fs.watch(${JSON.stringify(directory)}, () => {
          if (!fs.existsSync(${JSON.stringify(finish)})) return;
          clearInterval(ticker);
          console.log("installer still writing");
          fs.writeFileSync(${JSON.stringify(done)}, "installed");
          watcher.close();
        });
      `;
          const parent = NodeChildProcess.spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
        import * as Effect from "effect/Effect";
        import * as Layer from "effect/Layer";
        import * as NodeServices from "@effect/platform-node/NodeServices";
        import * as HostProcess from "@t3tools/shared/HostProcess";
        import * as Supervisor from ${JSON.stringify(new URL("./ProviderInstallSupervisor.ts", import.meta.url).href)};
        import * as Host from ${JSON.stringify(new URL("./ProviderMaintenanceHostLock.ts", import.meta.url).href)};
        import * as Config from ${JSON.stringify(new URL("../config.ts", import.meta.url).href)};
        const abort = new AbortController();
        process.on("SIGTERM", () => abort.abort());
        const host = Host.make(${JSON.stringify(directory)});
        await Effect.runPromise(Effect.gen(function* () {
          const supervisor = yield* Supervisor.ProviderInstallSupervisor;
          yield* host.withWrite(supervisor.run({
            provider: "codex", instanceId: "codex", instanceIds: ["codex"], origin: "manual",
            startedAt: new Date().toISOString(), command: process.execPath,
            args: ["-e", ${JSON.stringify(installer)}],
          }));
        }).pipe(Effect.provide(Supervisor.layer), Effect.provide(Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(Config.ServerConfig, { stateDir: ${JSON.stringify(stateDir)} }),
          Layer.succeed(Host.ProviderMaintenanceHostLock, host),
          Layer.succeed(HostProcess.Arguments, [process.execPath, ${JSON.stringify(new URL("../bin.ts", import.meta.url).pathname)}]),
        ))), { signal: abort.signal }).catch(() => {});
      `,
            ],
            { cwd: NodePath.resolve(import.meta.dirname, "../.."), stdio: "ignore" },
          );
          const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              const completed = NodeFS.existsSync(started)
                ? new Promise<void>((resolve) => {
                    const watcher = NodeFS.watch(directory, () => {
                      if (NodeFS.existsSync(done)) {
                        watcher.close();
                        resolve();
                      }
                    });
                    if (NodeFS.existsSync(done)) {
                      watcher.close();
                      resolve();
                    }
                  })
                : Promise.resolve();
              NodeFS.writeFileSync(finish, "finish");
              if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
              await exited;
              await completed;
            }),
          );
          yield* waitForFile(started);
          yield* Effect.callback<void>((resume) => {
            const check = () => {
              if (
                NodeFS.existsSync(receiptFile) &&
                InstallSupervisor.readReceipt(receiptFile).progress
              ) {
                watcher.close();
                resume(Effect.void);
              }
            };
            const watcher = NodeFS.watch(NodePath.dirname(receiptFile), check);
            watcher.once("error", (error) => resume(Effect.die(error)));
            check();
            return Effect.sync(() => watcher.close());
          });
          const receipt = InstallSupervisor.readReceipt(receiptFile);
          assert.ok(receipt.pid);
          assert.equal(receipt.parentIdentity, HostLock.readProcessIdentity(receipt.parentPid));
          const lease = yield* decodeInstallLease(
            NodeFS.readFileSync(HostLock.installLeasePath(directory), "utf8"),
          );
          assert.deepEqual(lease, {
            pid: receipt.pid,
            identity: HostLock.readProcessIdentity(receipt.pid),
          });
          assert.isTrue(HostLock.installIsAlive(directory));
          if (mode === "supervisor") {
            assert.ok(receipt.pid);
            process.kill(receipt.pid, "SIGKILL");
          }
          parent.kill(mode === "SIGTERM" ? "SIGTERM" : "SIGKILL");
          yield* Effect.promise(() => exited);
          if (NodeFS.existsSync(NodePath.join(directory, "gate.lock"))) {
            NodeFS.utimesSync(NodePath.join(directory, "gate.lock"), 0, 0);
          }
          assert.isTrue(HostLock.installIsAlive(directory));
          const admitted = yield* Deferred.make<void>();
          const reader = yield* HostLock.make(directory)
            .withRead(
              Effect.sync(() => assert.equal(NodeFS.readFileSync(done, "utf8"), "installed")).pipe(
                Effect.andThen(Deferred.succeed(admitted, undefined)),
              ),
            )
            .pipe(Effect.forkChild);
          NodeFS.writeFileSync(readerPending, "pending");
          yield* waitForFile(writing);
          assert.isFalse(yield* Deferred.isDone(admitted));
          NodeFS.writeFileSync(finish, "finish");
          yield* waitForFile(done);
          yield* Fiber.join(reader);
          if (mode !== "supervisor") {
            assert.equal(InstallSupervisor.readReceipt(receiptFile).result?.exitCode, 0);
            assert.match(
              InstallSupervisor.readReceipt(receiptFile).result?.stdout ?? "",
              /installer still writing/,
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live.each([
    "runtime-replaced",
    "heartbeat-write-error",
    "installer-killed-with-live-child",
    "verbose-output",
  ] as const)(
    "finishes the installer after %s",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const runtime = NodePath.join(directory, "runtime");
          NodeFS.mkdirSync(NodePath.join(runtime, "provider"), { recursive: true });
          const supervisor = NodePath.join(runtime, "provider/ProviderInstallSupervisor.ts");
          NodeFS.copyFileSync(
            NodePath.join(import.meta.dirname, "ProviderInstallSupervisor.ts"),
            supervisor,
          );
          for (const name of ["ProviderMaintenanceHostLock.ts", "providerMaintenanceRunner.ts"])
            NodeFS.symlinkSync(
              NodePath.join(import.meta.dirname, name),
              NodePath.join(runtime, "provider", name),
            );
          NodeFS.symlinkSync(
            NodePath.resolve(import.meta.dirname, "../config.ts"),
            NodePath.join(runtime, "config.ts"),
          );
          NodeFS.symlinkSync(
            NodePath.resolve(import.meta.dirname, "../../node_modules"),
            NodePath.join(runtime, "node_modules"),
          );
          const file = NodePath.join(directory, "receipt.json");
          const installed = NodePath.join(directory, "installed");
          const compacted = NodePath.join(directory, "compacted");
          let heartbeatOutputSize: number | undefined;
          const dead = NodeChildProcess.spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => dead.once("exit", () => resolve())),
          );
          NodeFS.mkdirSync(NodePath.join(directory, "gate.lock"));
          NodeFS.writeFileSync(
            file,
            JSON.stringify({
              id: "runtime-replaced",
              provider: CODEX_DRIVER,
              instanceId: CODEX_INSTANCE_ID,
              instanceIds: [CODEX_INSTANCE_ID],
              startedAt: "2026-04-10T00:00:00.000Z",
              parentPid: process.pid,
              directory,
              command: process.execPath,
              args: [
                "-e",
                mode === "installer-killed-with-live-child"
                  ? `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(installed)}, "installed"), 2500)`)}], {stdio: "ignore"}).on("spawn", () => process.kill(process.pid, "SIGKILL"))`
                  : mode === "verbose-output"
                    ? `const fs = require("node:fs"); console.error("e".repeat(30000) + "\\ninstalling"); console.log("x".repeat(30000)); const watcher = fs.watch(${JSON.stringify(directory)}, () => { if (fs.existsSync(${JSON.stringify(compacted)})) { watcher.close(); fs.writeFileSync(${JSON.stringify(installed)}, "installed"); } });`
                    : `console.log("installing"); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(installed)}, "installed"), ${mode === "heartbeat-write-error" ? 2500 : 0})`,
              ],
            }),
          );
          for (const suffix of [".stdout", ".stderr"]) NodeFS.writeFileSync(file + suffix, "");
          let authorized = false;
          const watcher = NodeFS.watch(directory, () => {
            if (InstallSupervisor.readReceipt(file).pid === undefined) return;
            if (mode === "verbose-output" && !InstallSupervisor.readReceipt(file).progress) {
              if (!authorized) {
                authorized = true;
                NodeFS.writeFileSync(file + ".start", "runtime-replaced");
              }
              return;
            }
            watcher.close();
            if (mode === "verbose-output") {
              heartbeatOutputSize = Math.max(
                NodeFS.statSync(file + ".stdout").size,
                NodeFS.statSync(file + ".stderr").size,
              );
              NodeFS.writeFileSync(compacted, "continue");
              return;
            }
            if (mode === "runtime-replaced")
              NodeFS.rmSync(NodePath.join(runtime, "provider/providerMaintenanceRunner.ts"));
            NodeFS.writeFileSync(file + ".start", "runtime-replaced");
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
          const child = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const outputs =
                mode === "verbose-output"
                  ? [NodeFS.openSync(file + ".stdout", "a"), NodeFS.openSync(file + ".stderr", "a")]
                  : [];
              try {
                return NodeChildProcess.spawn(
                  process.execPath,
                  [
                    "--input-type=module",
                    "-e",
                    `import * as fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
             import { runInstallSubcommand } from ${JSON.stringify(supervisor)};
             ${
               mode === "heartbeat-write-error"
                 ? `const original = fs.default.utimesSync; let failed = false;
               fs.default.utimesSync = (...args) => { if (!failed) { failed = true; throw Object.assign(new Error("full disk"), {code: "ENOSPC"}); } return original(...args); };
               syncBuiltinESMExports();`
                 : ""
             }
             await runInstallSubcommand("__provider-install", ${JSON.stringify([file, String(dead.pid)])});`,
                  ],
                  {
                    stdio:
                      mode === "verbose-output" ? ["ignore", outputs[0]!, outputs[1]!] : "ignore",
                    detached: true,
                  },
                );
              } finally {
                for (const fd of outputs) NodeFS.closeSync(fd);
              }
            }),
            (child) =>
              Effect.sync(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              }),
          );
          const code = yield* Effect.promise(
            () => new Promise<number | null>((resolve) => child.once("exit", resolve)),
          );
          const finishedBeforeChildren = !NodeFS.existsSync(installed);
          if (mode !== "runtime-replaced")
            yield* Effect.callback<void>((resume) => {
              const complete = () => {
                if (!NodeFS.existsSync(installed)) return;
                watcher.close();
                resume(Effect.void);
              };
              const watcher = NodeFS.watch(directory, complete);
              complete();
              return Effect.sync(() => watcher.close());
            });
          assert.equal(code, 0);
          if (mode === "verbose-output") {
            assert.isAtMost(heartbeatOutputSize!, 20_000);
            assert.isTrue(InstallSupervisor.readReceipt(file).result?.stdoutTruncated);
            assert.equal(InstallSupervisor.readReceipt(file).progress, "installing");
          }
          if (mode === "installer-killed-with-live-child") {
            assert.isFalse(
              finishedBeforeChildren,
              "lease released before installer child finished",
            );
            assert.isFalse(HostLock.installIsAlive(directory));
          } else assert.equal(InstallSupervisor.readReceipt(file).result?.exitCode, 0);
          assert.equal(NodeFS.readFileSync(installed, "utf8"), "installed");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    30_000,
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
describe("update window short circuit", () => {
  it.effect("does not query threads, providers or tasks during the quiet period", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        UpdateWindow.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                sinceLastClientInteraction: Effect.succeed(Duration.minutes(14)),
              }),
              SqlitePersistence.layerMemory,
              Layer.mock(ServerSettings.ServerSettingsService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            ),
          ),
        ),
      );
      const window = yield* Effect.service(UpdateWindow.UpdateWindow).pipe(Effect.provide(context));
      let ran = false;
      assert.isTrue(
        Option.isNone(
          yield* window.runIfOpen(
            Effect.sync(() => {
              ran = true;
            }),
          ),
        ),
      );
      assert.isFalse(ran);
    }),
  );

  it.effect("stops at active work after exactly fifteen quiet minutes", () =>
    Effect.gen(function* () {
      let reads = 0;
      const context = yield* Layer.build(
        UpdateWindow.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () =>
                  Effect.sync(() => {
                    reads++;
                    return [ThreadContracts.ThreadId.make("busy")];
                  }),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                sinceLastClientInteraction: Effect.succeed(Duration.minutes(15)),
              }),
              SqlitePersistence.layerMemory,
              Layer.mock(ServerSettings.ServerSettingsService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            ),
          ),
        ),
      );
      const window = yield* Effect.service(UpdateWindow.UpdateWindow).pipe(Effect.provide(context));
      assert.isTrue(Option.isNone(yield* window.runIfOpen(Effect.die("must not install"))));
      assert.strictEqual(reads, 1);
    }),
  );

  it.effect("stops at provider background work before reading update state or SQL", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        UpdateWindow.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([]),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                hasPendingBackgroundWork: Effect.succeed(true),
              }),
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                sinceLastClientInteraction: Effect.succeed(Duration.minutes(15)),
              }),
              SqlitePersistence.layerMemory,
              Layer.mock(ServerSettings.ServerSettingsService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            ),
          ),
        ),
      );
      const window = yield* Effect.service(UpdateWindow.UpdateWindow).pipe(Effect.provide(context));
      assert.isTrue(Option.isNone(yield* window.runIfOpen(Effect.die("must not install"))));
    }),
  );
});

it.effect("manual updates wait for admission and verify under the same permit", () =>
  Effect.gen(function* () {
    const admission = yield* Maintenance.ProviderMaintenanceAdmission;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* admission
      .withPermit(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const { registry } = yield* makeRegistry(baseNativeCliProvider);
    const updater = yield* makeTestRunner({
      ...registry,
      refreshInstance: () => admission.withPermit(registry.getProviders),
    });
    const update = yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.isTrue(update.pollUnsafe() === undefined);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    const result = yield* Fiber.join(update);
    assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
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

it.effect.each([
  {
    name: "open provider window",
    restart: false,
    busy: false,
    installing: false,
    interaction: false,
    expected: true,
    updatedInstance: null,
  },
  {
    name: "open restart window",
    restart: true,
    busy: false,
    installing: false,
    interaction: false,
    expected: true,
    updatedInstance: null,
  },
  {
    name: "busy terminal",
    restart: true,
    busy: true,
    installing: false,
    interaction: false,
    expected: false,
    updatedInstance: null,
  },
  {
    name: "managed first install",
    restart: true,
    busy: false,
    installing: true,
    interaction: false,
    expected: false,
    updatedInstance: null,
  },
  {
    name: "interaction arriving during blocker reads",
    restart: false,
    busy: false,
    installing: false,
    interaction: true,
    expected: false,
    updatedInstance: null,
  },
  {
    name: "its own queued update",
    restart: false,
    busy: false,
    installing: false,
    interaction: false,
    expected: true,
    updatedInstance: CODEX_INSTANCE_ID,
  },
  {
    name: "another queued update",
    restart: false,
    busy: false,
    installing: false,
    interaction: false,
    expected: false,
    updatedInstance: ProviderInstanceId.make("other"),
  },
])("rechecks the update window for $name", (scenario) =>
  Effect.gen(function* () {
    let quietReads = 0;
    let handoffs = 0;
    const context = yield* Layer.build(
      UpdateWindow.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([]),
              getLimitRecoveryCandidates: () => Effect.succeed([]),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              hasPendingBackgroundWork: Effect.succeed(false),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              sinceLastClientInteraction: Effect.sync(() =>
                Duration.minutes(++quietReads > 1 && scenario.interaction ? 0 : 15),
              ),
            }),
            SqlitePersistence.layerMemory,
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(ThreadContracts.DEFAULT_SERVER_SETTINGS),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(
                scenario.updatedInstance === null
                  ? []
                  : [
                      {
                        ...baseProvider,
                        instanceId: scenario.updatedInstance,
                        updateState: {
                          status: "queued",
                          startedAt: null,
                          finishedAt: null,
                          message: null,
                          output: null,
                        },
                      },
                    ],
              ),
            }),
            Layer.mock(CodexInstallation.CodexInstallation)({
              managedDirectory: "/managed/codex",
              state: Effect.succeed({
                driver: ProviderDriverKind.make("codex"),
                phase: scenario.installing ? "verifying" : "idle",
                operationId: null,
                downloadedBytes: 0,
                totalBytes: null,
                version: null,
                installedVersion: null,
                canRemove: false,
                message: null,
              }),
            }),
            Layer.mock(AntigravityInstallation.AntigravityInstallation)({
              managedDirectory: "/managed/antigravity",
              state: Effect.succeed({
                driver: ProviderDriverKind.make("antigravity"),
                phase: "idle",
                operationId: null,
                downloadedBytes: 0,
                totalBytes: null,
                version: null,
                installedVersion: null,
                canRemove: false,
                message: null,
              }),
            }),
            Layer.mock(TerminalManager.TerminalManager)({
              withIdleTerminals: (effect) =>
                scenario.busy ? Effect.succeed(Option.none()) : Effect.asSome(effect),
            }),
          ),
        ),
      ),
    );
    const window = yield* Effect.service(UpdateWindow.UpdateWindow).pipe(Effect.provide(context));
    const result = yield* window.runIfOpen(
      Effect.sync(() => {
        handoffs++;
      }),
      { restartsServer: scenario.restart, updatingInstanceId: CODEX_INSTANCE_ID },
    );
    assert.strictEqual(Option.isSome(result), scenario.expected);
    assert.strictEqual(handoffs, scenario.expected ? 1 : 0);
  }),
);
