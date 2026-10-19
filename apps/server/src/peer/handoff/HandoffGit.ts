import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as VcsProcess from "../../vcs/VcsProcess.ts";

const MAX_HANDOFF_BUNDLE_BYTES = 50 * 1024 * 1024;

export interface HandoffPackage {
  readonly bundlePath: string;
  readonly bundleBytes: number;
  readonly branch: string | null;
  readonly tip: string;
  readonly snapshot: string;
  readonly baseRemoteUrl: string | null;
}

export class HandoffNotARepositoryError extends Schema.TaggedError<HandoffNotARepositoryError>()(
  "HandoffNotARepositoryError",
  { cwd: Schema.String },
) {
  override get message(): string {
    return `${this.cwd} is not a git checkout with a commit.`;
  }
}

export class HandoffTooLargeError extends Schema.TaggedError<HandoffTooLargeError>()(
  "HandoffTooLargeError",
  { bundleBytes: Schema.Number },
) {
  override get message(): string {
    return `The unpushed work is ${Math.ceil(this.bundleBytes / 1024 / 1024)} MiB, over the 50 MiB a handoff carries. Push the branch, then hand off again.`;
  }
}

export class HandoffMissingBaseError extends Schema.TaggedError<HandoffMissingBaseError>()(
  "HandoffMissingBaseError",
  {},
) {
  override get message(): string {
    return "This checkout lacks the commits the handoff builds on, even after fetching. Push the branch where it came from, then hand off again.";
  }
}

export class HandoffBranchCheckedOutError extends Schema.TaggedError<HandoffBranchCheckedOutError>()(
  "HandoffBranchCheckedOutError",
  { branch: Schema.String },
) {
  override get message(): string {
    return `${this.branch} is checked out in another worktree here and differs. Switch that checkout off it, then hand off again.`;
  }
}

export class HandoffBranchDivergedError extends Schema.TaggedError<HandoffBranchDivergedError>()(
  "HandoffBranchDivergedError",
  { branch: Schema.String },
) {
  override get message(): string {
    return `${this.branch} here has commits the handed-off work lacks. Reconcile the branches, then hand off again.`;
  }
}

export class HandoffGitStepError extends Schema.TaggedError<HandoffGitStepError>()(
  "HandoffGitStepError",
  { step: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `The handoff Git step ${this.step} failed.`;
  }
}

export type HandoffGitError =
  | HandoffNotARepositoryError
  | HandoffTooLargeError
  | HandoffMissingBaseError
  | HandoffBranchCheckedOutError
  | HandoffBranchDivergedError
  | HandoffGitStepError;

export class HandoffGit extends Context.Service<
  HandoffGit,
  {
    readonly pack: (input: {
      readonly cwd: string;
      readonly handoffId: string;
      readonly outDir: string;
    }) => Effect.Effect<HandoffPackage, HandoffGitError>;
    readonly apply: (input: {
      readonly repoRoot: string;
      readonly worktreePath: string;
      readonly handoffId: string;
      readonly bundlePath: string;
      readonly branch: string | null;
      readonly tip: string;
      readonly snapshot: string;
    }) => Effect.Effect<
      { readonly branch: string | null; readonly commit: Effect.Effect<void> },
      HandoffGitError,
      Scope.Scope
    >;
  }
>()("t3/peer/handoff/HandoffGit") {}

const repositoryEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
} satisfies NodeJS.ProcessEnv;

const nonInteractiveFetchEnv = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

const snapshotRef = (handoffId: string) => `refs/t3code/handoff/${handoffId}/snapshot`;

const make = Effect.gen(function* () {
  const processes = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const git = (
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv; readonly allowNonZeroExit?: boolean } = {},
  ) =>
    processes
      .run({
        operation: "HandoffGit",
        command: "git",
        cwd,
        args,
        timeoutMs: 120_000,
        ...options,
        env: { ...repositoryEnv, ...options.env },
      })
      .pipe(Effect.mapError((cause) => new HandoffGitStepError({ step: args[0] ?? "git", cause })));

  const out = (cwd: string, args: ReadonlyArray<string>) =>
    git(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));
  const ok = (cwd: string, args: ReadonlyArray<string>) =>
    git(cwd, args, { allowNonZeroExit: true }).pipe(Effect.map((result) => result.exitCode === 0));

  const pack: HandoffGit["Service"]["pack"] = Effect.fn("HandoffGit.pack")(function* (input) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        if (!(yield* ok(input.cwd, ["rev-parse", "--verify", "HEAD"]))) {
          return yield* new HandoffNotARepositoryError({ cwd: input.cwd });
        }
        const cwd = yield* out(input.cwd, ["rev-parse", "--show-toplevel"]);
        const tip = yield* out(cwd, ["rev-parse", "HEAD"]);
        const head = yield* git(cwd, ["symbolic-ref", "--quiet", "HEAD"], {
          allowNonZeroExit: true,
        });
        const headRef = head.stdout.trim();
        const branch =
          head.exitCode === 0 && headRef.startsWith("refs/heads/")
            ? headRef.slice("refs/heads/".length)
            : null;
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-handoff-index-" })
          .pipe(
            Effect.mapError((cause) => new HandoffGitStepError({ step: "private-index", cause })),
          );
        const env = {
          GIT_INDEX_FILE: path.join(directory, "index"),
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        };
        const indexGit = (args: ReadonlyArray<string>) =>
          git(
            cwd,
            [
              "-c",
              "core.splitIndex=false",
              "-c",
              "splitIndex.sharedIndexExpire=never",
              "-c",
              "core.fsmonitor=false",
              ...args,
            ],
            { env },
          );
        const sourceIndex = yield* out(cwd, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
        ]);
        const reusedIndex = yield* Effect.gen(function* () {
          if (!(yield* fs.exists(sourceIndex))) return false;
          // Retain force-added ignored paths without writing the source or its shared indexes.
          yield* fs.copyFile(sourceIndex, env.GIT_INDEX_FILE);
          // A nonzero past timestamp makes Git recheck same-size edits in the source index's second.
          yield* fs.utimes(env.GIT_INDEX_FILE, 1, 1);
          return true;
        }).pipe(
          Effect.mapError((cause) => new HandoffGitStepError({ step: "private-index", cause })),
        );
        if (!reusedIndex) yield* indexGit(["read-tree", tip]);
        yield* indexGit(["add", "--all", "--", ":/"]);
        const tree = (yield* indexGit(["write-tree"])).stdout.trim();
        const snapshot = (yield* git(
          cwd,
          ["commit-tree", tree, "-p", tip, "-m", `T3 Code handoff ${input.handoffId}`],
          { env },
        )).stdout.trim();
        const ref = snapshotRef(input.handoffId);
        yield* Effect.acquireRelease(git(cwd, ["update-ref", ref, snapshot, ""]), () =>
          git(cwd, ["update-ref", "-d", ref, snapshot]).pipe(Effect.ignore),
        );
        const bundlePath = path.resolve(input.outDir, `${input.handoffId}.bundle`);
        yield* git(cwd, ["bundle", "create", bundlePath, ref, "--not", "--remotes=origin"]);
        const bundleBytes = Number(
          (yield* fs
            .stat(bundlePath)
            .pipe(
              Effect.mapError((cause) => new HandoffGitStepError({ step: "bundle-stat", cause })),
            )).size,
        );
        if (bundleBytes > MAX_HANDOFF_BUNDLE_BYTES) {
          yield* fs
            .remove(bundlePath, { force: true })
            .pipe(
              Effect.mapError((cause) => new HandoffGitStepError({ step: "bundle-remove", cause })),
            );
          return yield* new HandoffTooLargeError({ bundleBytes });
        }
        const remote = yield* git(cwd, ["remote", "get-url", "origin"], {
          allowNonZeroExit: true,
        });
        return {
          bundlePath,
          bundleBytes,
          branch,
          tip,
          snapshot,
          baseRemoteUrl: remote.exitCode === 0 ? remote.stdout.trim() : null,
        };
      }),
    );
  });

  const apply: HandoffGit["Service"]["apply"] = Effect.fn("HandoffGit.apply")(function* (input) {
    let committed = false;
    let released = false;
    let ownsWorktree = false;
    let restoreBranch: Effect.Effect<void> = Effect.void;
    const rollback = Effect.gen(function* () {
      if (committed || released) return;
      released = true;
      if (ownsWorktree) {
        yield* git(input.repoRoot, ["worktree", "remove", "--force", input.worktreePath]).pipe(
          Effect.ignore,
        );
        yield* fs.remove(input.worktreePath, { recursive: true, force: true }).pipe(Effect.ignore);
      }
      yield* restoreBranch;
    });
    yield* Effect.addFinalizer(() => rollback);

    return yield* Effect.scoped(
      Effect.gen(function* () {
        if (!(yield* ok(input.repoRoot, ["bundle", "list-heads", input.bundlePath]))) {
          return yield* new HandoffGitStepError({ step: "bundle-read" });
        }
        if (!(yield* ok(input.repoRoot, ["bundle", "verify", input.bundlePath]))) {
          yield* git(input.repoRoot, ["fetch", "--quiet", "origin"], {
            allowNonZeroExit: true,
            env: nonInteractiveFetchEnv,
          });
          if (!(yield* ok(input.repoRoot, ["bundle", "verify", input.bundlePath]))) {
            return yield* new HandoffMissingBaseError();
          }
        }
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-handoff-fetch-" })
          .pipe(
            Effect.mapError((cause) => new HandoffGitStepError({ step: "fetch-directory", cause })),
          );
        const fetched = `refs/t3code/handoff/${input.handoffId}/${path.basename(directory)}`;
        yield* Effect.addFinalizer(() =>
          git(input.repoRoot, ["update-ref", "-d", fetched]).pipe(Effect.ignore),
        );
        yield* git(input.repoRoot, [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          input.bundlePath,
          `${snapshotRef(input.handoffId)}:${fetched}`,
        ]);
        if ((yield* out(input.repoRoot, ["rev-parse", fetched])) !== input.snapshot) {
          return yield* new HandoffGitStepError({ step: "snapshot-verify" });
        }
        if ((yield* out(input.repoRoot, ["rev-parse", `${fetched}^`])) !== input.tip) {
          return yield* new HandoffGitStepError({ step: "snapshot-parent-verify" });
        }
        let branch = input.branch;
        if (branch !== null) {
          const ref = `refs/heads/${branch}`;
          const existing = yield* git(input.repoRoot, ["show-ref", "--verify", "--hash", ref], {
            allowNonZeroExit: true,
          });
          const current = existing.exitCode === 0 ? existing.stdout.trim() : "";
          const checkedOut = (yield* out(input.repoRoot, ["worktree", "list", "--porcelain"]))
            .split("\n")
            .includes(`branch ${ref}`);
          if (checkedOut && current !== input.tip) {
            return yield* new HandoffBranchCheckedOutError({ branch });
          }
          if (current !== input.tip) {
            if (
              current !== "" &&
              !(yield* ok(input.repoRoot, ["merge-base", "--is-ancestor", current, input.tip]))
            ) {
              return yield* new HandoffBranchDivergedError({ branch });
            }
            // Keep the successful CAS and its ownership record inseparable under interruption.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* git(input.repoRoot, ["update-ref", ref, input.tip, current]);
                restoreBranch = git(
                  input.repoRoot,
                  current === ""
                    ? ["update-ref", "-d", ref, input.tip]
                    : ["update-ref", ref, current, input.tip],
                ).pipe(Effect.asVoid, Effect.ignore);
              }),
            );
          }
          if (checkedOut) branch = null;
        }
        // Reserve the directory before cancellable setup so a failed add cannot leave owned files.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* fs
              .makeDirectory(input.worktreePath)
              .pipe(
                Effect.mapError(
                  (cause) => new HandoffGitStepError({ step: "worktree-directory", cause }),
                ),
              );
            ownsWorktree = true;
          }),
        );
        yield* git(
          input.repoRoot,
          branch === null
            ? ["worktree", "add", "--detach", input.worktreePath, input.tip]
            : ["worktree", "add", input.worktreePath, branch],
        );
        // No-overlay checkout carries deletions; read-tree unstages edits without moving the branch.
        yield* git(input.worktreePath, ["checkout", "--no-overlay", input.snapshot, "--", "."]);
        yield* git(input.worktreePath, ["read-tree", input.tip]);
        return {
          branch,
          commit: Effect.sync(() => {
            committed = true;
          }),
        };
      }),
    ).pipe(Effect.onError(() => rollback));
  });

  return HandoffGit.of({ pack, apply });
});

export const layer = Layer.effect(HandoffGit, make);
