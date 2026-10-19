import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../../vcs/VcsProcess.ts";

export const MAX_HANDOFF_BUNDLE_BYTES = 50 * 1024 * 1024;

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
    return `The Git package is ${Math.ceil(this.bundleBytes / 1024 / 1024)} MiB, over the ${MAX_HANDOFF_BUNDLE_BYTES / 1024 / 1024} MiB a handoff carries. Commit and push large files, or reduce uncommitted changes, then try again.`;
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
  {
    step: Schema.String,
    reason: Schema.optional(
      Schema.Literals(["bundle-not-written", "snapshot-mismatch", "gitlinks", "index-too-large"]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "bundle-not-written":
        return "The bundle was not written.";
      case "snapshot-mismatch":
        return "The bundle does not hold the snapshot it was sent with.";
      case "gitlinks":
        return "Git handoff does not carry submodules or nested repositories. Transfer this checkout manually.";
      case "index-too-large":
        return "This checkout has too many indexed files for Git handoff. Transfer it manually.";
      default:
        return `git ${this.step} failed.`;
    }
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
    }) => Effect.Effect<{ readonly branch: string | null }, HandoffGitError>;
  }
>()("t3/peer/handoff/HandoffGit") {}

const IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};

const handoffRef = (handoffId: string, name: string) => `refs/t3code/handoff/${handoffId}/${name}`;

const REPOSITORY_ENV = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
} satisfies NodeJS.ProcessEnv;

const make = Effect.gen(function* () {
  const processes = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const git = (
    cwd: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly maxOutputBytes?: number;
      readonly stdin?: string;
    } = {},
  ) =>
    processes
      .run({
        operation: "HandoffGit",
        command: "git",
        cwd,
        args,
        timeoutMs: 120_000,
        env: { ...process.env, ...REPOSITORY_ENV, ...options.env },
        ...(options.allowNonZeroExit === undefined
          ? {}
          : { allowNonZeroExit: options.allowNonZeroExit }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new HandoffGitStepError({
              step: args[0] ?? "git",
              cause,
            }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("handoff-git.step-failed", { step: error.step, cause: error.cause }),
        ),
      );

  const out = (cwd: string, args: ReadonlyArray<string>) =>
    git(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));

  const ok = (cwd: string, args: ReadonlyArray<string>) =>
    git(cwd, args, { allowNonZeroExit: true }).pipe(Effect.map((result) => result.exitCode === 0));

  const pack = Effect.fn("HandoffGit.pack")(function* (
    input: Parameters<HandoffGit["Service"]["pack"]>[0],
  ) {
    if (!(yield* ok(input.cwd, ["rev-parse", "--verify", "HEAD"]))) {
      return yield* new HandoffNotARepositoryError({ cwd: input.cwd });
    }
    const tip = yield* out(input.cwd, ["rev-parse", "HEAD"]);
    const branchName = yield* git(input.cwd, ["symbolic-ref", "--quiet", "HEAD"], {
      allowNonZeroExit: true,
    });
    const branch =
      branchName.exitCode === 0 ? branchName.stdout.trim().replace(/^refs\/heads\//, "") : null;
    const gitDir = yield* out(input.cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const indexDir = yield* fileSystem
      .makeTempDirectoryScoped({
        directory: gitDir,
        prefix: "t3-handoff-index-",
      })
      .pipe(Effect.mapError((cause) => new HandoffGitStepError({ step: "read-tree", cause })));
    const env = {
      GIT_INDEX_FILE: path.join(indexDir, "index"),
      ...IDENTITY,
      ...VcsProcess.gitConfigEnv(process.env, "core.splitIndex", "false", process.platform),
    };
    yield* git(input.cwd, ["read-tree", tip], { env });
    const ignored = yield* git(
      input.cwd,
      [
        "ls-files",
        "--cached",
        "--stage",
        "--ignored",
        "--exclude-standard",
        "--full-name",
        "-z",
        "--",
        ":/",
      ],
      { maxOutputBytes: 16 * 1024 * 1024 },
    );
    if (ignored.stdoutTruncated) {
      return yield* new HandoffGitStepError({ step: "pack", reason: "index-too-large" });
    }
    // Force-staged ignored files are work; seed only their entries without copying index flags.
    if (ignored.stdout !== "") {
      yield* git(input.cwd, ["update-index", "-z", "--index-info"], {
        env,
        stdin: ignored.stdout,
      });
    }
    // The root pathspec includes edits above cwd without touching the sender index.
    yield* git(input.cwd, ["add", "--all", "--", ":/"], { env });
    const entries = yield* git(input.cwd, ["ls-files", "--stage", "-z", "--", ":/"], {
      env,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (entries.stdoutTruncated) {
      return yield* new HandoffGitStepError({ step: "pack", reason: "index-too-large" });
    }
    if (entries.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) {
      return yield* new HandoffGitStepError({ step: "pack", reason: "gitlinks" });
    }
    const tree = (yield* git(input.cwd, ["write-tree"], { env })).stdout.trim();
    const snapshot = (yield* git(
      input.cwd,
      ["commit-tree", tree, "-p", tip, "-m", `T3 Code handoff ${input.handoffId}`],
      { env },
    )).stdout.trim();
    const snapshotRef = handoffRef(input.handoffId, "snapshot");
    yield* Effect.acquireRelease(git(input.cwd, ["update-ref", snapshotRef, snapshot, ""]), () =>
      git(input.cwd, ["update-ref", "-d", snapshotRef, snapshot]).pipe(Effect.ignore),
    );
    const bundlePath = path.resolve(input.outDir, `${input.handoffId}.bundle`);
    yield* Effect.acquireRelease(
      fileSystem
        .writeFileString(bundlePath, "", { flag: "wx" })
        .pipe(Effect.mapError((cause) => new HandoffGitStepError({ step: "bundle", cause }))),
      (_, exit) =>
        Exit.isFailure(exit)
          ? fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore)
          : Effect.void,
    );
    yield* git(input.cwd, ["bundle", "create", bundlePath, snapshotRef, "--not", "--remotes"]);
    const bundleBytes = Number(
      (yield* fileSystem.stat(bundlePath).pipe(
        Effect.mapError(
          (cause) =>
            new HandoffGitStepError({
              step: "bundle",
              reason: "bundle-not-written",
              cause,
            }),
        ),
      )).size,
    );
    if (bundleBytes > MAX_HANDOFF_BUNDLE_BYTES) {
      return yield* new HandoffTooLargeError({ bundleBytes });
    }
    const remote = yield* git(input.cwd, ["remote", "get-url", "origin"], {
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
  }, Effect.scoped);

  const apply = Effect.fn("HandoffGit.apply")(function* (
    input: Parameters<HandoffGit["Service"]["apply"]>[0],
  ) {
    if (!(yield* ok(input.repoRoot, ["bundle", "verify", input.bundlePath]))) {
      if (!(yield* ok(input.repoRoot, ["remote", "get-url", "origin"]))) {
        return yield* new HandoffMissingBaseError();
      }
      yield* git(input.repoRoot, ["fetch", "--quiet", "origin"], { allowNonZeroExit: true });
      if (!(yield* ok(input.repoRoot, ["bundle", "verify", input.bundlePath]))) {
        return yield* new HandoffMissingBaseError();
      }
    }
    const snapshotRef = handoffRef(input.handoffId, "snapshot");
    const heads = yield* out(input.repoRoot, [
      "bundle",
      "list-heads",
      input.bundlePath,
      snapshotRef,
    ]);
    if (heads !== `${input.snapshot} ${snapshotRef}`) {
      return yield* new HandoffGitStepError({ step: "fetch", reason: "snapshot-mismatch" });
    }
    // Import objects without changing receiver refs or FETCH_HEAD.
    yield* git(input.repoRoot, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      input.bundlePath,
      snapshotRef,
    ]);
    const worktreePath = path.resolve(input.worktreePath);
    const worktreeListArgs = ["worktree", "list", "--porcelain"];
    const listed = yield* git(input.repoRoot, [...worktreeListArgs, "-z"], {
      allowNonZeroExit: true,
    });
    // Git before 2.36 only supports the line-delimited form.
    const worktrees =
      listed.exitCode === 0
        ? listed.stdout.split("\0")
        : (yield* out(input.repoRoot, worktreeListArgs)).split("\n");
    if (
      worktrees.some(
        (field) => field.startsWith("worktree ") && path.resolve(field.slice(9)) === worktreePath,
      )
    ) {
      return yield* new HandoffGitStepError({ step: "worktree" });
    }
    let branch = input.branch;
    if (branch !== null) {
      const ref = `refs/heads/${branch}`;
      const existing = yield* git(input.repoRoot, ["rev-parse", "--verify", "--quiet", ref], {
        allowNonZeroExit: true,
      });
      const current = existing.exitCode === 0 ? existing.stdout.trim() : "";
      const checkedOut = worktrees.includes(`branch ${ref}`);
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
        yield* Effect.acquireRelease(
          git(input.repoRoot, ["update-ref", ref, input.tip, current]),
          (_, exit) =>
            Exit.isFailure(exit)
              ? git(
                  input.repoRoot,
                  current === ""
                    ? ["update-ref", "-d", ref, input.tip]
                    : ["update-ref", ref, current, input.tip],
                ).pipe(Effect.ignore)
              : Effect.void,
        );
      }
      if (checkedOut) branch = null;
    }
    // Reserve the path before Git can partially create a checkout or run a failing hook.
    yield* Effect.acquireRelease(
      fileSystem
        .makeDirectory(worktreePath)
        .pipe(Effect.mapError((cause) => new HandoffGitStepError({ step: "worktree", cause }))),
      (_, exit) =>
        Exit.isFailure(exit)
          ? git(input.repoRoot, ["worktree", "remove", "--force", worktreePath]).pipe(
              Effect.ignore,
              Effect.andThen(
                fileSystem
                  .remove(worktreePath, { recursive: true, force: true })
                  .pipe(Effect.ignore),
              ),
            )
          : Effect.void,
    );
    yield* git(
      input.repoRoot,
      branch === null
        ? ["worktree", "add", "--detach", worktreePath, input.tip]
        : ["worktree", "add", worktreePath, branch],
    );
    yield* git(worktreePath, ["checkout", "--no-overlay", input.snapshot, "--", "."]);
    // Restore the index without resetting a branch another process may have moved.
    yield* git(worktreePath, ["read-tree", input.tip]);
    return { branch };
  }, Effect.scoped);

  return HandoffGit.of({ pack, apply });
});

export const layer = Layer.effect(HandoffGit, make);
