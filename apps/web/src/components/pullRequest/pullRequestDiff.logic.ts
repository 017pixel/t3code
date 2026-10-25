import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  PullRequestDiffResult,
  PullRequestDiffSide,
  PullRequestOmittedFileStat,
} from "@t3tools/contracts";

/** Only rendered hunks can anchor comments; list others off-diff. */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number,
): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

export type DiffFoldOverride = "expanded" | "folded" | null;

/** Keep fold choices relative to the toolbar so later pages inherit Fold all. */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

export function toggleFileDiffFoldForViewed(
  fileKey: string,
  viewed: boolean,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (isFileDiffCollapsed(fileKey, foldOverride, toggledFileKeys) === viewed)
    return toggledFileKeys;
  const next = new Set(toggledFileKeys);
  if (next.has(fileKey)) next.delete(fileKey);
  else next.add(fileKey);
  return next;
}

export interface DiffSlice {
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface DiffSliceState {
  readonly key: string;
  readonly cursor: string | null;
  readonly slices: ReadonlyArray<DiffSlice>;
}

/**
 * Merges one page answer into the slices. A page that came back different means the diff moved
 * under the review: the slices after it go with the replacement, and so does a cursor past it,
 * since their cursors were positions in the old diff.
 */
export function mergeDiffPage(
  state: DiffSliceState,
  pageCursor: string | null,
  page: PullRequestDiffResult,
): DiffSliceState {
  const next: DiffSlice = {
    cursor: pageCursor,
    patch: page.patch,
    truncated: page.truncated,
    nextCursor: page.nextCursor,
    omittedFileStats: page.omittedFileStats ?? [],
  };
  const index = state.slices.findIndex((slice) => slice.cursor === pageCursor);
  if (index === -1) return { ...state, slices: [...state.slices, next] };
  const existing = state.slices[index];
  if (
    existing !== undefined &&
    existing.patch === next.patch &&
    existing.truncated === next.truncated &&
    existing.nextCursor === next.nextCursor &&
    existing.omittedFileStats.length === next.omittedFileStats.length &&
    existing.omittedFileStats.every((file, fileIndex) => {
      const refreshed = next.omittedFileStats[fileIndex];
      return (
        refreshed !== undefined &&
        refreshed.path === file.path &&
        refreshed.additions === file.additions &&
        refreshed.deletions === file.deletions
      );
    })
  ) {
    return state;
  }
  const kept = state.slices.slice(0, index);
  const cursorKept =
    state.cursor === null || kept.some((slice) => slice.nextCursor === state.cursor);
  return { ...state, cursor: cursorKept ? state.cursor : pageCursor, slices: [...kept, next] };
}
