import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { repointLauncher, resolveLauncherPath } from "./update.ts";

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "migrates a symlink and keeps the launcher executable across subsequent updates",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" }),
        );
        const home = path.join(root, "it's home");
        const versionsDir = path.join(home, "runtime/versions");
        const launcher = path.join(home, ".local/bin/t3");
        const alias = path.join(root, "it's bin/t3");
        const executable = '#!/bin/sh\nprintf \'[%s]\\n\' "$0" "$@"\n';
        const args = ["two words", "it's quoted", "", "*", "$HOME"];
        const entry = (version: number) => path.join(versionsDir, `${version}.0.0/t3`);
        for (const file of [entry(1), entry(2), entry(3), entry(4), entry(5)]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, executable, { mode: 0o755 });
        }
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.makeDirectory(path.dirname(alias), { recursive: true });
        yield* fs.symlink(entry(1), launcher);
        yield* fs.symlink(launcher, alias);

        for (const version of [2, 3, 4]) {
          const repointed = yield* repointLauncher({
            launchedAs: version === 2 ? launcher : entry(version - 1),
            versionsDir,
            targetEntryPath: entry(version),
          }).pipe(
            Effect.provideService(
              HostProcess.Environment,
              version === 4
                ? { PATH: `${path.join(root, "missing")}:${path.dirname(alias)}` }
                : { HOME: home, PATH: path.join(root, "missing") },
            ),
          );

          assert.equal(Option.getOrUndefined(repointed), launcher);
          assert.equal(
            yield* spawner.string(ChildProcess.make(alias, args, { cwd: root })),
            [entry(version), ...args].map((arg) => `[${arg}]\n`).join(""),
          );
          assert.equal(yield* fs.readFileString(entry(version - 1)), executable);
          assert.equal(yield* fs.readLink(alias), launcher);
        }

        const customLauncher = path.join(root, "custom/bin/t3");
        yield* fs.makeDirectory(path.dirname(customLauncher), { recursive: true });
        const oldLauncher = yield* fs.readFileString(launcher);
        yield* fs.writeFileString(customLauncher, oldLauncher, { mode: 0o755 });
        const repointed = yield* repointLauncher({
          launchedAs: entry(4),
          versionsDir,
          targetEntryPath: entry(5),
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: home,
            PATH: `${path.dirname(customLauncher)}:${path.dirname(launcher)}`,
          }),
        );
        assert.equal(Option.getOrUndefined(repointed), customLauncher);
        assert.equal(yield* fs.readFileString(launcher), oldLauncher);
        assert.equal(
          yield* spawner.string(ChildProcess.make(customLauncher, args, { cwd: root })),
          [entry(5), ...args].map((arg) => `[${arg}]\n`).join(""),
        );
      }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves a hand-written wrapper alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const versionsDir = path.join(root, "runtime/versions");
      const oldExe = path.join(versionsDir, "1.0.0/t3");
      const newExe = path.join(versionsDir, "2.0.0/t3");
      const wrapper = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe, wrapper]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      }
      for (const file of [oldExe, newExe]) yield* fs.writeFileString(file, "");
      const contents = `#!/bin/sh\nexport T3_EXTRA=1\nexec '${oldExe}' "$@"\n`;
      yield* fs.writeFileString(wrapper, contents);

      const repointed = yield* repointLauncher({
        launchedAs: oldExe,
        versionsDir,
        targetEntryPath: newExe,
      }).pipe(Effect.provideService(HostProcess.Environment, { PATH: path.dirname(wrapper) }));

      assert.equal(repointed._tag, "None");
      assert.equal(yield* fs.readFileString(wrapper), contents);
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
