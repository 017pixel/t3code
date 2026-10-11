// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  createProviderVersionAdvisory,
  makeTargetedProviderUpdateAction,
  enrichProviderSnapshotWithVersionAdvisory,
  homebrewOwnershipFromCommandPath,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  npmGlobalPrefixFromCommandPath,
  parseHomebrewLatestVersion,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "./maintenanceResolver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const driver = (value: string) => ProviderDriverKind.make(value);
// These write `#!/bin/sh` stubs and evaluate them with darwin/linux path
// semantics; a Windows temp path cannot be split on `:`.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.map((id) => NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), `${name}-${id}`)),
  );
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("packageTool"),
  driver: driver("packageTool"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const manualPackageTool: ProviderMaintenanceCapabilities = {
  provider: driver("packageTool"),
  packageName: "@example/package-tool",
  update: null,
};

function writeExecutable(path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\n");
  NodeFS.chmodSync(path, 0o755);
}

/** Symlink `<tempDir>/bin/<name>` into a package entry point, like npm/pnpm do. */
function linkIntoPackage(tempDir: string, name: string, packageSegments: ReadonlyArray<string>) {
  const target = NodePath.join(tempDir, ...packageSegments, "bin", `${name}.js`);
  writeExecutable(target);
  const link = NodePath.join(tempDir, "bin", name);
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
}

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("maintenance resolution should not spawn a process here"),
);

function stdoutSpawner(onSpawn: (command: string, args: ReadonlyArray<string>) => string) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.layer(NodeServices.layer)("providerMaintenance", (it) => {
  it.effect("reads cached versions through ProviderLatestVersions", () =>
    resolveLatestProviderVersion(manualPackageTool).pipe(
      Effect.provideServiceEffect(
        ProviderLatestVersions.ProviderLatestVersions,
        ProviderLatestVersions.make([["@example/package-tool", "9.9.9"]]),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("cached provider version should not make an HTTP request"),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("9.9.9");
      }),
    ),
  );

  it.effect("prefers the installer's own latest version over the npm registry", () =>
    resolveLatestProviderVersion({ ...manualPackageTool, latestVersion: "1.2.0" }).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("installer-reported latest should not make an HTTP request"),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("1.2.0");
      }),
    ),
  );

  it.effect("does not fetch latest provider versions when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(installedPackageToolProvider, manualPackageTool, {
      enableProviderUpdateChecks: false,
    }).pipe(
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("disabled provider update checks should not make an HTTP request"),
        ),
      ),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: "1.0.0",
          latestVersion: null,
          checkedAt: "2026-04-10T00:00:00.000Z",
        });
      }),
    ),
  );

  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("keeps the manual update hint when the install is behind but unowned", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: manualPackageTool,
      }),
    ).toMatchObject({
      status: "behind_latest",
      latestVersion: "2.1.117",
      updateCommand: null,
      canUpdate: false,
      message: "Install the update now or review provider settings.",
    });
  });

  it.effect("stays manual-only when the binary cannot be located", () =>
    resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
      binaryPath: "package-tool",
      env: { PATH: "" },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.map((capabilities) => {
        expect(capabilities).toEqual(manualPackageTool);
      }),
    ),
  );

  it.effect.each(["", ".nvm/versions/node/24", "Cellar/node/24"])(
    "pins npm updates to the owning global prefix even under %s",
    (prefix) =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("t3-npm-capabilities");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const tempDir = NodePath.join(root, prefix);
        const link = linkIntoPackage(tempDir, "package-tool", [
          "lib",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update?.installationKey).toBeDefined();
        expect(capabilities).toMatchObject({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command: `npm install -g --prefix ${tempDir} --allow-scripts=@example/package-tool @example/package-tool@latest`,
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              tempDir,
              "--allow-scripts=@example/package-tool",
              "@example/package-tool@latest",
            ],
            lockKey: `npm-global:${normalizeCommandPath(tempDir)}`,
          },
        });
      }).pipe(Effect.scoped),
    { skip: windowsHost || !symlinksSupported },
  );

  it("derives the npm prefix only from the global lib/node_modules layout", () => {
    expect(
      npmGlobalPrefixFromCommandPath(
        "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBe("/usr/local");
    // A copy nested inside another package is not a global install.
    expect(
      npmGlobalPrefixFromCommandPath(
        "/usr/local/lib/node_modules/other/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBeNull();
    expect(
      npmGlobalPrefixFromCommandPath(
        "/lib/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBe("/");
    // Neither is a project-local dependency.
    expect(
      npmGlobalPrefixFromCommandPath(
        "/work/app/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBeNull();
  });

  // The Codex Windows installer exposes `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin`
  // as a junction into `%CODEX_HOME%\\packages\\standalone\\current\\bin`. Node's
  // realpath follows junctions, so the real path carries the standalone marker
  // even though the visible path does not.
  it.effect("recognizes a Windows standalone install through its junctioned bin dir", () =>
    Effect.gen(function* () {
      const visiblePath =
        "C:\\Users\\Theo\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
      const realPath =
        "C:\\Users\\Theo\\.codex\\packages\\standalone\\releases\\0.120.0-x86_64\\bin\\codex.exe";
      const capabilities = yield* resolvePackageManagedProviderMaintenance(
        {
          provider: driver("codex"),
          npmPackageName: "@openai/codex",
          nativeUpdate: {
            args: ["update"],
            isCommandPath: isNativeTestCommandPath("/packages/standalone/"),
          },
        },
        {
          binaryPath: "codex",
          resolvedCommandPath: visiblePath,
          realCommandPath: realPath,
          env: {},
          platform: "win32",
        },
      ).pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(capabilities.update).toMatchObject({
        executable: visiblePath,
        args: ["update"],
        lockKey: "codex-native",
      });
    }),
  );

  it.effect("proves Windows npm ownership from the package manifest beside the shim", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-windows-capabilities");
      const shim = NodePath.join(tempDir, "package-tool.cmd");
      NodeFS.mkdirSync(tempDir, { recursive: true });
      NodeFS.writeFileSync(shim, "@echo off\r\n");
      NodeFS.mkdirSync(NodePath.join(tempDir, "node_modules", "@example", "package-tool"), {
        recursive: true,
      });
      NodeFS.writeFileSync(
        NodePath.join(tempDir, "node_modules", "@example", "package-tool", "package.json"),
        "{}",
      );

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: shim,
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

      expect(capabilities.update).toMatchObject({
        executable: "npm",
        args: ["install", "-g", "--prefix", tempDir, expect.any(String), expect.any(String)],
      });

      // The same layout on POSIX is a project checkout, not a global install.
      const script = NodePath.join(tempDir, "package-tool");
      writeExecutable(script);
      const posix = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: script,
        env: { PATH: "" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );
      expect(posix.update).toBeNull();
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "switches to pnpm updates when the real path lives in pnpm's global store",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-capabilities");
        const link = linkIntoPackage(tempDir, "package-tool", [
          ".local",
          "share",
          "pnpm",
          "global",
          "5",
          "node_modules",
          "@example",
          "package-tool",
        ]);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toMatchObject({
          command: "pnpm add -g @example/package-tool@latest",
          lockKey: "pnpm-global",
        });
      }),
  );

  it.effect.skipIf(windowsHost)(
    "switches to bun updates when the resolved binary lives in bun's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-bun-capabilities");
        const bunBinDir = NodePath.join(tempDir, ".bun", "bin");
        writeExecutable(NodePath.join(bunBinDir, "package-tool"));

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: "package-tool",
            env: { PATH: bunBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );

        expect(capabilities.update).toMatchObject({
          command: "bun i -g @example/package-tool@latest",
          lockKey: "bun-global",
        });
      }),
  );

  it.effect.skipIf(windowsHost)("switches to native updates and runs the resolved executable", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-capabilities");
      const nativeBinDir = NodePath.join(tempDir, ".local", "bin");
      const nativePath = NodePath.join(nativeBinDir, "native-package-tool");
      writeExecutable(nativePath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        nativePackageToolUpdate,
        {
          binaryPath: "native-package-tool",
          env: { PATH: nativeBinDir },
        },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

      expect(capabilities).toMatchObject({
        provider: driver("nativePackageTool"),
        packageName: "@example/native-package-tool",
        update: {
          command: `${nativePath} update`,
          executable: nativePath,
          args: ["update"],
          lockKey: "nativePackageTool-native",
        },
      });
    }),
  );

  // Regression for #9850: an explicit native path outside PATH, with spaces,
  // must be what actually gets spawned.
  it.effect.skipIf(windowsHost)("runs an explicit native updater outside PATH", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-update");
      const nativePath = NodePath.join(
        tempDir,
        "with spaces",
        ".local",
        "bin",
        "native-package-tool",
      );
      NodeFS.mkdirSync(NodePath.dirname(nativePath), { recursive: true });
      NodeFS.writeFileSync(nativePath, "#!/bin/sh\nprintf '%s' \"$1\"\n");
      NodeFS.chmodSync(nativePath, 0o755);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        nativePackageToolUpdate,
        { binaryPath: nativePath, env: { PATH: "" } },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update?.executable).toBe(nativePath);
      const result = NodeChildProcess.spawnSync(
        capabilities.update!.executable,
        capabilities.update!.args,
        { env: { PATH: "" }, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("update");
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "prefers npm ownership over the Node keg the package lives under",
    () =>
      Effect.gen(function* () {
        // `brew install node` keeps npm globals inside the node keg.
        const tempDir = yield* makeTempDir("t3-homebrew-node-capabilities");
        const keg = NodePath.join(tempDir, "Cellar", "node", "22.1.0");
        const target = NodePath.join(
          keg,
          "lib",
          "node_modules",
          "@example",
          "package-tool",
          "bin",
          "package-tool.js",
        );
        writeExecutable(target);
        const link = NodePath.join(tempDir, "bin", "package-tool");
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(target, link);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toMatchObject({
          executable: "npm",
          args: expect.arrayContaining(["--prefix", keg]),
          lockKey: `npm-global:${normalizeCommandPath(keg)}`,
        });
      }),
  );

  it("quotes copyable command words the shell would split", () => {
    const posix = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        "/Users/Jane Doe/.npm-global",
        "@example/package-tool@latest",
      ],
      updateLockKey: "npm-global",
      platform: "darwin",
    });
    expect(posix.update?.command).toBe(
      "npm install -g --prefix '/Users/Jane Doe/.npm-global' @example/package-tool@latest",
    );
    const windows = makeProviderMaintenanceCapabilities({
      provider: driver("packageTool"),
      packageName: null,
      updateExecutable: "C:\\Program Files\\Tool\\tool.exe",
      updateArgs: ["update"],
      updateLockKey: "tool",
      platform: "win32",
    });
    expect(windows.update?.command).toBe("& 'C:\\Program Files\\Tool\\tool.exe' update");
  });

  it.effect.skipIf(windowsHost)("carries the native updater's environment into the action", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-env");
      const nativePath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");
      writeExecutable(nativePath);
      const resolver = makePackageManagedProviderMaintenanceResolver({
        provider: driver("nativePackageTool"),
        npmPackageName: "@example/native-package-tool",
        nativeUpdate: {
          args: ["update"],
          isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
          env: { TOOL_HOME: tempDir },
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(resolver, {
        binaryPath: nativePath,
        env: { PATH: "" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update?.env).toEqual({ PATH: "", TOOL_HOME: tempDir });
    }),
  );

  it("recognizes Homebrew kegs and casks from the real executable path", () => {
    expect(
      homebrewOwnershipFromCommandPath("/opt/homebrew/Cellar/claude-code@latest/2.1.0/bin/claude"),
    ).toEqual({ kind: "formula", name: "claude-code@latest", prefix: "/opt/homebrew" });
    expect(homebrewOwnershipFromCommandPath("/usr/local/Caskroom/codex/0.148.0/codex")).toEqual({
      kind: "cask",
      name: "codex",
      prefix: "/usr/local",
    });
    // A plain /usr/local/bin binary is not evidence of Homebrew (#8832).
    expect(homebrewOwnershipFromCommandPath("/usr/local/bin/codex")).toBeNull();
    // A keg elsewhere reports its prefix so the resolver can reject it against
    // `brew --prefix`.
    expect(homebrewOwnershipFromCommandPath("/srv/Cellar/claude/1.0.0/bin/claude")).toMatchObject({
      prefix: "/srv",
    });
  });

  it.effect.skipIf(windowsHost)(
    "stays manual-only for an explicit binary path that does not exist",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-missing-native-capabilities");
        const missingPath = NodePath.join(tempDir, ".local", "bin", "native-package-tool");

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath: missingPath, env: { PATH: "" } },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities.update).toBeNull();
      }),
  );

  it.effect.each([
    { directory: "Caskroom", name: "package-tool", kind: "cask" },
    { directory: "Cellar", name: "package-tool", kind: "formula" },
    { directory: "Cellar", name: "package-tool@latest", kind: "formula" },
  ] as const)(
    "upgrades the owning Homebrew $kind $name through an executable alias",
    (fixture) =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-homebrew-capabilities");
        const brewBinDir = NodePath.join(tempDir, "brew-bin");
        const brewPath = NodePath.join(brewBinDir, "brew");
        writeExecutable(brewPath);
        const ownedBinary = NodePath.join(
          tempDir,
          fixture.directory,
          fixture.name,
          "0.148.0",
          "package-tool-0.148.0",
        );
        writeExecutable(ownedBinary);
        const link = NodePath.join(tempDir, "bin", "custom-package-tool");
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(ownedBinary, link);
        const spawned: Array<ReadonlyArray<string>> = [];

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: link,
            env: { PATH: brewBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner((command, args) => {
              spawned.push([command, ...args]);
              return args[0] === "--prefix"
                ? `${tempDir}\n`
                : JSON.stringify(
                    fixture.kind === "cask"
                      ? { casks: [{ version: "0.148.0,42" }] }
                      : { formulae: [{ versions: { stable: "0.148.0" } }] },
                  );
            }),
          ),
        );

        expect(spawned).toEqual([
          [brewPath, "--prefix"],
          [brewPath, "info", "--json=v2", fixture.name],
        ]);
        expect(capabilities).toMatchObject({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          latestVersion: "0.148.0",
          update: {
            command:
              fixture.kind === "cask"
                ? `brew upgrade --cask ${fixture.name}`
                : `brew upgrade ${fixture.name}`,
            executable: brewPath,
            args:
              fixture.kind === "cask"
                ? ["upgrade", "--cask", fixture.name]
                : ["upgrade", fixture.name],
            lockKey: "homebrew",
          },
        });
      }),
    { skip: !symlinksSupported },
  );

  it.effect.skipIf(windowsHost)(
    "stays manual-only when the keg is not under the resolved brew's prefix",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-homebrew-foreign-prefix");
        const brewBinDir = NodePath.join(tempDir, "brew-bin");
        writeExecutable(NodePath.join(brewBinDir, "brew"));
        const kegBinary = NodePath.join(
          tempDir,
          "elsewhere",
          "Cellar",
          "package-tool",
          "1.0.0",
          "bin",
          "package-tool",
        );
        writeExecutable(kegBinary);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: kegBinary,
            env: { PATH: brewBinDir },
          },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(() => "/opt/homebrew\n"),
          ),
        );

        expect(capabilities).toEqual(manualPackageTool);
      }),
  );

  it("reads the stable formula version from brew info", () => {
    const info = JSON.stringify({ formulae: [{ versions: { stable: "2.1.5" } }] });
    const formula = { kind: "formula", name: "claude-code", prefix: "/opt/homebrew" } as const;
    expect(parseHomebrewLatestVersion(info, formula)).toBe("2.1.5");
    expect(parseHomebrewLatestVersion("not json", formula)).toBeNull();
  });

  it.effect.skipIf(windowsHost)(
    "disables one-click updates for explicit custom binary paths it cannot safely map",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-custom-capabilities");
        const customPath = NodePath.join(tempDir, "tools", "package-tool");
        writeExecutable(customPath);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: customPath,
            env: { PATH: "" },
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect(capabilities).toEqual(manualPackageTool);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "falls back to the provider's own updater when no installer is proven",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-self-update-fallback");
        const customPath = NodePath.join(tempDir, "tools", "package-tool");
        writeExecutable(customPath);
        const selfUpdating = makePackageManagedProviderMaintenanceResolver({
          provider: driver("packageTool"),
          npmPackageName: "@example/package-tool",
          nativeUpdate: { args: ["update", "--self"] },
        });

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(selfUpdating, {
          binaryPath: customPath,
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        expect(capabilities.update).toMatchObject({
          executable: customPath,
          args: ["update", "--self"],
          lockKey: "packageTool-native",
        });

        // A mise install is pinned in mise's config, so it stays manual.
        const misePath = NodePath.join(tempDir, "mise", "installs", "package-tool", "1.0.0", "bin");
        writeExecutable(NodePath.join(misePath, "package-tool"));
        const mise = yield* resolveProviderMaintenanceCapabilitiesEffect(selfUpdating, {
          binaryPath: NodePath.join(misePath, "package-tool"),
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        expect(mise.update).toBeNull();
      }),
  );

  it.effect.skipIf(!symlinksSupported)("updates Yarn global installs with yarn", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-yarn-capabilities");
      const link = linkIntoPackage(tempDir, "package-tool", [
        ".config",
        "yarn",
        "global",
        "node_modules",
        "@example",
        "package-tool",
      ]);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: link,
        env: { PATH: "" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities.update).toMatchObject({
        command: "yarn global add @example/package-tool@latest",
        lockKey: "yarn-global",
      });
      expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0")?.args).toEqual([
        "global",
        "add",
        "@example/package-tool@2.0.0",
      ]);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "updates Volta installs only when Volta has the package",
    () =>
      Effect.gen(function* () {
        const voltaHome = NodePath.join(yield* makeTempDir("t3-volta-capabilities"), ".volta");
        const shim = NodePath.join(voltaHome, "bin", "volta-shim");
        writeExecutable(shim);
        const link = NodePath.join(voltaHome, "bin", "package-tool");
        NodeFS.symlinkSync(shim, link);
        const resolve = resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
          binaryPath: link,
          env: { PATH: "" },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

        expect((yield* resolve).update).toBeNull();
        NodeFS.mkdirSync(
          NodePath.join(voltaHome, "tools", "image", "packages", "@example", "package-tool"),
          { recursive: true },
        );
        expect((yield* resolve).update).toMatchObject({
          command: "volta install @example/package-tool@latest",
          lockKey: "volta",
        });
      }),
  );

  it.effect.skipIf(windowsHost)("upgrades with the keg's own brew when brew is not on PATH", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-homebrew-keg-brew");
      const brewPath = NodePath.join(tempDir, "bin", "brew");
      writeExecutable(brewPath);
      const kegBinary = NodePath.join(tempDir, "Cellar", "package-tool", "1.0.0", "bin", "tool");
      writeExecutable(kegBinary);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: kegBinary,
        env: { PATH: "" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((_command, args) => (args[0] === "--prefix" ? `${tempDir}\n` : "{}")),
        ),
      );

      expect(capabilities.update).toMatchObject({
        executable: brewPath,
        args: ["upgrade", "package-tool"],
        lockKey: "homebrew",
      });
    }),
  );

  it.effect.each(["npm", "pnpm", "bun", "yarn", "volta", "vp", "brew", "native"] as const)(
    "executes the owning %s updater with the instance environment",
    (method) =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-execution");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const tools = NodePath.join(root, "tools");
        const env = {
          PATH: tools,
          BUN_INSTALL: NodePath.join(root, "custom-bun"),
          npm_config_prefix: NodePath.join(root, "other-prefix"),
          npm_config_registry: "https://private.invalid/",
          CODEX_HOME: NodePath.join(root, "instance-home"),
        };
        const executable = NodePath.join(tools, method === "native" ? "package-tool" : method);
        writeExecutable(executable);
        NodeFS.writeFileSync(
          executable,
          `#!/bin/sh\nprintf '%s\n' "$BUN_INSTALL" "$npm_config_prefix" "$CODEX_HOME" "$npm_config_registry" "$@"\n`,
        );
        const nativeRoot = NodePath.join(root, ".local", "bin");
        const resolved =
          method === "bun"
            ? NodePath.join(env.BUN_INSTALL, "bin", "package-tool")
            : method === "vp"
              ? NodePath.join(root, ".vite-plus", "bin", "package-tool")
              : method === "volta"
                ? NodePath.join(root, ".volta", "bin", "package-tool")
                : method === "native"
                  ? NodePath.join(nativeRoot, "package-tool")
                  : NodePath.join(root, "bin", "package-tool");
        const real =
          method === "npm"
            ? NodePath.join(
                root,
                "lib",
                "node_modules",
                "@example",
                "package-tool",
                "bin",
                "tool.js",
              )
            : method === "pnpm"
              ? NodePath.join(
                  root,
                  ".local",
                  "share",
                  "pnpm",
                  "global",
                  "node_modules",
                  "@example",
                  "package-tool",
                  "bin",
                  "tool.js",
                )
              : method === "yarn"
                ? NodePath.join(
                    root,
                    ".config",
                    "yarn",
                    "global",
                    "node_modules",
                    "@example",
                    "package-tool",
                    "bin",
                    "tool.js",
                  )
                : method === "volta"
                  ? NodePath.join(root, ".volta", "bin", "volta-shim")
                  : method === "brew"
                    ? NodePath.join(root, "Cellar", "package-tool", "1.0.0", "bin", "tool")
                    : resolved;
        writeExecutable(real);
        if (method === "native") NodeFS.copyFileSync(executable, resolved);
        if (method === "volta")
          NodeFS.mkdirSync(
            NodePath.join(root, ".volta", "tools", "image", "packages", "@example", "package-tool"),
            { recursive: true },
          );
        const resolver = {
          provider: driver("packageTool"),
          npmPackageName: "@example/package-tool",
          nativeUpdate: {
            args: ["update"],
            isCommandPath: isNativeTestCommandPath("/.local/bin/package-tool"),
            env: { CODEX_HOME: "shared-home" },
          },
        };
        const capabilities = yield* resolvePackageManagedProviderMaintenance(resolver, {
          binaryPath: resolved,
          resolvedCommandPath: resolved,
          realCommandPath: real,
          env,
          platform: "linux",
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner((_command, args) =>
              args[0] === "--prefix"
                ? root
                : JSON.stringify({ formulae: [{ versions: { stable: "2.0.0" } }] }),
            ),
          ),
        );
        const action = capabilities.update!;
        expect(action).not.toBeNull();
        const expectedEnv = method === "native" ? { ...env, CODEX_HOME: "shared-home" } : env;
        expect(action.env).toEqual(expectedEnv);
        expect(action.installationKey).toBeDefined();
        const result = NodeChildProcess.spawnSync(action.executable, action.args, {
          env: { ...process.env, ...action.env },
          encoding: "utf8",
        });
        expect(result.status).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([
          env.BUN_INSTALL,
          env.npm_config_prefix,
          expectedEnv.CODEX_HOME,
          env.npm_config_registry,
          ...action.args,
        ]);
        if (method === "npm") expect(action.args).toContain(root);
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.each([
    "installs/npm-codex/1.0.0/lib/node_modules/@example/package-tool/bin/tool.js",
    "installs/package-tool/1.0.0/bin/tool",
    "shims/tool",
  ])(
    "keeps custom MISE_DATA_DIR %s manual-only before choosing an updater",
    (suffix) =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-mise");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const binary = NodePath.join(root, "custom-data", suffix);
        writeExecutable(binary);
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          makePackageManagedProviderMaintenanceResolver({
            provider: driver("packageTool"),
            npmPackageName: "@example/package-tool",
            nativeUpdate: { args: ["update"] },
          }),
          {
            binaryPath: binary,
            env: { PATH: "", MISE_DATA_DIR: NodePath.join(root, "custom-data") },
          },
        );
        expect(capabilities.update).toBeNull();
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "allows npm globals in custom mise Node installs but keeps wrappers manual",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-mise-node");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const binary = NodePath.join(
          root,
          "data",
          "installs",
          "node",
          "24",
          "lib",
          "node_modules",
          "@example",
          "package-tool",
          "bin",
          "tool.js",
        );
        writeExecutable(binary);
        const env = { PATH: "", MISE_DATA_DIR: NodePath.join(root, "data") };
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: binary,
            env,
          },
        );
        expect(capabilities.update?.executable).toBe("npm");
        NodeFS.writeFileSync(binary, "#!/bin/sh\nexec mise x package-tool -- package-tool\n");
        expect(
          (yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
            binaryPath: binary,
            env,
          })).update,
        ).toBeNull();
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "distinguishes automatic native installs from custom pinned and SDK binaries",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-ownership");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        for (const suffix of [
          "opt/pinned/tool",
          "node_modules/@example/sdk/bin/tool",
          ".local/bin/native-package-tool",
        ]) {
          const binary = NodePath.join(root, suffix);
          writeExecutable(binary);
          const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
            nativePackageToolUpdate,
            { binaryPath: binary, env: { PATH: "" } },
          );
          if (suffix.startsWith(".local"))
            expect(capabilities.update?.installationKey).toBeDefined();
          else expect(capabilities.update?.installationKey).toBeUndefined();
          if (suffix.startsWith("opt")) expect(capabilities.update?.args).toEqual(["update"]);
          if (suffix.startsWith("node_modules")) expect(capabilities.update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "native aliases share stable ownership but configured release paths stay pinned",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-native-alias");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const release = NodePath.join(
          root,
          ".local",
          "share",
          "claude",
          "versions",
          "1.0.0",
          "claude",
        );
        writeExecutable(release);
        const alias = NodePath.join(root, ".local", "bin", "claude");
        NodeFS.mkdirSync(NodePath.dirname(alias), { recursive: true });
        NodeFS.symlinkSync(release, alias);
        const resolver = makePackageManagedProviderMaintenanceResolver({
          provider: driver("claudeAgent"),
          npmPackageName: "@anthropic-ai/claude-code",
          nativeUpdate: {
            args: ["update"],
            isCommandPath: (value) =>
              value.includes("/.local/share/claude/") || value.endsWith("/.local/bin/claude"),
          },
        });
        const resolve = (binaryPath: string) =>
          resolveProviderMaintenanceCapabilitiesEffect(resolver, { binaryPath, env: { PATH: "" } });
        const active = yield* resolve(alias);
        const pinned = yield* resolve(release);
        expect(active.update?.installationKey).toBeDefined();
        expect(pinned.update?.installationKey).toBeUndefined();
        const newer = NodePath.join(
          root,
          ".local",
          "share",
          "claude",
          "versions",
          "2.0.0",
          "claude",
        );
        writeExecutable(newer);
        NodeFS.unlinkSync(alias);
        NodeFS.symlinkSync(newer, alias);
        expect((yield* resolve(alias)).update?.installationKey).toBe(
          active.update?.installationKey,
        );
        const foreign = NodePath.join(root, "opt", "pinned", "claude");
        writeExecutable(foreign);
        NodeFS.unlinkSync(alias);
        NodeFS.symlinkSync(foreign, alias);
        expect((yield* resolve(alias)).update?.installationKey).toBeUndefined();
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "standalone Codex only owns updates for its installation home",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-codex-home");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const binary = NodePath.join(root, "packages", "standalone", "current", "bin", "codex");
        writeExecutable(binary);
        const resolve = (home: string) =>
          resolveProviderMaintenanceCapabilitiesEffect(
            makePackageManagedProviderMaintenanceResolver({
              provider: driver("codex"),
              npmPackageName: "@openai/codex",
              nativeUpdate: {
                args: ["update"],
                env: { CODEX_HOME: home },
                isCommandPath: (value) => value.includes("/packages/standalone/"),
              },
            }),
            { binaryPath: binary, env: { PATH: "instance-path", CODEX_HOME: "shadow-home" } },
          );
        const owned = yield* resolve(root);
        expect(owned.update?.installationKey).toBeDefined();
        expect(owned.update?.env).toEqual({ PATH: "instance-path", CODEX_HOME: root });
        expect(
          (yield* resolve(NodePath.join(root, "other"))).update?.installationKey,
        ).toBeUndefined();
        // The default home is often reached through a link, such as macOS's /var -> /private/var.
        const linkedHome = `${root}-linked`;
        NodeFS.symlinkSync(root, linkedHome);
        yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(linkedHome)));
        expect((yield* resolve(linkedHome)).update?.installationKey).toBe(
          owned.update?.installationKey,
        );
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "Homebrew active aliases keep identity across keg versions and explicit kegs stay pinned",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-brew-identity");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const brew = NodePath.join(root, "bin", "brew");
        writeExecutable(brew);
        const resolve = (version: string, pinned: boolean) => {
          const real = NodePath.join(root, "Cellar", "package-tool", version, "bin", "tool");
          writeExecutable(real);
          return resolvePackageManagedProviderMaintenance(
            {
              provider: driver("packageTool"),
              npmPackageName: "@example/package-tool",
              nativeUpdate: null,
            },
            {
              binaryPath: pinned ? real : "tool",
              resolvedCommandPath: NodePath.join(root, "bin", "tool"),
              realCommandPath: real,
              env: { PATH: NodePath.dirname(brew) },
              platform: "linux",
            },
          ).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              stdoutSpawner((_command, args) => (args[0] === "--prefix" ? root : "{}")),
            ),
          );
        };
        const old = yield* resolve("1.0.0", false);
        const next = yield* resolve("2.0.0", false);
        expect(old.update?.installationKey).toBeDefined();
        expect(next.update?.installationKey).toBe(old.update?.installationKey);
        expect((yield* resolve("1.0.0", true)).update?.installationKey).toBeUndefined();
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(!symlinksSupported || windowsHost)(
    "keeps aliased custom mise data directories manual-only",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDir("pf-09-mise-alias");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const data = NodePath.join(root, "physical");
        const binary = NodePath.join(
          data,
          "installs",
          "npm-package-tool",
          "1.0.0",
          "lib",
          "node_modules",
          "@example",
          "package-tool",
          "bin",
          "tool.js",
        );
        writeExecutable(binary);
        const logical = NodePath.join(root, "logical");
        NodeFS.symlinkSync(data, logical);
        const alias = NodePath.join(root, "tool");
        NodeFS.symlinkSync(binary, alias);
        const result = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
          binaryPath: alias,
          env: { PATH: "", MISE_DATA_DIR: logical },
        });
        expect(result.update).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect("caches resolution until a fresh read is requested", () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.sync(() => {
          resolutions += 1;
          return manualPackageTool;
        }),
      );
      yield* resolve();
      yield* resolve();
      expect(resolutions).toBe(1);
      yield* resolve({ fresh: true });
      yield* resolve();
      expect(resolutions).toBe(2);
    }),
  );

  it.effect("starts a fresh read instead of joining the resolution already running", () =>
    Effect.gen(function* () {
      const releaseStale = yield* Deferred.make<void>();
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.suspend(() => {
          resolutions += 1;
          return resolutions === 1
            ? Deferred.await(releaseStale).pipe(Effect.as(manualPackageTool))
            : Effect.succeed(manualPackageTool);
        }),
      );

      // An advisory read starts a resolution that is still running when the
      // user clicks Update; the fresh read must not wait on or reuse it.
      const advisory = yield* Effect.forkChild(resolve(), { startImmediately: true });
      const fresh = yield* Effect.forkChild(resolve({ fresh: true }), { startImmediately: true });
      // The fresh read runs its own resolution, so it finishes while the stale
      // one is still waiting.
      expect(resolutions).toBe(2);
      expect(fresh.pollUnsafe()).toBeDefined();
      yield* Deferred.succeed(releaseStale, undefined);
      expect(yield* Fiber.join(fresh)).toEqual(manualPackageTool);
      yield* Fiber.join(advisory);
    }),
  );

  it.effect("resolves again after the first read is interrupted", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let resolutions = 0;
      const resolve = yield* makeCachedProviderMaintenanceResolution(
        Effect.suspend(() => {
          resolutions += 1;
          return resolutions === 1
            ? Effect.never
            : Deferred.await(release).pipe(Effect.as(manualPackageTool));
        }),
      );

      const first = yield* Effect.forkChild(resolve(), { startImmediately: true });
      yield* Fiber.interrupt(first);

      // The next read resolves again, and a reader that joined it keeps it
      // running when the reader that started it goes away.
      const owner = yield* Effect.forkChild(resolve(), { startImmediately: true });
      const waiter = yield* Effect.forkChild(resolve(), { startImmediately: true });
      yield* Fiber.interrupt(owner);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(waiter)).toEqual(manualPackageTool);
      expect(yield* resolve()).toEqual(manualPackageTool);
      expect(resolutions).toBe(2);
    }),
  );
});

it.each(["2.0.0", "2.0.0-beta.1"])(
  "pins only owned package-manager installs to %s and preserves their execution context",
  (version) => {
    const capabilities = makeProviderMaintenanceCapabilities({
      provider: driver("codex"),
      packageName: "@openai/codex",
      updateExecutable: "npm",
      updateLockKey: "npm-global:/opt/node",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        "/opt/node",
        "--allow-scripts=@openai/codex",
        "@openai/codex@latest",
      ],
      env: { PATH: "/opt/node/bin" },
    });
    const pinned = makeTargetedProviderUpdateAction(capabilities, version);
    expect(pinned).toMatchObject({
      executable: "npm",
      lockKey: capabilities.update?.lockKey,
      env: capabilities.update?.env,
      args: [
        "install",
        "-g",
        "--prefix",
        "/opt/node",
        "--allow-scripts=@openai/codex",
        `@openai/codex@${version}`,
      ],
    });
    expect(pinned?.command).toContain(`@openai/codex@${version}`);
    for (const lockKey of ["codex-native", "homebrew", "manual"]) {
      expect(
        makeTargetedProviderUpdateAction(
          { ...capabilities, update: { ...capabilities.update!, lockKey } },
          "2.0.0",
        ),
      ).toBeNull();
    }
    for (const invalid of ["2.0.0; rm -rf /", "2.0.0-beta; echo injected", "2.0.0-beta..1"]) {
      expect(makeTargetedProviderUpdateAction(capabilities, invalid)).toBeNull();
    }
  },
);
