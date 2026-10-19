import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as HandoffGit from "./HandoffGit.ts";

const nativeLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));
const handoffService = HandoffGit.HandoffGit.pipe(Effect.provide(HandoffGit.layer));
const branch = "fix/login";
const branchRef = `refs/heads/${branch}`;

const git = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
  const processes = yield* VcsProcess.VcsProcess;
  return (yield* processes.run({
    operation: "HandoffGit.test",
    command: "git",
    cwd,
    args,
    env: {
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })).stdout;
});

const refs = (cwd: string) => git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]);

const checkoutState = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitDir = (yield* git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
  return {
    head: yield* git(cwd, ["rev-parse", "HEAD"]),
    status: yield* git(cwd, ["status", "--porcelain"]),
    staged: yield* git(cwd, ["diff", "--cached", "--binary"]),
    unstaged: yield* git(cwd, ["diff", "--binary"]),
    index: yield* fs.readFile(path.join(gitDir, "index")),
    indexFiles: (yield* fs.readDirectory(gitDir)).filter((name) => name.includes("index")).sort(),
    app: yield* fs.readFileString(path.join(cwd, "app.txt")),
    newFile: yield* fs.readFileString(path.join(cwd, "new.txt")),
  };
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoff-git-" });
  const origin = path.join(root, "origin.git");
  const backup = path.join(root, "backup.git");
  const source = path.join(root, "source");
  const receiver = path.join(root, "receiver");
  const outDir = path.join(root, "out");
  const worktreePath = path.join(root, "received");
  const write = (cwd: string, name: string, text: string) =>
    fs.writeFileString(path.join(cwd, name), text);
  yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", backup]);
  yield* git(root, ["clone", "--quiet", origin, source]);
  yield* git(source, ["remote", "add", "backup", backup]);
  yield* fs.makeDirectory(path.join(source, "packages"));
  yield* write(source, "app.txt", "base\n");
  yield* write(source, "deleted.txt", "keep until deleted\n");
  yield* write(source, ".gitignore", "secret.txt\nforced.txt\n");
  yield* write(source, "packages/lib.txt", "library\n");
  yield* git(source, ["add", "."]);
  yield* git(source, ["commit", "--quiet", "-m", "base"]);
  yield* git(source, ["push", "--quiet", "origin", "main"]);
  yield* git(root, ["clone", "--quiet", origin, receiver]);
  yield* git(source, ["checkout", "--quiet", "-b", branch]);
  yield* write(source, "app.txt", "committed\n");
  yield* git(source, ["commit", "--quiet", "-am", "unpushed work"]);
  yield* git(source, ["push", "--quiet", "backup", branchRef]);
  yield* git(source, ["tag", branch]);
  yield* write(source, "app.txt", "staged\n");
  yield* git(source, ["add", "app.txt"]);
  yield* write(source, "app.txt", "unstaged\n");
  yield* fs.remove(path.join(source, "deleted.txt"));
  yield* write(source, "new.txt", "source new\n");
  yield* write(source, "secret.txt", "source secret\n");
  yield* write(source, "forced.txt", "source forced\n");
  yield* git(source, ["add", "--force", "forced.txt"]);
  yield* write(receiver, "app.txt", "receiver staged\n");
  yield* git(receiver, ["add", "app.txt"]);
  yield* write(receiver, "app.txt", "receiver unstaged\n");
  yield* write(receiver, "new.txt", "receiver new\n");
  yield* fs.makeDirectory(outDir);
  return { fs, path, root, origin, source, receiver, outDir, worktreePath, write };
});

it.layer(nativeLayer)("HandoffGit", (it) => {
  it.effect(
    "round trips the whole checkout without changing either existing index or worktree",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = yield* VcsProcess.VcsProcess;
        // Model inherited hook variables without mutating the test runner's process.env.
        const handoff = yield* handoffService.pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: (input) =>
              native.run({
                ...input,
                env: {
                  GIT_DIR: f.path.join(f.receiver, ".git"),
                  GIT_WORK_TREE: f.receiver,
                  GIT_INDEX_FILE: f.path.join(f.receiver, ".git", "index"),
                  ...input.env,
                },
              }),
          }),
        );
        const sourceBefore = yield* checkoutState(f.source);
        const sourceRefs = yield* refs(f.source);
        const receiverBefore = yield* checkoutState(f.receiver);
        const receiverRefs = yield* refs(f.receiver);
        const packed = yield* handoff.pack({
          cwd: f.path.join(f.source, "packages"),
          handoffId: "roundtrip",
          outDir: f.outDir,
        });
        assert.equal(packed.branch, branch);
        assert.equal(packed.tip, sourceBefore.head.trim());
        assert.equal(packed.baseRemoteUrl, f.origin);
        assert.equal(packed.bundleBytes, Number((yield* f.fs.stat(packed.bundlePath)).size));
        assert.isAbove(packed.bundleBytes, 0);
        assert.equal(yield* git(f.source, ["show", `${packed.tip}:app.txt`]), "committed\n");
        assert.equal(yield* git(f.source, ["show", `${packed.snapshot}:app.txt`]), "unstaged\n");
        assert.deepEqual(yield* checkoutState(f.source), sourceBefore);
        assert.equal(yield* refs(f.source), sourceRefs);
        assert.equal(yield* refs(f.receiver), receiverRefs);
        assert.deepEqual(yield* checkoutState(f.receiver), receiverBefore);
        const missingTip = yield* git(f.receiver, ["cat-file", "-e", packed.tip]).pipe(Effect.flip);
        assert.equal(missingTip._tag, "VcsProcessExitError");
        assert.deepEqual(yield* f.fs.readDirectory(f.outDir), [f.path.basename(packed.bundlePath)]);

        const input = {
          ...packed,
          repoRoot: f.receiver,
          worktreePath: f.worktreePath,
          handoffId: "roundtrip",
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* handoff.apply(input);
            assert.equal(lease.branch, branch);
            yield* lease.commit;
          }),
        );
        assert.equal((yield* git(f.worktreePath, ["rev-parse", "HEAD"])).trim(), packed.tip);
        assert.equal(yield* git(f.worktreePath, ["show", "HEAD:app.txt"]), "committed\n");
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.worktreePath, "app.txt")),
          "unstaged\n",
        );
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.worktreePath, "new.txt")),
          "source new\n",
        );
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.worktreePath, "packages/lib.txt")),
          "library\n",
        );
        assert.isFalse(yield* f.fs.exists(f.path.join(f.worktreePath, "deleted.txt")));
        assert.isFalse(yield* f.fs.exists(f.path.join(f.worktreePath, "secret.txt")));
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.worktreePath, "forced.txt")),
          "source forced\n",
        );
        assert.equal(
          yield* git(f.worktreePath, ["status", "--porcelain"]),
          " M app.txt\n D deleted.txt\n?? new.txt\n",
        );
        assert.equal(yield* git(f.worktreePath, ["diff", "--cached"]), "");

        const acceptedBefore = yield* checkoutState(f.worktreePath);
        const detachedPath = f.path.join(f.root, "detached");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* handoff.apply({ ...input, worktreePath: detachedPath });
            assert.isNull(lease.branch);
            assert.equal(yield* git(detachedPath, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD\n");
            assert.equal((yield* git(detachedPath, ["rev-parse", "HEAD"])).trim(), packed.tip);
          }),
        );
        assert.isFalse(yield* f.fs.exists(detachedPath));
        assert.deepEqual(yield* checkoutState(f.worktreePath), acceptedBefore);
        assert.deepEqual(yield* checkoutState(f.receiver), receiverBefore);
        assert.equal((yield* git(f.receiver, ["rev-parse", branch])).trim(), packed.tip);
        assert.equal(yield* git(f.receiver, ["for-each-ref", "refs/t3code"]), "");
      }).pipe(Effect.scoped),
  );

  it.effect.each(["diverged", "checked-out", "corrupt-bundle"] as const)(
    "refuses a %s destination without overwriting work",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const handoff = yield* handoffService;
        const packed = yield* handoff.pack({
          cwd: f.source,
          handoffId: "refuse",
          outDir: f.outDir,
        });
        if (mode === "corrupt-bundle") {
          yield* f.fs.writeFileString(packed.bundlePath, "corrupted transfer\n");
        }
        const base = (yield* git(f.receiver, ["rev-parse", "HEAD"])).trim();
        const destination =
          mode === "diverged"
            ? (yield* git(f.receiver, [
                "commit-tree",
                "HEAD^{tree}",
                "-p",
                base,
                "-m",
                "receiver-only commit",
              ])).trim()
            : base;
        yield* git(f.receiver, ["branch", branch, destination]);
        const occupied = f.path.join(f.root, "occupied");
        if (mode === "checked-out") {
          yield* git(f.receiver, ["worktree", "add", occupied, branch]);
          yield* f.write(occupied, "app.txt", "occupied staged\n");
          yield* git(occupied, ["add", "app.txt"]);
          yield* f.write(occupied, "app.txt", "occupied unstaged\n");
          yield* f.write(occupied, "new.txt", "occupied new\n");
        }
        const occupiedBefore = mode === "checked-out" ? yield* checkoutState(occupied) : null;
        const before = yield* checkoutState(f.receiver);
        const refsBefore = yield* refs(f.receiver);
        const worktreesBefore = yield* git(f.receiver, ["worktree", "list", "--porcelain"]);
        const error = yield* handoff
          .apply({
            ...packed,
            repoRoot: f.receiver,
            worktreePath: f.worktreePath,
            handoffId: "refuse",
          })
          .pipe(Effect.scoped, Effect.flip);
        if (mode === "corrupt-bundle") {
          assert.equal(error._tag, "HandoffGitStepError");
          assert.propertyVal(error, "step", "bundle-read");
        } else {
          assert.equal(
            error._tag,
            mode === "diverged" ? "HandoffBranchDivergedError" : "HandoffBranchCheckedOutError",
          );
        }
        assert.deepEqual(yield* checkoutState(f.receiver), before);
        assert.equal(yield* refs(f.receiver), refsBefore);
        assert.equal(yield* git(f.receiver, ["worktree", "list", "--porcelain"]), worktreesBefore);
        assert.isFalse(yield* f.fs.exists(f.worktreePath));
        if (occupiedBefore !== null)
          assert.deepEqual(yield* checkoutState(occupied), occupiedBefore);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["new", "fast-forward"] as const)(
    "rolls back a %s branch until receiver acceptance, preserving concurrent advances",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const handoff = yield* handoffService;
        const native = yield* VcsProcess.VcsProcess;
        const packed = yield* handoff.pack({
          cwd: f.source,
          handoffId: "rollback",
          outDir: f.outDir,
        });
        if (mode === "fast-forward") yield* git(f.receiver, ["branch", branch, "main"]);
        const before = yield* checkoutState(f.receiver);
        const refsBefore = yield* refs(f.receiver);
        const worktreesBefore = yield* git(f.receiver, ["worktree", "list", "--porcelain"]);
        const input = {
          ...packed,
          repoRoot: f.receiver,
          worktreePath: f.worktreePath,
          handoffId: "rollback",
        };
        let indexAction: "fail" | "advance" | undefined;
        let advanced: string | undefined;
        const faulted = yield* handoffService.pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: Effect.fnUntraced(
              function* (command: VcsProcess.VcsProcessInput) {
                if (
                  indexAction !== undefined &&
                  command.cwd === f.worktreePath &&
                  (command.args[0] === "reset" || command.args[0] === "read-tree")
                ) {
                  const action = indexAction;
                  indexAction = undefined;
                  assert.equal((yield* git(f.receiver, ["rev-parse", branch])).trim(), packed.tip);
                  assert.equal(
                    yield* f.fs
                      .readFileString(f.path.join(f.worktreePath, "app.txt"))
                      .pipe(Effect.orDie),
                    "unstaged\n",
                  );
                  if (action === "advance") {
                    advanced = (yield* git(f.receiver, [
                      "commit-tree",
                      `${packed.tip}^{tree}`,
                      "-p",
                      packed.tip,
                      "-m",
                      "concurrent receiver commit",
                    ])).trim();
                    yield* git(f.receiver, ["update-ref", branchRef, advanced, packed.tip]);
                    return yield* native.run(command);
                  }
                  const index = (yield* git(f.worktreePath, [
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-path",
                    "index",
                  ])).trim();
                  // A real Git failure after branch creation/advance and snapshot checkout.
                  yield* f.fs.writeFileString(`${index}.lock`, "busy\n").pipe(Effect.orDie);
                  return yield* native
                    .run(command)
                    .pipe(Effect.ensuring(f.fs.remove(`${index}.lock`).pipe(Effect.orDie)));
                }
                return yield* native.run(command);
              },
              Effect.provideService(VcsProcess.VcsProcess, native),
            ),
          }),
        );
        for (const phase of ["late-git", "persistence", "concurrent-persistence"] as const) {
          advanced = undefined;
          const assertRollback = Effect.gen(function* () {
            assert.deepEqual(yield* checkoutState(f.receiver), before);
            assert.equal(
              yield* git(f.receiver, ["worktree", "list", "--porcelain"]),
              worktreesBefore,
            );
            assert.isFalse(yield* f.fs.exists(f.worktreePath));
            const expectedRefs =
              advanced === undefined
                ? refsBefore
                : [
                    ...refsBefore
                      .trim()
                      .split("\n")
                      .filter((line) => !line.startsWith(`${branchRef} `)),
                    `${branchRef} ${advanced}`,
                  ]
                    .sort()
                    .join("\n") + "\n";
            assert.equal(yield* refs(f.receiver), expectedRefs);
          });
          if (phase === "late-git") {
            indexAction = "fail";
            yield* Effect.scoped(
              Effect.gen(function* () {
                const error = yield* faulted.apply(input).pipe(Effect.flip);
                assert.equal(error._tag, "HandoffGitStepError");
                assert.isUndefined(indexAction);
                // Failure during apply must release ownership even while its caller scope is open.
                yield* assertRollback;
              }),
            );
          } else {
            indexAction = phase === "concurrent-persistence" ? "advance" : undefined;
            const error = yield* Effect.scoped(
              Effect.gen(function* () {
                const lease = yield* faulted.apply(input);
                assert.isUndefined(indexAction);
                assert.equal(lease.branch, branch);
                assert.equal(
                  (yield* git(f.receiver, ["rev-parse", branchRef])).trim(),
                  advanced ?? packed.tip,
                );
                assert.equal(
                  (yield* git(f.worktreePath, ["rev-parse", "HEAD"])).trim(),
                  advanced ?? packed.tip,
                );
                return yield* Effect.fail({ _tag: "ReceiverPersistenceFailure" as const });
              }),
            ).pipe(Effect.flip);
            assert.equal(error._tag, "ReceiverPersistenceFailure");
            yield* assertRollback;
          }
        }
      }).pipe(Effect.scoped),
  );
});
