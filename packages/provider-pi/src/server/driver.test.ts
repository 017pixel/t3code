import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { PiSettings } from "../settings.ts";
import { PiDriver } from "./driver.ts";

const layerTest = Layer.mergeAll(
  TestProviderHost.layer({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected HTTP")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();
const personalSkill = {
  name: "skill:personal",
  source: "skill",
  sourceInfo: { scope: "user", path: "/home/.pi/agent/skills/personal/SKILL.md" },
};

// Respond through the real stdio transport, with a distinct command catalog for each cwd.
const makePiSpawner = Effect.fnUntraced(function* (
  discovery: { readonly state?: unknown; readonly models?: ReadonlyArray<unknown> } = {},
) {
  const pendingCommand = yield* Deferred.make<void>();
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const cwd = command.options.cwd;
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so transport cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          if (cwd === "/pending" && request.type === "get_commands") {
            return Deferred.succeed(pendingCommand, undefined).pipe(Effect.asVoid);
          }
          const failed = cwd === "/failed" && request.type === "get_commands";
          const data =
            request.type === "get_commands"
              ? {
                  commands: [
                    personalSkill,
                    ...(cwd === "/machine"
                      ? []
                      : [
                          {
                            name: `skill:${cwd?.slice(1)}`,
                            source: "skill",
                            sourceInfo: {
                              scope: "project",
                              path: `${cwd}/.agents/skills/SKILL.md`,
                            },
                          },
                          { name: `prompt-${cwd?.slice(1)}`, source: "prompt" },
                        ]),
                  ],
                }
              : request.type === "get_available_models"
                ? { models: discovery.models ?? [{ provider: "test", id: "model" }] }
                : request.type === "get_state"
                  ? (discovery.state ?? {})
                  : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, success: !failed, data, ...(failed ? { error: "commands unavailable" } : {}) })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: version ? Stream.succeed(encoder.encode("pi 1.0.2\n")) : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches, pendingCommand };
});

const create = (config: Partial<PiSettings> = {}, enabled = true) =>
  PiDriver.create({
    instanceId: ProviderInstanceId.make("pi-workspace-test"),
    displayName: "My Pi",
    accentColor: "#abcdef",
    environment: [{ name: "PI_CODING_AGENT_DIR", value: "/isolated-pi", sensitive: false }],
    enabled,
    config: { ...PiDriver.defaultConfig(), binaryPath: "custom-pi", ...config },
  });

it.layer(layerTest)("PiDriver workspace discovery", (it) => {
  it.effect.each(["default", "custom", "linked"] as const)(
    "owns the official managed Pi launcher (%s), never a pinned release or wrapper",
    (layout) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "r3-03-pi-" });
        const agent = path.join(root, layout === "default" ? ".pi/agent" : "custom-agent");
        const install = path.join(agent, "install");
        const launcher = path.join(agent, "bin/pi");
        const release = path.join(
          install,
          "releases/1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        );
        const releaseBin = path.join(install, "releases/1.0.0/node_modules/.bin/pi");
        yield* fs.makeDirectory(path.dirname(release), { recursive: true });
        yield* fs.writeFileString(release, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
        yield* fs.chmod(release, 0o755);
        yield* fs.makeDirectory(path.dirname(releaseBin), { recursive: true });
        yield* fs.symlink("../@earendil-works/pi-coding-agent/dist/bundle/cli.js", releaseBin);
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.writeFileString(
          launcher,
          [
            "#!/bin/sh",
            'pi_launcher="$0"',
            'while [ -L "$pi_launcher" ]; do pi_launcher=$(readlink "$pi_launcher"); done',
            "pi_bin_dir=${pi_launcher%/*}",
            "pi_agent_dir=${pi_bin_dir%/*}",
            "pi_current_file=$pi_agent_dir/install/current-version",
            'IFS= read -r pi_current_version < "$pi_current_file"',
            "pi_release_dir=$pi_agent_dir/install/releases/$pi_current_version",
            "pi_release_bin=$pi_release_dir/node_modules/.bin/pi",
            "PI_MANAGED_INSTALL_ROOT=$pi_agent_dir/install",
            "export PI_MANAGED_INSTALL_ROOT",
            'exec "$pi_release_bin" "$@"',
            "",
          ].join("\n"),
        );
        yield* fs.chmod(launcher, 0o755);
        let visibleAgent = agent;
        if (layout === "linked") {
          visibleAgent = path.join(root, "linked-agent");
          yield* fs.symlink(agent, visibleAgent);
        }
        const alias = path.join(root, ".local/bin/pi");
        yield* fs.makeDirectory(path.dirname(alias), { recursive: true });
        yield* fs.symlink(path.join(visibleAgent, "bin/pi"), alias);
        const marker = path.join(install, "managed-install.json");
        yield* fs.writeFileString(
          marker,
          JSON.stringify({
            kind: "pi-managed-install",
            schemaVersion: 1,
            layout: "releases-v1",
            entrypoint: { type: "symlink", path: alias },
          }),
        );
        yield* fs.writeFileString(path.join(install, "current-version"), "1.0.0\n");
        const resolve = Effect.fnUntraced(function* (binaryPath: string) {
          const instance = yield* create({ binaryPath }, false);
          return yield* instance.snapshot.resolveMaintenance();
        });
        const active = yield* resolve(alias);
        assert.isDefined(active.update?.installationKey);
        assert.equal(active.update?.executable, alias);
        assert.deepEqual(active.update?.args, ["update", "--self"]);
        assert.equal(
          (yield* resolve(launcher)).update?.installationKey,
          active.update?.installationKey,
        );
        assert.isUndefined((yield* resolve(release)).update?.installationKey);
        const wrapper = path.join(root, "custom-pi");
        yield* fs.writeFileString(wrapper, `#!/bin/sh\nexec "${launcher}" "$@"\n`);
        yield* fs.chmod(wrapper, 0o755);
        assert.isUndefined((yield* resolve(wrapper)).update?.installationKey);
        yield* fs.writeFileString(marker, "{}");
        assert.isUndefined((yield* resolve(alias)).update?.installationKey);
      }).pipe(Effect.scoped),
    { skip: HostProcess.Platform.defaultValue() === "win32" },
  );
  it.effect("keeps each workspace's skills and commands separate from the machine catalog", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner();
      const instance = yield* create({ launchArgs: '--approve --skill "extra skill"' }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      assert.isDefined(instance.snapshotForCwd);
      const [first, second] = yield* Effect.all(
        [instance.snapshotForCwd!("/first"), instance.snapshotForCwd!("/second")],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        first.skills.map((skill) => skill.name),
        ["personal", "first"],
      );
      assert.deepEqual(
        second.skills.map((skill) => skill.name),
        ["personal", "second"],
      );
      assert.deepEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "prompt-first"],
      );
      const machine = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(
        machine.skills.map((skill) => skill.name),
        ["personal"],
      );
      assert.deepEqual(
        machine.slashCommands.map((command) => command.name),
        ["compact"],
      );
      assert.equal(first.instanceId, instance.instanceId);
      assert.equal(first.displayName, "My Pi");
      assert.equal(first.accentColor, "#abcdef");
      assert.deepEqual(first.models, machine.models);
      const workspaceLaunch = launches.find((launch) => launch.options.cwd === "/first");
      assert.isDefined(workspaceLaunch);
      assert.equal(workspaceLaunch!.command, "custom-pi");
      assert.includeMembers(
        [...workspaceLaunch!.args],
        ["--approve", "--skill", "extra skill", "--no-session"],
      );
      assert.equal(workspaceLaunch!.options.env?.PI_CODING_AGENT_DIR, "/isolated-pi");
    }).pipe(Effect.scoped),
  );

  it.effect("does not run a disabled provider's workspace probe", () =>
    Effect.gen(function* () {
      const instance = yield* create({}, false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Pi must not spawn")),
        ),
      );
      assert.isDefined(instance.snapshotForCwd);
      const workspace = yield* instance.snapshotForCwd!("/first");
      assert.isFalse(workspace.enabled);
      assert.deepEqual(workspace.skills, []);
    }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "limits discovered thinking defaults to the known active model, known=%s",
    (known) =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner({
          state: {
            thinkingLevel: "high",
            ...(known ? { model: { provider: "test", id: "model" } } : {}),
          },
          models: [
            { provider: "test", id: "model", reasoning: true },
            { provider: "other", id: "model", reasoning: true },
            { provider: "test", id: "other", reasoning: true },
          ],
        });
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.deepEqual(
          snapshot.models.map((model) => [
            model.slug,
            (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
              descriptor.type === "select"
                ? descriptor.options.filter((option) => option.isDefault).map((option) => option.id)
                : [],
            ),
          ]),
          [
            ["default", []],
            ["test/model", known ? ["high"] : []],
            ["other/model", []],
            ["test/other", []],
          ],
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "fails command discovery instead of returning an empty successful workspace catalog",
    () =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner();
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        assert.isDefined(instance.snapshotForCwd);
        const error = yield* Effect.flip(instance.snapshotForCwd!("/failed"));
        assert.equal(error._tag, "ProviderDriverError");
        assert.equal(error.instanceId, instance.instanceId);
        assert.deepEqual(
          (yield* instance.snapshot.getSnapshot).skills.map((skill) => skill.name),
          ["personal"],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("times out workspace discovery that needs interactive input", () =>
    Effect.gen(function* () {
      const { spawner, pendingCommand } = yield* makePiSpawner();
      const instance = yield* create().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const probe = yield* instance.snapshotForCwd!("/pending").pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(pendingCommand);
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(probe);
      assert.equal(error._tag, "ProviderDriverError");
      assert.include(error.detail, "workspace commands");
    }).pipe(Effect.scoped),
  );
});
