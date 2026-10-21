import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  getRenderablePatch,
  buildFileDiffIdentityKey,
  buildFileDiffContentVersion,
} from "~/lib/diffRendering";
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

import { PullRequestCodeScrollRestoration } from "./pullRequestCodeScroll.logic";
import { resolvePullRequestSelectionFile } from "./pullRequestSelection.logic";

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
      loadedPageCount: 3,
      chromeCondensed: true,
    }));
    const state = usePullRequestReviewStore.getState().codeViews[key]!;
    expect(state.selectedCommitOid).toBe("commit-a");
    expect(state.scrollTop).toBe(570);
    expect(state.chromeCondensed).toBe(true);
    expect(state.loadedPageCount).toBe(3);
    expect(isFileDiffCollapsed("file-a", state.foldOverride, state.toggledFiles)).toBe(false);
    expect(isFileDiffCollapsed("file-c", state.foldOverride, state.toggledFiles)).toBe(true);
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

  it("bounds file overrides within a session, evicting the oldest overrides", () => {
    const update = session();
    update(reviewKey(), (current) => ({
      ...current,
      toggledFiles: new Set(Array.from({ length: 2049 }, (_, index) => `file-${index}`)),
    }));
    const saved = usePullRequestReviewStore.getState().codeViews[reviewKey()]!;
    expect(saved.toggledFiles.size).toBe(2048);
    expect(isFileDiffCollapsed("file-0", "folded", saved.toggledFiles)).toBe(true);
    expect(isFileDiffCollapsed("file-2048", "folded", saved.toggledFiles)).toBe(false);
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

describe("pull request scroll restoration", () => {
  it("waits for saved pages without overwriting the offset with a first-page clamp", () => {
    const saved = { scrollTop: 1800, loadedPageCount: 3 };
    const restore = new PullRequestCodeScrollRestoration(saved);
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(restore.restore(surface, 0, false)).toBe("waiting");
    expect(restore.restore(surface, 1, true)).toBe("load-more");
    expect(restore.restore(surface, 2, true)).toBe("load-more");
    expect(surface.scrollTop).toBe(0);
    expect(restore.pending).toBe(true);
    surface.scrollHeight = 3000;
    expect(restore.restore(surface, 3, true)).toBe("restored");
    expect(surface.scrollTop).toBe(1800);
    expect(restore.pending).toBe(false);
    surface.scrollTop = 1900;
    expect(restore.restore(surface, 4, true)).toBe("waiting");
    expect(surface.scrollTop).toBe(1900);
  });

  it("restores raw offsets without losing the sticky header height on each roundtrip", () => {
    const surface = { scrollTop: 570, scrollHeight: 3000, clientHeight: 400 };
    for (let trip = 0; trip < 3; trip++) {
      const restore = new PullRequestCodeScrollRestoration({
        scrollTop: surface.scrollTop,
        loadedPageCount: 1,
      });
      surface.scrollTop = 0;
      expect(restore.restore(surface, 1, false)).toBe("restored");
      expect(surface.scrollTop).toBe(570);
    }
  });

  it("keeps the target pending while its tab has no viewport", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 570, loadedPageCount: 1 });
    const surface = { scrollTop: 0, scrollHeight: 3000, clientHeight: 0 };
    expect(restore.restore(surface, 1, false)).toBe("waiting");
    expect(restore.pending).toBe(true);
    surface.clientHeight = 400;
    expect(restore.restore(surface, 1, false)).toBe("restored");
    expect(surface.scrollTop).toBe(570);
  });

  it("stops paging and clamps once when the refreshed diff has fewer pages", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(restore.restore(undefined, 1, false)).toBe("waiting");
    expect(restore.restore(surface, 1, false)).toBe("restored");
    expect(surface.scrollTop).toBe(200);
    expect(restore.pending).toBe(false);
  });
});

describe("pull request line anchors", () => {
  it("keeps an anchor through unrelated patch changes but rejects changed or removed code", () => {
    const before = getRenderablePatch(page().patch, "before");
    const after = getRenderablePatch(page("shifted code").patch, "after");
    const same = getRenderablePatch(page().patch, "different-page-cache-key");
    if (before?.kind !== "files" || after?.kind !== "files" || same?.kind !== "files") {
      throw new Error("fixture must parse as files");
    }
    const original = before.files[0]!;
    const anchor = {
      fileKey: buildFileDiffIdentityKey(original),
      contentVersion: buildFileDiffContentVersion(original),
    };
    expect(resolvePullRequestSelectionFile([same.files[0]!, ...after.files.slice(1)], anchor)).toBe(
      same.files[0],
    );
    expect(buildFileDiffIdentityKey(after.files[0]!)).toBe(anchor.fileKey);
    expect(resolvePullRequestSelectionFile(after.files, anchor)).toBeUndefined();
    expect(resolvePullRequestSelectionFile(before.files.slice(1), anchor)).toBeUndefined();
  });
});
