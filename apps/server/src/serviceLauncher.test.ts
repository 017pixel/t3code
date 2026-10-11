// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off - Launcher recovery uses native filesystem failures and wall clocks.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

vi.mock("node:fs/promises", { spy: true });

import {
  Launcher,
  pruneServiceRuntimes,
  readServiceState,
  writeServiceState,
} from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

it("accepts only exact semantic versions", () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-0", "1.2.3+001"]) {
    assert.isTrue(isExactServiceVersion(version), version);
  }
  for (const version of ["latest", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+."]) {
    assert.isFalse(isExactServiceVersion(version), version);
  }
});

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactServiceVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactServiceVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactServiceVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactServiceVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("reads deployed protocol 3 state without optional health fields", () => {
  assert.deepEqual(decodeServiceState({ protocol: 3, activeVersion: "1.0.0" }), {
    protocol: 3,
    activeVersion: "1.0.0",
  });
});

it("rejects contradictory service state", () => {
  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-3",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );
});

// A pinned runtime is an executable at <versionDir>/t3. The tests stand one up
// as a Node shebang script so the launcher spawns it the way it spawns the
// real single-executable, IPC channel included.
const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const entryPath = path.join(versionDir, "t3");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect("durably replaces and strictly reads one state document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-test-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "0.0.31",
      } as const;

      yield* Effect.promise(() => writeServiceState(statePath, state));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), state);
    }),
  );

  it.effect("a fresh launcher clears a restart deferred by t3 update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-restart-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const restartPending = path.join(root, "runtime", SERVICE_RESTART_PENDING_FILE);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const run = () =>
        Effect.gen(function* () {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          const running = launcher.run();
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });

      // A launcher that is still the old version leaves a marker that waits
      // for a newer one.
      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      // Whoever restarted the service, the launcher now runs what the unit
      // names, so the deferred-restart marker is gone.
      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect("serializes shutdown with launcher recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-stop-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      const running = launcher.run();
      const stopping = launcher.stop("SIGTERM");
      // An explicit stop leaves the marker that tells a child shutting down
      // mid-update that no replacement server is coming. It is present as
      // soon as stop() returns its promise, before queued transitions run.
      assert.isTrue(yield* fs.exists(path.join(root, "runtime", SERVICE_STOP_MARKER_FILE)));
      yield* Effect.promise(() => stopping);
      yield* Effect.promise(() => running);
    }),
  );

  it.effect("starts the server when orphaned provider cleanup cannot run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-reap-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const leases = path.join(root, "cache", "t3", "provider-maintenance");
      yield* fs.makeDirectory(leases, { recursive: true });
      yield* fs.writeFileString(path.join(leases, "install.json"), "corrupt");
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"))),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "started"))}, "");\nsetInterval(() => {}, 1_000);\n`,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const started = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeFS.watch(root, (_event, name) => {
            if (name === "started") started.resolve();
          }),
        ),
        (watcher) => Effect.sync(() => watcher.close()),
      );
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      const running = launcher.run();
      // A failed launcher would otherwise leave the child promise pending forever.
      yield* Effect.promise(() => Promise.race([started.promise, running]));
      assert.isTrue(yield* fs.exists(path.join(root, "started")));
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
    }),
  );

  it.effect.each([
    "unchanged",
    "orphan",
    "orphan-restart",
    "restart",
    "clock-jump",
    "before-prepared",
    "after-commit",
    "wal-migration",
    "unreadable",
    "untracked-ddl",
    "reverted-migration",
    "same-count-schema",
    "same-count-ledger",
  ] as const)(
    "supervises committed crash loops with schema %s without restoring accepted work",
    (schema) =>
      Effect.gen(function* () {
        const compatible =
          schema === "unchanged" ||
          schema === "restart" ||
          schema === "clock-jump" ||
          schema === "orphan" ||
          schema === "orphan-restart" ||
          schema === "reverted-migration";
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-crash-loop-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const dbPath = path.join(root, "database");
        const db = new NodeSqlite.DatabaseSync(dbPath);
        db.exec(
          "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT); INSERT INTO effect_sql_migrations VALUES (1, 'initial'); CREATE TABLE receipts (id TEXT PRIMARY KEY)",
        );
        db.close();
        const pending = {
          id: "crash-loop",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath,
          status: "pending" as const,
        };
        const migrate =
          "db.exec(\"INSERT INTO effect_sql_migrations VALUES (2, 'candidate'); CREATE TABLE candidate_data (id TEXT)\");";
        const orphans = schema === "orphan" || schema === "orphan-restart";
        const processes = path.join(root, "userdata", "provider-processes");
        const source = `
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
fs.appendFileSync(${JSON.stringify(path.join(root, "starts"))}, context.childVersion + "\\n");
${
  orphans
    ? `
if (context.childVersion === "1.1.0") {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const identity = pid => ({ pid, startTime: boot + ":" + fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ").at(-1).split(" ")[19] });
  fs.mkdirSync(${JSON.stringify(processes)}, { recursive: true });
  fs.writeFileSync(${JSON.stringify(processes)} + "/" + process.pid + ".json", JSON.stringify({ version: 1, instanceId: "candidate", hostname: require("node:os").hostname(), stateDir: ${JSON.stringify(path.dirname(processes))}, owner: identity(process.pid), processes: [{ ...identity(child.pid), pgid: child.pid }] }));
  fs.appendFileSync(${JSON.stringify(path.join(root, "orphans"))}, child.pid + "\\n");
}
`
    : ""
}
if (context.update.status === "rolled-back" || context.update.status === "failed") {
  const ready = ${JSON.stringify(path.join(root, "ready"))};
  fs.writeFileSync(ready + ".staging", JSON.stringify(context));
  fs.renameSync(ready + ".staging", ready);
  setInterval(() => {}, 1000);
} else if (context.update.status === "pending") {
  const db = new DatabaseSync(${JSON.stringify(dbPath)});
  ${schema === "before-prepared" ? migrate : ""}
  db.close();
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", message => {
    if (message.type !== "committed") return;
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    ${schema === "wal-migration" ? 'db.exec("PRAGMA journal_mode=WAL");' : ""}
    db.exec("INSERT INTO receipts VALUES ('accepted')");
    ${schema === "after-commit" || schema === "wal-migration" ? migrate : schema === "unreadable" ? 'db.exec("DROP TABLE effect_sql_migrations");' : schema === "untracked-ddl" ? 'db.exec("CREATE TABLE untracked (id TEXT)");' : ""}
    ${schema === "reverted-migration" ? "db.exec(\"INSERT INTO effect_sql_migrations VALUES (2, 'candidate'); CREATE TABLE candidate_data (id TEXT); DROP TABLE candidate_data; DELETE FROM effect_sql_migrations WHERE migration_id = 2\");" : ""}
    ${schema === "same-count-schema" ? 'db.exec("ALTER TABLE receipts ADD COLUMN candidate TEXT");' : ""}
    ${schema === "same-count-ledger" ? "db.exec(\"UPDATE effect_sql_migrations SET name = 'replacement' WHERE migration_id = 1\");" : ""}
    ${schema === "wal-migration" ? "" : "db.close();"}
    process.exit(42);
  });
} else {
  process.exit(42);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            source,
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
            update: pending,
          }),
        );
        // Ensure a failing assertion also cleans up every child spawned by this case.
        if (orphans)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const file = path.join(root, "orphans");
              if (!NodeFS.existsSync(file)) return;
              for (const pid of NodeFS.readFileSync(file, "utf8").trim().split("\n").map(Number)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
                }
              }
            }),
          );
        const ready = Promise.withResolvers<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.watch(root, (_event, name) => {
              if (name === "ready") ready.resolve();
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        );
        if (schema === "clock-jump") {
          let now = 0;
          yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(Date, "now").mockImplementation(() => (now += 600_000))),
            (clock) => Effect.sync(() => clock.mockRestore()),
          );
        }
        if (schema === "restart" || schema === "orphan-restart") {
          const crashed = Promise.withResolvers<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeFS.watch(path.dirname(statePath), (_event, name) => {
                if (name === "service-state.json")
                  void readServiceState(statePath).then(
                    (state) => {
                      if (state.crashRecovery?.crashes === 1) crashed.resolve();
                    },
                    () => {},
                  );
              }),
            ),
            (watcher) => Effect.sync(() => watcher.close()),
          );
          const first = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              void first.run().catch(crashed.reject);
            }),
            () => Effect.promise(() => first.stop("SIGTERM")),
          );
          yield* Effect.promise(() => crashed.promise);
          yield* Effect.promise(() => first.stop("SIGTERM"));
        }
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            void launcher.run().catch(ready.reject);
          }),
          () => Effect.promise(() => launcher.stop("SIGTERM")),
        );
        yield* Effect.promise(() => ready.promise);
        if (orphans) {
          const pids = (yield* fs.readFileString(path.join(root, "orphans")))
            .trim()
            .split("\n")
            .map(Number);
          assert.lengthOf(pids, 3);
          for (const pid of pids) {
            let stat: string | undefined;
            try {
              stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            assert.isTrue(
              stat === undefined || stat.split(") ").at(-1)!.startsWith("Z "),
              `orphan ${pid} survived previous-runtime fallback`,
            );
          }
          assert.deepEqual(NodeFS.readdirSync(processes), []);
        }
        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, compatible ? "1.0.0" : "1.1.0");
        assert.equal(state.update?.status, compatible ? "rolled-back" : "failed");
        assert.include(
          state.update?.status === "pending" ? "" : (state.update?.reason ?? ""),
          "crash-loop",
        );
        const context = JSON.parse(yield* fs.readFileString(path.join(root, "ready")));
        assert.equal(context.childVersion, state.activeVersion);
        assert.deepEqual(context.update, state.update);
        assert.deepEqual((yield* fs.readFileString(path.join(root, "starts"))).trim().split("\n"), [
          "1.1.0",
          "1.1.0",
          "1.1.0",
          state.activeVersion,
        ]);
        const current = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.deepEqual(
            current
              .prepare("SELECT id FROM receipts")
              .all()
              .map((row) => row.id),
            ["accepted"],
          );
          if (
            schema === "before-prepared" ||
            schema === "after-commit" ||
            schema === "wal-migration"
          ) {
            assert.equal(
              current.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()
                ?.id,
              2,
            );
          }
        } finally {
          current.close();
        }
        assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", pending.id)));
      }),
    { timeout: 15_000 },
  );

  it.effect.each(["expired", "backward-clock"] as const)(
    "does not downgrade outside the bounded crash window: %s",
    (clock) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-crash-window-" });
        const dbPath = path.join(root, "database");
        yield* fs.writeFileString(dbPath, "accepted work");
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            "process.exit(42);\n",
          );
        }
        const pending = {
          id: "window",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath,
          status: "pending" as const,
        };
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: pending.id,
              fromVersion: pending.fromVersion,
              targetVersion: pending.targetVersion,
              status: "committed",
            },
            crashRecovery: {
              update: pending,
              schema: "baseline",
              crashes: 2,
              committedAt: Date.now() + (clock === "expired" ? -600_000 : 600_000),
            },
          }),
        );
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => {
              throw new Error("unexpected completion");
            },
            (error) => {
              assert.include(String(error), "outside the update crash window");
            },
          ),
        );
        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.1.0");
        assert.equal(state.update?.status, "committed");
        assert.isUndefined(state.crashRecovery);
        assert.equal(yield* fs.readFileString(dbPath), "accepted work");
      }),
  );

  it.effect.each([false, true])(
    "preserves accepted work after a post-commit crash (wall clock jumps: %s)",
    (clockJumps) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-flow-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        yield* fs.writeFileString(databasePath, "before trial");
        const encodedDatabasePath = JSON.stringify(databasePath);
        const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", (message) => {
    if (message.type === "committed") {
      require("node:fs").writeFileSync(${encodedDatabasePath}, "accepted command receipt");
      setTimeout(() => process.exit(42), 100);
    }
  });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "ready"))}, "ready");
  setInterval(() => {}, 1_000);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        if (clockJumps) {
          let now = 0;
          yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(Date, "now").mockImplementation(() => (now += 600_000))),
            (clock) => Effect.sync(() => clock.mockRestore()),
          );
        }
        const ready = Promise.withResolvers<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.watch(root, (_event, name) => {
              if (name === "ready") ready.resolve();
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            void launcher.run().catch(ready.reject);
          }),
          () => Effect.promise(() => launcher.stop("SIGTERM")),
        );
        yield* Effect.promise(() => ready.promise);

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.1.0");
        assert.equal(state.update?.status, "committed");
        assert.equal(yield* fs.readFileString(databasePath), "accepted command receipt");
        assert.isUndefined(state.rollback);
      }),
  );

  it.effect.each(["committed", "pending", "restore-interrupted", "restore-disk-full"] as const)(
    "recovers a retained database backup after %s",
    (checkpoint) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-health-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const dbPath = path.join(root, "database");
        yield* fs.writeFileString(dbPath, "migrated database");
        const backup = path.join(root, "runtime", "db-backup", "health-update");
        yield* fs.makeDirectory(backup, { recursive: true });
        yield* fs.writeFileString(path.join(backup, "database"), "original database");
        yield* fs.writeFileString(`${dbPath}-wal`, "trial wal");
        yield* fs.writeFileString(`${dbPath}-shm`, "trial shm");
        if (checkpoint === "restore-interrupted" || checkpoint === "restore-disk-full") {
          yield* fs.writeFileString(path.join(backup, ".restore-pending"), "");
          yield* fs.writeFileString(dbPath, "partially restored database");
        }
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            "process.exit(42);\n",
          );
        }
        const update = {
          id: "health-update",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath,
          status: "pending" as const,
        };
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: checkpoint === "pending" ? "1.0.0" : "1.1.0",
            launcherVersion: "1.0.0",
            ...(checkpoint === "pending"
              ? { update }
              : {
                  update: { ...update, status: "committed" },
                  rollback: { update, healthyAfter: 60_000 },
                }),
          }),
        );
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        const diskFull =
          checkpoint === "restore-disk-full"
            ? yield* Effect.acquireRelease(
                Effect.sync(() =>
                  vi
                    .spyOn(NodeFSP, "copyFile")
                    .mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" })),
                ),
                (copy) => Effect.sync(() => copy.mockRestore()),
              )
            : undefined;
        yield* Effect.promise(() => launcher.run().catch(() => undefined));
        if (diskFull !== undefined) {
          assert.equal(
            (yield* Effect.promise(() => readServiceState(statePath))).activeVersion,
            "1.1.0",
          );
          assert.isTrue(yield* fs.exists(path.join(backup, ".restore-pending")));
          diskFull.mockRestore();
          const retry = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          yield* Effect.promise(() => retry.run().catch(() => undefined));
        }
        const state = yield* Effect.promise(() => readServiceState(statePath));
        if (checkpoint === "committed") {
          assert.equal(state.activeVersion, "1.1.0");
          assert.equal(state.update?.status, "committed");
          assert.equal(yield* fs.readFileString(dbPath), "migrated database");
          assert.equal(yield* fs.readFileString(`${dbPath}-wal`), "trial wal");
          assert.equal(yield* fs.readFileString(`${dbPath}-shm`), "trial shm");
          assert.isUndefined(state.rollback);
        } else {
          assert.equal(state.activeVersion, "1.0.0");
          assert.equal(state.update?.status, "rolled-back");
          assert.equal(yield* fs.readFileString(dbPath), "original database");
          assert.isFalse(yield* fs.exists(`${dbPath}-wal`));
          assert.isFalse(yield* fs.exists(`${dbPath}-shm`));
        }
        assert.isFalse(yield* fs.exists(backup));
      }),
  );

  it.effect.each(["legacy", "crash-recovery"] as const)(
    "prunes staged runtimes while preserving launcher, active and %s recovery",
    (recovery) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-prune-" });
        const versions = path.join(root, "runtime", "versions");
        for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"]) {
          yield* writeFakeRuntime(fs, path, path.join(versions, version), "process.exit(0);\n");
        }
        yield* fs.makeDirectory(path.join(versions, ".staging-in-progress"));
        const update = {
          id: "health-update",
          fromVersion: "1.1.0",
          targetVersion: "1.2.0",
          dbPath: path.join(root, "database"),
          status: "pending" as const,
        };
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.2.0",
            launcherVersion: "1.0.0",
            update: { ...update, status: "committed" },
            ...(recovery === "legacy"
              ? { rollback: { update, healthyAfter: 60_000 } }
              : {
                  crashRecovery: {
                    update,
                    schema: "baseline",
                    committedAt: Date.now(),
                    crashes: 1,
                  },
                }),
          }),
        );
        yield* Effect.promise(() => pruneServiceRuntimes(root, new Set(["1.4.0"])));
        assert.deepEqual((yield* fs.readDirectory(versions)).sort(), [
          ".staging-in-progress",
          "1.0.0",
          "1.1.0",
          "1.2.0",
          "1.4.0",
        ]);
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.2.0",
            launcherVersion: "1.0.0",
            update: { ...update, status: "committed" },
          }),
        );
        yield* Effect.promise(() => pruneServiceRuntimes(root));
        assert.deepEqual((yield* fs.readDirectory(versions)).sort(), [
          ".staging-in-progress",
          "1.0.0",
          "1.2.0",
        ]);
      }),
  );

  it.effect("rolls back a trial that reports the wrong update ID", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "invalid-prepared",
      );
    }),
  );

  it.effect("restores the database when a migrating trial exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-db-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const original = "database before migration";
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, original);
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  process.exit(1);
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(yield* fs.readFileString(databasePath), original);
      assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
      assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
      const updateId = state.update?.id;
      assert.isDefined(updateId);
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
    }),
  );
});
