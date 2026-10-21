import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import { getRenderablePatch, buildFileDiffIdentityKey } from "~/lib/diffRendering";
import {
  isFileDiffCollapsed,
  mergePullRequestDiffSlices,
  type DiffSlice,
} from "./pullRequestDiff.logic";
import {
  EMPTY_CODE_VIEW,
  pullRequestCodeViewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

const reference = {
  projectId: ProjectId.make("project-a"),
  host: "github.com",
  repository: "owner/repo",
  number: 7,
};
function session() {
  usePullRequestReviewStore.setState(usePullRequestReviewStore.getInitialState(), true);
  return usePullRequestReviewStore.getState().updateCodeView;
}
function reviewKey(thread: string | null = "thread-a", environment = "environment-a", number = 7) {
  return pullRequestCodeViewKey(environment, thread, { ...reference, number });
}
function page(after = "after"): DiffSlice {
  return {
    cursor: null,
    omittedFileStats: [],
    patch: Array.from({ length: 11 }, (_, index) =>
      [
        `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
        `--- a/src/file-${index}.ts`,
        `+++ b/src/file-${index}.ts`,
        "@@ -1 +1 @@",
        "-before",
        `+${after}`,
      ].join("\n"),
    ).join("\n"),
    nextCursor: null,
    truncated: false,
  };
}

describe("pull request Code tab session", () => {
  it("retains lightweight review choices after the active surface detaches", () => {
    const update = session();
    const key = reviewKey();
    update(key, () => ({
      selectedCommitOid: "commit-a",
      foldOverride: "folded",
      toggledFiles: new Set(["file-a", "file-b"]),
      scrollTop: 570,
    }));
    const unsubscribe = usePullRequestReviewStore.subscribe(() => {});
    unsubscribe();
    const state = usePullRequestReviewStore.getState().codeViews[key]!;
    expect(state.selectedCommitOid).toBe("commit-a");
    expect(state.scrollTop).toBe(570);
    expect(isFileDiffCollapsed("file-a", state.foldOverride, state.toggledFiles)).toBe(false);
    expect(isFileDiffCollapsed("file-c", state.foldOverride, state.toggledFiles)).toBe(true);
    expect(Object.keys(state).sort()).toEqual([
      "foldOverride",
      "scrollTop",
      "selectedCommitOid",
      "toggledFiles",
    ]);
  });

  it.each([
    ["another thread", reviewKey("thread-b")],
    ["global page", reviewKey(null)],
    ["another environment", reviewKey("thread-a", "environment-b")],
    ["another PR", reviewKey("thread-a", "environment-a", 8)],
  ])("separates review choices from %s", (_label, otherKey) => {
    const update = session();
    update(reviewKey(), (current) => ({
      ...current,
      selectedCommitOid: "commit-a",
      scrollTop: 570,
    }));
    update(otherKey, (current) => ({ ...current, selectedCommitOid: "commit-b" }));
    expect(usePullRequestReviewStore.getState().codeViews[reviewKey()]?.scrollTop).toBe(570);
    expect(usePullRequestReviewStore.getState().codeViews[otherKey]?.scrollTop).toBe(0);
  });

  it("bounds retained sessions and keeps a recently updated session", () => {
    const update = session();
    for (let number = 0; number < 32; number++)
      update(reviewKey(null, "env", number), () => ({ ...EMPTY_CODE_VIEW }));
    update(reviewKey(null, "env", 0), (current) => ({ ...current, scrollTop: 5 }));
    update(reviewKey(null, "env", 32), () => ({ ...EMPTY_CODE_VIEW }));
    const views = usePullRequestReviewStore.getState().codeViews;
    expect(Object.keys(views)).toHaveLength(32);
    expect(views[reviewKey(null, "env", 0)]?.scrollTop).toBe(5);
    expect(views[reviewKey(null, "env", 1)]).toBeUndefined();
  });

  it("does not notify consumers for a no-op update", () => {
    const update = session();
    const before = usePullRequestReviewStore.getState();
    update(reviewKey(), (current) => current);
    expect(usePullRequestReviewStore.getState()).toBe(before);
  });
});

describe("pull request refresh pages", () => {
  it.each([false, true])(
    "keeps all loaded pages when the first page is unchanged (new identity: %s)",
    (copy) => {
      const first = { ...page(), nextCursor: "next" };
      const second = { ...page(), cursor: "next" };
      const slices = [first, second];
      const merged = mergePullRequestDiffSlices(slices, copy ? { ...first } : first);
      expect(merged).toBe(slices);
      const parsed = getRenderablePatch(merged[0]!.patch, "review");
      expect(parsed?.kind === "files" && parsed.files.length).toBe(11);
    },
  );

  it("prunes pages after a changed first page", () => {
    const slices = [
      { ...page(), nextCursor: "next" },
      { ...page(), cursor: "next" },
    ];
    const changed = page("edited again");
    expect(mergePullRequestDiffSlices(slices, changed)).toEqual([changed]);
  });

  it("keeps preceding pages when a later page changes", () => {
    const first = { ...page(), nextCursor: "next" };
    const changed = { ...page("edited again"), cursor: "next" };
    expect(
      mergePullRequestDiffSlices(
        [first, { ...page(), cursor: "next" }, { ...page(), cursor: "last" }],
        changed,
      ),
    ).toEqual([first, changed]);
  });

  it("invalidates following cursors when omitted file stats change", () => {
    const first = { ...page(), nextCursor: "next" };
    const changed = {
      ...first,
      omittedFileStats: [{ path: "large.ts", additions: 2, deletions: 1 }],
    };
    expect(mergePullRequestDiffSlices([first, { ...page(), cursor: "next" }], changed)).toEqual([
      changed,
    ]);
  });
});
describe("pull request file keys", () => {
  it.each(["expanded", "folded"] as const)(
    "preserves a file toggle against the %s default after its patch changes",
    (foldOverride) => {
      const before = getRenderablePatch(page().patch, "review:page");
      const refreshed = getRenderablePatch(page("edited again").patch, "review:page");
      if (before?.kind !== "files" || refreshed?.kind !== "files") {
        throw new Error("fixture must parse as eleven files");
      }
      const originalKey = buildFileDiffIdentityKey(before.files[1]!);
      const refreshedKey = buildFileDiffIdentityKey(refreshed.files[1]!);
      const toggled = new Set([originalKey]);
      expect(isFileDiffCollapsed(refreshedKey, foldOverride, toggled)).toBe(
        isFileDiffCollapsed(originalKey, foldOverride, toggled),
      );
    },
  );

  it.each(["after", "edited again"])(
    "keeps path identity when a refreshed page has different parser cache keys (%s)",
    (content) => {
      const before = getRenderablePatch(page().patch, "review:page:old-hash");
      const refreshed = getRenderablePatch(page(content).patch, "review:page:new-hash");
      expect(before?.kind).toBe("files");
      expect(refreshed?.kind).toBe("files");
      if (before?.kind !== "files" || refreshed?.kind !== "files") {
        throw new Error("fixture must parse as eleven files");
      }
      expect(before.files).toHaveLength(11);
      expect(refreshed.files.map(buildFileDiffIdentityKey)).toEqual(
        before.files.map(buildFileDiffIdentityKey),
      );
      expect(new Set(before.files.map(buildFileDiffIdentityKey)).size).toBe(11);
    },
  );
});
