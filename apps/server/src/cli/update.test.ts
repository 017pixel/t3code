import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { afterEach, vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { repointLauncher, resolveLauncherPath, updateCommand } from "./update.ts";

afterEach(() => vi.restoreAllMocks());

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("t3 update discovery", (it) => {
  it.effect("keeps release index discovery separate from the download mirror across pages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-feed-" });
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.mock(BootService.BootService)({
          status: Effect.succeed({
            supported: true,
            installed: false,
            current: false,
            unitPath: "",
            logPath: "",
          }),
        }),
      );
      for (const indexBaseUrl of [" http://127.0.0.1:4321/releases/ ", undefined]) {
        const indexUrl = indexBaseUrl
          ? "http://127.0.0.1:4321/releases/index.json"
          : "https://api.github.com/repos/pingdotgg/t3code/releases";
        const requests: Array<string> = [];
        const error = yield* Command.runWith(updateCommand, { version: packageJson.version })([
          "--base-dir",
          baseDir,
          "--channel",
          "stable",
        ]).pipe(
          Effect.provideService(HostProcess.Environment, {
            T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:9876/downloads",
            ...(indexBaseUrl === undefined ? {} : { T3CODE_RELEASE_INDEX_BASE_URL: indexBaseUrl }),
          }),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.provideService(FetchHttpClient.Fetch, async (input) => {
            const url = String(input);
            requests.push(url);
            if (url === `${indexUrl}?per_page=100&page=1`) {
              return Response.json([
                { tag_name: "v999.0.0", draft: true },
                { tag_name: "v999.0.0-nightly.20261019.1" },
              ]);
            }
            if (url === `${indexUrl}?per_page=100&page=2`) {
              return Response.json([{ tag_name: "v0.0.0" }]);
            }
            throw new Error(`Unexpected release request: ${url}`);
          }),
          Effect.flip,
        );

        assert.deepEqual(requests, [
          `${indexUrl}?per_page=100&page=1`,
          `${indexUrl}?per_page=100&page=2`,
        ]);
        assert.equal(error._tag, "CliUpdateError");
        assert.equal(
          error.message,
          `t3@0.0.0 is older than the installed ${packageJson.version}. Pass --allow-downgrade to install it anyway.`,
        );
      }
    }),
  );
});

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "./bin/t3"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});
