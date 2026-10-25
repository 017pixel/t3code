import { idleCompactionOf, type RunId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import type { ThreadCheckpointSummary } from "./threadCheckpoints.ts";

/**
 * A response group is one prompt plus every background wake after it, folded
 * behind one row. Any prompt starts one, even an agent's; a steer does once its
 * run has output. Wakes are notifications and idle `/compact` is housekeeping,
 * so both join the current group.
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
 * Per-run stats are deltas, so the sum counts lines touched, not the net diff.
 * `rangeFromTurnCount` makes "Open diff" span the group. The server diffs only
 * to a completed run's checkpoint, so the range ends at the last finished run.
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
