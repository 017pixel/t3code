import { idleCompactionOf, type RunId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import type { ThreadCheckpointSummary } from "./threadCheckpoints.ts";

/**
 * A response group is everything from one prompt to the next: the prompt's own
 * run plus every wake run (background results, restart notices) after it. The
 * timeline folds a whole group behind one row, so a long `/goal` thread reads
 * as prompt -> fold -> latest answer.
 *
 * Every prompt starts a group, including prompts another agent sent. A steer
 * starts one only once its run has output (back-to-back steers start one).
 * Wakes arrive as notification items, not user messages, so they join the
 * current group. Idle `/compact` is T3 Code's own housekeeping and joins it too.
 */
export function messageStartsResponseGroup(
  message: Parameters<typeof idleCompactionOf>[0],
): boolean {
  return message.role === "user" && idleCompactionOf(message) === undefined;
}

export function responseGroupKey(startEntryId: string): string {
  return `group:${startEntryId}`;
}

export interface ResponseGroupLabelInput {
  readonly durationMs: number | null;
  /** Runs a notification started inside the group. */
  readonly updates: number;
  /** Earlier runs in the group that failed. Interrupts are not failures. */
  readonly failed: number;
  /** The group's latest run was interrupted. */
  readonly stopped: boolean;
  readonly live: boolean;
}

/**
 * The live label carries no time: the working row already ticks from the same
 * start, and a ticking label here would re-derive every row each second.
 */
export function responseGroupFoldLabel(input: ResponseGroupLabelInput): string {
  const duration = input.durationMs === null ? null : formatDuration(input.durationMs);
  const head = input.live
    ? "Working"
    : input.stopped
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";
  const parts = [head];
  if (input.updates > 0)
    parts.push(`${input.updates} ${input.updates === 1 ? "update" : "updates"}`);
  if (input.failed > 0) parts.push(`${input.failed} failed`);
  return parts.join(" · ");
}

/**
 * One changed-files summary for a whole group. Checkpoint stats are per-run
 * deltas, so summing them counts lines touched; a file added and then removed
 * inside the group still shows its churn while the range diff shows nothing.
 * `rangeFromTurnCount` makes "Open diff" span the group instead of one run.
 * The server diffs only to a completed run's checkpoint, so the range ends at
 * the last run not in `unfinishedRunIds` (stopped or failed).
 */
export function mergeResponseGroupCheckpoints(
  summaries: ReadonlyArray<ThreadCheckpointSummary>,
  unfinishedRunIds: ReadonlySet<RunId> = new Set(),
): ThreadCheckpointSummary | null {
  const ready = summaries
    .filter((summary) => summary.status === "ready")
    .sort((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);
  const first = ready[0];
  const end = ready.findLast((summary) => !unfinishedRunIds.has(summary.runId));
  const last = end ?? ready.at(-1);
  if (first === undefined || last === undefined) return null;
  if (ready.length === 1) return first;

  const files = new Map<
    string,
    { kind: string; firstKind: string; additions: number; deletions: number }
  >();
  for (const summary of ready) {
    for (const file of summary.files) {
      const existing = files.get(file.path);
      if (existing === undefined) {
        files.set(file.path, {
          kind: file.kind,
          firstKind: file.kind,
          additions: file.additions,
          deletions: file.deletions,
        });
        continue;
      }
      existing.kind = file.kind;
      existing.additions += file.additions;
      existing.deletions += file.deletions;
    }
  }
  return {
    ...last,
    // With no completed run to end at, or only one turn to show, the card
    // opens that run's own diff.
    ...(end === undefined || end === first
      ? {}
      : { rangeFromTurnCount: first.checkpointTurnCount - 1 }),
    files: Array.from(files, ([path, file]) => ({
      path,
      kind: file.kind !== "deleted" && file.firstKind === "added" ? "added" : file.kind,
      additions: file.additions,
      deletions: file.deletions,
    })),
  };
}
