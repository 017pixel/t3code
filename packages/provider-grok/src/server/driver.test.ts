import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  it.effect.each(["default", "linked-home", "custom-bin"] as const)(
    "owns the official Grok download symlinks (%s) but not a pinned download",
    (layout) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "r3-03-grok-" });
        const home = path.join(root, ".grok");
        const download = path.join(home, "downloads/grok-linux-x86_64");
        const bin = layout === "custom-bin" ? path.join(root, "tools") : path.join(home, "bin");
        yield* fs.makeDirectory(path.dirname(download), { recursive: true });
        yield* fs.writeFileString(download, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
        yield* fs.chmod(download, 0o755);
        yield* fs.makeDirectory(bin, { recursive: true });
        yield* fs.symlink(path.relative(bin, download), path.join(bin, "grok"));
        yield* fs.symlink(path.relative(bin, download), path.join(bin, "agent"));
        let visibleHome = home;
        if (layout === "linked-home") {
          visibleHome = path.join(root, "linked-grok");
          yield* fs.symlink(home, visibleHome);
        }
        const alias = path.join(root, ".local/bin/grok");
        yield* fs.makeDirectory(path.dirname(alias), { recursive: true });
        yield* fs.symlink(
          layout === "custom-bin" ? path.join(bin, "grok") : path.join(visibleHome, "bin/grok"),
          alias,
        );
        const resolve = Effect.fnUntraced(function* (binaryPath: string) {
          const instance = yield* GrokDriver.create({
            instanceId: ProviderInstanceId.make("grok-native-layout"),
            displayName: undefined,
            enabled: false,
            environment: [
              { name: "GROK_HOME", value: visibleHome, sensitive: false },
              ...(layout === "custom-bin"
                ? [{ name: "GROK_BIN_DIR", value: bin, sensitive: false }]
                : []),
            ],
            config: { ...GrokDriver.defaultConfig(), binaryPath },
          });
          return yield* instance.snapshot.resolveMaintenance();
        });
        const active = yield* resolve(alias);
        expect(active.update).toMatchObject({ executable: alias, args: ["update"] });
        expect(active.update?.installationKey).toBeDefined();
        expect((yield* resolve(path.join(bin, "grok"))).update?.installationKey).toBe(
          active.update?.installationKey,
        );
        expect((yield* resolve(download)).update?.installationKey).toBeUndefined();
        const foreign = path.join(root, "pinned/grok");
        yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
        yield* fs.writeFileString(foreign, "#!/bin/sh\n");
        yield* fs.chmod(foreign, 0o755);
        yield* fs.remove(alias);
        yield* fs.symlink(foreign, alias);
        expect((yield* resolve(alias)).update?.installationKey).toBeUndefined();
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
        Effect.scoped,
      ),
    { skip: windowsHost },
  );
  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const grokHome = path.join(tempDir, "Grok Home");
      const binaryPath = path.join(grokHome, "bin", "grok");
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-update"),
        displayName: "Grok test",
        enabled: false,
        environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      // `grok update` installs under GROK_HOME, so it must target this instance's home.
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
      expect(capabilities.update?.installationKey).toBeDefined();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)(
    "keeps custom Grok binaries manual and pins npm-owned installs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pf-09-grok-" });
        const binaries = [
          path.join(root, "pinned", "grok"),
          path.join(root, "lib", "node_modules", "@xai-official", "grok", "bin", "grok"),
        ];
        for (const binaryPath of binaries) {
          yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
          yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
          yield* fs.chmod(binaryPath, 0o755);
          const instance = yield* GrokDriver.create({
            instanceId: ProviderInstanceId.make("grok-owned"),
            displayName: undefined,
            enabled: false,
            environment: [{ name: "GROK_HOME", value: root, sensitive: false }],
            config: { ...GrokDriver.defaultConfig(), binaryPath },
          });
          const capabilities = yield* instance.snapshot.resolveMaintenance();
          if (binaryPath === binaries[0])
            expect(capabilities.update?.installationKey).toBeUndefined();
          else {
            expect(capabilities.update?.executable).toBe("npm");
            expect(capabilities.update?.installationKey).toBeDefined();
            expect(capabilities.update?.args).toContain(root);
          }
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
        Effect.scoped,
      ),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
