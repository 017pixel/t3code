import { describe, expect, it, vi } from "vite-plus/test";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as reviewModel from "../review/reviewModel";
import {
  combinePullRequestDiffPages,
  getCachedPullRequestDiffPages,
  requestPullRequestDiffPaths,
  walkPullRequestDiffPages,
  type PullRequestDiffPage,
} from "./pullRequestDiffPages";

const GITHUB = sourceControlClients.get("github").changeRequest;

function diff(path: string): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    truncated: false,
    nextCursor: null,
  };
}

function withheldDiff(): PullRequestDiffResult {
  return {
    patch: "diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n",
    truncated: true,
    nextCursor: null,
    omittedFileStats: [{ path: "large.ts", additions: 3000, deletions: 1800 }],
  };
}

describe("paged mobile pull request diffs", () => {
  it("isolates scopes, cursors, and provider terminology for the same result", () => {
    const result = withheldDiff();
    const pages = [{ cursor: null, result }];
    const first = getCachedPullRequestDiffPages(pages, "first", GITHUB);
    const otherScope = getCachedPullRequestDiffPages(pages, "second", GITHUB);
    const otherCursor = getCachedPullRequestDiffPages(
      [{ cursor: "next", result }],
      "first",
      GITHUB,
    );
    const otherProvider = getCachedPullRequestDiffPages(
      pages,
      "first",
      sourceControlClients.get("gitlab").changeRequest,
    );
    expect(otherScope).not.toBe(first);
    expect(otherCursor).not.toBe(first);
    expect(otherProvider).not.toBe(first);
    if (first.kind !== "files" || otherScope.kind !== "files" || otherProvider.kind !== "files")
      throw new Error("Expected structured files");
    expect(otherScope.files[0]?.id).not.toBe(first.files[0]?.id);
    expect(first.notice).toContain("pull request");
    expect(otherProvider.notice).toContain("merge request");
    expect(getCachedPullRequestDiffPages(pages, "first", GITHUB)).toBe(first);
  });

  it("reuses earlier pages on append and invalidates changed continuation results", () => {
    using parse = vi.spyOn(reviewModel, "buildReviewParsedDiff");
    const firstPage = { cursor: null, result: diff("first.ts") };
    const first = getCachedPullRequestDiffPages([firstPage], "append", GITHUB);
    const nextPage = { cursor: "next", result: withheldDiff() };
    const combined = getCachedPullRequestDiffPages([firstPage, nextPage], "append", GITHUB);
    expect(parse).toHaveBeenCalledTimes(2);
    if (first.kind !== "files" || combined.kind !== "files") throw new Error("Expected files");
    expect(combined.files[0]).toBe(first.files[0]);
    expect(combined.files.map((file) => file.path)).toEqual(["first.ts", "large.ts"]);
    expect(getCachedPullRequestDiffPages([firstPage, nextPage], "append", GITHUB)).toBe(combined);
    const refreshed = getCachedPullRequestDiffPages(
      [
        firstPage,
        {
          ...nextPage,
          result: {
            ...nextPage.result,
            omittedFileStats: [{ path: "large.ts", additions: 4000, deletions: 2000 }],
          },
        },
      ],
      "append",
      GITHUB,
    );
    expect(parse).toHaveBeenCalledTimes(3);
    expect(refreshed).not.toBe(combined);
    if (refreshed.kind !== "files") throw new Error("Expected refreshed files");
    expect(refreshed.files[0]).toBe(first.files[0]);
    expect(refreshed.files[1]).toMatchObject({ additions: 4000, deletions: 2000 });
    expect(combined.files[1]?.additions).toBe(3000);
  });

  it("withheld PR hunks must retain provider line counts", () => {
    const result = withheldDiff();
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const pages = [{ cursor: null, result }];
    const parsed = combinePullRequestDiffPages(pages, cache, "pr", GITHUB);
    if (parsed.kind !== "files") throw new Error("Expected structured diff");
    expect(parsed.files[0]).toMatchObject({
      path: "large.ts",
      additions: 3000,
      deletions: 1800,
      rows: [],
    });
    expect(parsed.additions).toBe(3000);
    expect(parsed.deletions).toBe(1800);
    expect(parsed.notice).toBe(
      "Some file contents are unavailable. Open the pull request on its provider to see the full changes.",
    );
    const cached = combinePullRequestDiffPages(pages, cache, "pr", GITHUB);
    if (cached.kind !== "files") throw new Error("Expected structured diff");
    expect(cached.files[0]).toBe(parsed.files[0]);
  });

  it("points a withheld merge request diff at the merge request", () => {
    const parsed = combinePullRequestDiffPages(
      [{ cursor: null, result: withheldDiff() }],
      new WeakMap(),
      "mr",
      sourceControlClients.get("gitlab").changeRequest,
    );
    expect(parsed.kind === "files" ? parsed.notice : null).toBe(
      "Some file contents are unavailable. Open the merge request on its provider to see the full changes.",
    );
  });

  it("combines normal and withheld pages and refreshes counts with unchanged patch text", () => {
    const first = { ...diff("first.ts"), nextCursor: "second" };
    const withheld = withheldDiff();
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const pages = [
      { cursor: null, result: first },
      { cursor: "second", result: withheld },
    ];
    const before = combinePullRequestDiffPages(pages, cache, "pr", GITHUB);
    if (before.kind !== "files") throw new Error("Expected structured diff");
    expect(before.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ["first.ts", 1, 1],
      ["large.ts", 3000, 1800],
    ]);
    expect(before.additions).toBe(3001);
    expect(before.deletions).toBe(1801);

    const refreshed = [
      pages[0]!,
      {
        cursor: "second",
        result: {
          ...withheld,
          omittedFileStats: [{ path: "large.ts", additions: 4000, deletions: 2000 }],
        },
      },
    ];
    const after = combinePullRequestDiffPages(refreshed, cache, "pr", GITHUB);
    if (after.kind !== "files") throw new Error("Expected structured diff");
    expect(after.files[0]).toBe(before.files[0]);
    expect(after.files[1]?.id).toBe(before.files[1]?.id);
    expect(after.files[1]).toMatchObject({ additions: 4000, deletions: 2000, rows: [] });
    expect(after.additions).toBe(4001);
    expect(after.deletions).toBe(2001);
    expect(after.notice).toBe(before.notice);
    expect(before.additions).toBe(3001);
  });

  it("pages on until the wanted files load, then stops", () => {
    const answers = new Map<string | null, PullRequestDiffResult>([
      [null, { ...diff("a.ts"), nextCursor: "2" }],
      ["2", { ...diff("b.ts"), nextCursor: "3" }],
      ["3", { ...diff("c.ts"), nextCursor: "4" }],
      ["4", diff("d.ts")],
    ]);
    const read = (cursor: string | null) => answers.get(cursor) ?? null;
    const paths = (page: PullRequestDiffPage) => [page.result.patch.split(" ")[2]!.slice(2)];
    const walk = (count: number, wanted: readonly string[]) => {
      const { pages, frontier } = walkPullRequestDiffPages(read, count, wanted, paths);
      return { cursors: pages.map((page) => page.cursor), frontier };
    };

    expect(walk(1, [])).toEqual({ cursors: [null], frontier: null });
    expect(walk(1, ["c.ts"])).toEqual({ cursors: [null, "2", "3"], frontier: "3" });
    expect(walk(4, [])).toEqual({ cursors: [null, "2", "3", "4"], frontier: "4" });
    expect(walk(1, ["gone.ts"])).toEqual({ cursors: [null, "2", "3", "4"], frontier: "4" });
    answers.delete("3");
    expect(walk(1, ["d.ts"])).toEqual({ cursors: [null, "2"], frontier: "3" });
  });

  it("keeps pages loaded while seeking one file when the wanted file moves to an earlier page", () => {
    const answers = new Map<string | null, PullRequestDiffResult>([
      [null, { ...diff("a.ts"), nextCursor: "2" }],
      ["2", { ...diff("b.ts"), nextCursor: "3" }],
      ["3", { ...diff("c.ts"), nextCursor: "4" }],
      ["4", diff("d.ts")],
    ]);
    const read = (cursor: string | null) => answers.get(cursor) ?? null;
    const paths = (page: PullRequestDiffPage) => [page.result.patch.split(" ")[2]!.slice(2)];
    const shown = (request: { count: number; wanted: readonly string[] }) =>
      walkPullRequestDiffPages(read, request.count, request.wanted, paths).pages.map(
        (page) => page.cursor,
      );

    const opened = requestPullRequestDiffPaths({ key: "pr", count: 1, wanted: [] }, "pr", ["c.ts"]);
    expect(shown(opened)).toEqual([null, "2", "3"]);
    const jumped = requestPullRequestDiffPaths(opened, "pr", ["a.ts"]);
    expect(shown(jumped)).toEqual([null, "2", "3"]);
    expect(requestPullRequestDiffPaths(jumped, "pr", ["a.ts"])).toBe(jumped);
    expect(requestPullRequestDiffPaths(jumped, "other", ["a.ts"])).toEqual({
      key: "other",
      count: 1,
      wanted: ["a.ts"],
    });
  });

  it("drops later pages when a refreshed page points elsewhere, and stops on a cursor loop", () => {
    const answers = new Map<string | null, PullRequestDiffResult>([
      [null, { ...diff("a.ts"), nextCursor: "2" }],
      ["2", { ...diff("b.ts"), nextCursor: "2" }],
    ]);
    const read = (cursor: string | null) => answers.get(cursor) ?? null;
    expect(walkPullRequestDiffPages(read, 5, [], () => []).pages).toHaveLength(2);
    answers.set(null, diff("changed.ts"));
    const { pages } = walkPullRequestDiffPages(read, 5, [], () => []);
    expect(pages.map((page) => page.result.patch)).toEqual([diff("changed.ts").patch]);
  });
});
