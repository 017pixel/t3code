import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents",
    cwd: string,
  ) {
    const worktreesDirectories = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
    );
    const home = yield* HostProcess.HomeDirectory;
    const [candidate, workspaceRoot, worktreesRoots] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      // A managed root that cannot be resolved, or resolves to a filesystem
      // root through a symlink, is skipped rather than failing every review.
      Effect.forEach(
        managedWorktreesDirectories(worktreesDirectories, config.worktreesDir, path, home),
        (directory) => canonicalizePath(directory).pipe(Effect.orElseSucceed(() => null)),
      ).pipe(
        Effect.map((roots) =>
          roots.filter((root): root is string => root !== null && !isFilesystemRoot(root, path)),
        ),
      ),
    ]);

    if (
      isWithinRoot(candidate, workspaceRoot) ||
      worktreesRoots.some((root) => isWithinRoot(candidate, root))
    ) {
      return;
    }

    // Registered projects can live outside the server cwd, which is the home
    // directory in packaged desktop builds, e.g. a repository on another
    // Windows drive. Unreadable or unresolvable project roots grant nothing.
    const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
    for (const project of projects) {
      const root = yield* canonicalizePath(project.workspaceRoot).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && isWithinRoot(candidate, root)) {
        return;
      }
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const readDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  // Clients with a freshness epoch can reuse a preview across surface remounts.
  // Legacy callers still read fresh; failures are never retained.
  const previews = yield* Cache.makeWith(
    (key: string) => readDiffPreview(JSON.parse(key) as ReviewDiffPreviewInput),
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(5) : Duration.zero),
    },
  );
  // Expired entries leave memory only when read again, so drop them all once
  // no preview has been requested for the reuse window.
  const previewSweep = yield* FiberHandle.make();
  const sweepPreviewsWhenIdle = FiberHandle.run(
    previewSweep,
    Effect.sleep(Duration.seconds(5)).pipe(Effect.andThen(Cache.invalidateAll(previews))),
  );
  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = (input) =>
    assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd).pipe(
      Effect.andThen(
        input.cacheKey === undefined
          ? readDiffPreview(input)
          : Cache.get(
              previews,
              JSON.stringify({
                cwd: input.cwd,
                ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
                ...(input.baseRef ? { baseRef: input.baseRef } : {}),
                ignoreWhitespace: input.ignoreWhitespace ?? false,
                ...(input.file ? { file: input.file } : {}),
              }),
            ).pipe(Effect.ensuring(sweepPreviewsWhenIdle)),
      ),
    );

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
