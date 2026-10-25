import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeResponseGroupCheckpoints, responseGroupFoldLabel } from "./responseGroups.ts";
import type { ThreadCheckpointSummary } from "./threadCheckpoints.ts";

const summary = (
  turnCount: number,
  files: ThreadCheckpointSummary["files"],
  status: ThreadCheckpointSummary["status"] = "ready",
): ThreadCheckpointSummary => ({
  runId: RunId.make(`run-${turnCount}`),
  checkpointTurnCount: turnCount,
  checkpointRef: `refs/t3/${turnCount}` as ThreadCheckpointSummary["checkpointRef"],
  status,
  files,
  assistantMessageId: null,
  completedAt: "2026-01-01T00:00:00.000Z",
});

describe("mergeResponseGroupCheckpoints", () => {
  it("sums stats per path and keeps a file's net kind across runs", () => {
    const merged = mergeResponseGroupCheckpoints([
      summary(5, [
        { path: "kept.ts", kind: "added", additions: 4, deletions: 0 },
        { path: "gone.ts", kind: "added", additions: 2, deletions: 0 },
      ]),
      summary(6, [], "missing"),
      summary(7, [
        { path: "kept.ts", kind: "modified", additions: 1, deletions: 1 },
        { path: "gone.ts", kind: "deleted", additions: 0, deletions: 2 },
      ]),
    ]);
    expect(merged).toMatchObject({
      runId: "run-7",
      checkpointTurnCount: 7,
      rangeFromTurnCount: 4,
      files: [
        { path: "kept.ts", kind: "added", additions: 5, deletions: 1 },
        { path: "gone.ts", kind: "deleted", additions: 2, deletions: 2 },
      ],
    });
  });

  it("returns a lone ready checkpoint unchanged, and nothing without one", () => {
    const only = summary(3, [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }]);
    expect(mergeResponseGroupCheckpoints([only, summary(4, [], "error")])).toBe(only);
    expect(mergeResponseGroupCheckpoints([summary(4, [], "missing")])).toBeNull();
  });
});

describe("responseGroupFoldLabel", () => {
  it("names the time, the wakes it folds, and earlier failures", () => {
    const base = { durationMs: 99 * 60_000, updates: 4, failed: 0, stopped: false, live: false };
    expect(responseGroupFoldLabel(base)).toBe("Worked for 1h 39m · 4 updates");
    expect(responseGroupFoldLabel({ ...base, updates: 1, failed: 1 })).toBe(
      "Worked for 1h 39m · 1 update · 1 failed",
    );
    expect(responseGroupFoldLabel({ ...base, stopped: true, updates: 0 })).toBe(
      "You stopped after 1h 39m",
    );
    expect(responseGroupFoldLabel({ ...base, live: true, durationMs: null })).toBe(
      "Working · 4 updates",
    );
  });
});
