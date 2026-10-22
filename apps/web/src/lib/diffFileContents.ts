import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestRef,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";

import { resolveFileDiffPath } from "./diffRendering";

interface GitDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly cacheKey: string;
}

interface CheckpointDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly fromCheckpointRef: string;
  readonly toCheckpointRef: string;
  readonly cacheKey: string;
}

interface PullRequestDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly commit: string | null;
  readonly cacheKey: string;
}

type GetDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

type GetPullRequestDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestDiffFileContentsInput;
}) => Promise<AtomCommandResult<PullRequestDiffFileContentsResult, E>>;

// Git's --ignore-all-space treats these as whitespace. Newlines stay so line boundaries still count.
const IGNORED_WHITESPACE = /[ \t\v\f\r]+/g;
const exactLine = (a: string | undefined, b: string | undefined) => a === b;
const whitespaceInsensitiveLine = (a: string | undefined, b: string | undefined) =>
  a?.replace(IGNORED_WHITESPACE, "") === b?.replace(IGNORED_WHITESPACE, "");

// Partial diffs omit gaps between hunks, so compact line indices are translated back to source
// coordinates before validating the loaded files.
function matchesPatchLines(fileDiff: FileDiffMetadata, oldContents: string, newContents: string) {
  if (!fileDiff.isPartial) return true;
  const oldLines = oldContents.split(/(?<=\n)/);
  const newLines = newContents.split(/(?<=\n)/);
  const sideMatches = (
    patchLines: ReadonlyArray<string>,
    patchIndex: number,
    fileLines: ReadonlyArray<string>,
    start: number,
    count: number,
    linesMatch: typeof exactLine,
  ) => {
    if (count === 0) return true;
    // Out-of-range lines would compare `undefined === undefined`, so bounds come first.
    if (patchIndex < 0 || patchIndex + count > patchLines.length) return false;
    if (start < 1 || start - 1 + count > fileLines.length) return false;
    for (let offset = 0; offset < count; offset++) {
      if (!linesMatch(patchLines[patchIndex + offset], fileLines[start - 1 + offset])) return false;
    }
    return true;
  };
  // Context is checked on both sides so a one-sided change cannot accept a shifted file. Ignored
  // whitespace can differ between the two files' context; changed lines must match exactly.
  return fileDiff.hunks.every((hunk) =>
    hunk.hunkContent.every((content) => {
      const deletions = content.type === "change" ? content.deletions : content.lines;
      const additions = content.type === "change" ? content.additions : content.lines;
      const linesMatch = content.type === "change" ? exactLine : whitespaceInsensitiveLine;
      return (
        sideMatches(
          fileDiff.deletionLines,
          content.deletionLineIndex,
          oldLines,
          hunk.deletionStart + content.deletionLineIndex - hunk.deletionLineIndex,
          deletions,
          linesMatch,
        ) &&
        sideMatches(
          fileDiff.additionLines,
          content.additionLineIndex,
          newLines,
          hunk.additionStart + content.additionLineIndex - hunk.additionLineIndex,
          additions,
          linesMatch,
        )
      );
    }),
  );
}

// Hydration keeps the patch's hunk coordinates, so files that moved on since the patch was made
// (an edited working tree, a moved HEAD) would put unrelated lines under its changes. Rejecting
// keeps the patch rendered as it was. Pull request loaders skip this: their excerpts are synthetic.
function assertMatchesPatch(
  fileDiff: FileDiffMetadata,
  newPath: string,
  contents: { readonly oldContents: string; readonly newContents: string },
) {
  if (!matchesPatchLines(fileDiff, contents.oldContents, contents.newContents)) {
    throw new Error(`Loaded contents of ${newPath} no longer match its diff`);
  }
  return contents;
}

function createDiffFileContentsLoader(
  load: (input: {
    readonly changeType: PullRequestDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
    readonly fileDiff: FileDiffMetadata;
  }) => Promise<{ readonly oldContents: string; readonly newContents: string }>,
  cacheKey: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const contents = await load({ changeType: fileDiff.type, oldPath, newPath, fileDiff });
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") {
      return { oldFile: null, newFile };
    }
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}

export function createGitDiffFileContentsLoader<E>(
  getDiffFileContents: GetDiffFileContents<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath, fileDiff }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: source.cwd,
        sourceKind: source.sourceKind,
        changeType,
        baseRef: source.baseRef,
        headRef: source.headRef,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return assertMatchesPatch(fileDiff, newPath, result.value);
  }, source.cacheKey);
}

export function createCheckpointDiffFileContentsLoader<E>(
  getDiffFileContents: GetDiffFileContents<E>,
  source: CheckpointDiffFileContentsSource,
): FileDiffContentsLoader {
  // Both sides are saved checkpoints, never the working tree. A working-tree read of a "deleted"
  // file returns exactly `baseRef:oldPath` and skips the disk side, so each side is one such read.
  const readAt = async (ref: string, filePath: string) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: source.cwd,
        sourceKind: "working-tree",
        changeType: "deleted",
        baseRef: ref,
        headRef: null,
        oldPath: filePath,
        newPath: filePath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value.oldContents;
  };
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath, fileDiff }) => {
    const [oldContents, newContents] = await Promise.all([
      changeType === "new" || changeType === "rename-pure"
        ? ""
        : readAt(source.fromCheckpointRef, oldPath),
      changeType === "deleted" ? "" : readAt(source.toCheckpointRef, newPath),
    ]);
    return assertMatchesPatch(fileDiff, newPath, { oldContents, newContents });
  }, source.cacheKey);
}

export function createPullRequestDiffFileContentsLoader<E>(
  getDiffFileContents: GetPullRequestDiffFileContents<E>,
  source: PullRequestDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        ...source.reference,
        ...(source.commit === null ? {} : { commit: source.commit }),
        changeType,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}
