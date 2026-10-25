import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  mergeDiffPage,
  toggleFileDiffFoldForViewed,
} from "./pullRequestDiff.logic";

function fileWithHunks(
  hunks: ReadonlyArray<{
    deletionStart: number;
    deletionCount: number;
    additionStart: number;
    additionCount: number;
  }>,
): FileDiffMetadata {
  return { name: "src/app.ts", hunks } as unknown as FileDiffMetadata;
}

describe("isLineInFileDiff", () => {
  const file = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 0, additionStart: 42, additionCount: 2 },
  ]);

  it("includes the first line of a hunk and excludes the one past its last", () => {
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  // regression: #9174 diffs now expand by default; a reader's fold must survive new slices
  it("keeps a file the reader folded closed as the next slice arrives", () => {
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", null, toggled)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, toggled)).toBe(false);
  });
});

describe("toggleFileDiffFoldForViewed", () => {
  it("moves against whatever the toolbar last asked for", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", true, "expanded", new Set())]).toEqual(["a.ts"]);
    expect(toggleFileDiffFoldForViewed("a.ts", false, "expanded", new Set()).size).toBe(0);
  });
});

describe("mergeDiffPage", () => {
  const page = (patch: string, nextCursor: string | null) => ({
    patch,
    truncated: false,
    nextCursor,
  });
  const empty = { key: "k", cursor: null, slices: [] };

  it("appends pages and keeps the state when a page comes back unchanged", () => {
    const first = mergeDiffPage(empty, null, page("a", "c1"));
    const walked = mergeDiffPage({ ...first, cursor: "c1" }, "c1", page("b", null));
    expect(walked.slices.map((slice) => slice.patch)).toEqual(["a", "b"]);
    expect(mergeDiffPage(walked, null, page("a", "c1"))).toBe(walked);
  });

  it("drops the later pages and their cursor when the first page changed", () => {
    const walked = mergeDiffPage(
      { ...mergeDiffPage(empty, null, page("a", "c1")), cursor: "c1" },
      "c1",
      page("b", null),
    );
    const moved = mergeDiffPage(walked, null, page("a2", "c9"));
    expect(moved.slices.map((slice) => slice.patch)).toEqual(["a2"]);
    expect(moved.cursor).toBeNull();
  });
});
