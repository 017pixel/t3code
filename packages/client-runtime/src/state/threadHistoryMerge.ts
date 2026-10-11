import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import { isOrchestrationV2TurnItemVisible } from "@t3tools/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** True after at least one older page was merged; skip monolithic cache growth. */
  readonly expanded: boolean;
  /**
   * Max local turn ordinal known for partial progressive windows. Null when
   * unknown (legacy cache) or when history meta is cleared for a full snapshot.
   */
  readonly latestLocalTurnOrdinal: number | null;
};

export const EMPTY_THREAD_HISTORY_META: ThreadHistoryMeta = {
  historyCursor: null,
  hasMoreHistory: false,
  loading: false,
  error: null,
  expanded: false,
  latestLocalTurnOrdinal: null,
};

/** Whether a history-page response still matches the cursor that started it. */
export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

/**
 * Clear history loading after an interrupted load-earlier only when the
 * request cursor is still active. Does not touch stream/status/error.
 */
export function clearActiveHistoryLoading(
  requestCursor: string,
  history: ThreadHistoryMeta,
): ThreadHistoryMeta {
  if (!isActiveHistoryRequestCursor(requestCursor, history) || !history.loading) {
    return history;
  }
  return { ...history, loading: false };
}

function projectedItemKey(row: OrchestrationV2ProjectedTurnItem): string {
  return `${row.sourceThreadId}:${row.sourceItemId}`;
}

function renumberVisible(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

/**
 * Merge an older history page into the live projection. Dedupes by
 * sourceThreadId + sourceItemId, keeps chronological order (older first), and
 * preserves newer live rows already present in state.
 */
export function mergeOlderHistoryIntoProjection(
  projection: OrchestrationV2ThreadProjection,
  olderItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  support?: OrchestrationV2ThreadHistoryPage["support"],
): OrchestrationV2ThreadProjection {
  const withSupport = support === undefined ? projection : mergeHistorySupport(projection, support);
  if (olderItems.length === 0) return withSupport;

  const currentByKey = new Map(
    projection.visibleTurnItems.map((row) => [projectedItemKey(row), row]),
  );
  const turnItemById = new Map(projection.turnItems.map((item) => [String(item.id), item]));
  const pageKeys = new Set<string>();
  const page: OrchestrationV2ProjectedTurnItem[] = [];
  for (const pageRow of olderItems) {
    const key = projectedItemKey(pageRow);
    if (pageKeys.has(key)) continue;
    let row = currentByKey.get(key) ?? pageRow;
    if (
      !currentByKey.has(key) &&
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id)
    ) {
      const currentItem = turnItemById.get(String(row.sourceItemId));
      // Hidden live items stay hidden. Cold snapshots also retain interrupt
      // requests outside the visible window; paging may reveal those requests.
      if (currentItem !== undefined) {
        if (
          currentItem.type !== "run_interrupt_request" ||
          !isOrchestrationV2TurnItemVisible({
            item: currentItem,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          })
        )
          continue;
        row = { ...row, item: currentItem };
      }
    }
    pageKeys.add(key);
    page.push(row);
    if (
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id) &&
      !turnItemById.has(String(row.sourceItemId))
    )
      turnItemById.set(String(row.sourceItemId), row.item);
  }
  if (page.length === 0) return withSupport;
  // Server page order fills gaps between rows from a partial conversation load.
  // Existing rows supply live values; rows outside this range keep their order.
  const visible = [
    ...page,
    ...projection.visibleTurnItems.filter((row) => !pageKeys.has(projectedItemKey(row))),
  ];
  if (
    visible.length === projection.visibleTurnItems.length &&
    visible.every((row, index) => row === projection.visibleTurnItems[index])
  )
    return withSupport;
  return {
    ...withSupport,
    turnItems: [...turnItemById.values()],
    visibleTurnItems: renumberVisible(visible),
  };
}

const ACTIVE_NODE_STATUSES = new Set(["pending", "running", "waiting"]);
const ACTIVE_ATTEMPT_STATUSES = new Set(["pending", "running"]);

/**
 * Support also carries active entities, so a page read ahead of the live
 * stream can hold ones the stream has not applied yet. Those are newer than
 * anything held and go last, keeping newest-last order; the rest is history.
 */
function mergeHistorySupport(
  projection: OrchestrationV2ThreadProjection,
  support: NonNullable<OrchestrationV2ThreadHistoryPage["support"]>,
): OrchestrationV2ThreadProjection {
  const latestRunOrdinal = projection.runs.reduce((max, run) => Math.max(max, run.ordinal), 0);
  const newRunIds = new Set(
    support.runs.filter((run) => run.ordinal > latestRunOrdinal).map((run) => run.id),
  );
  // A steer restart, retry or recovery adds an attempt to a run already held.
  const latestAttemptOrdinal = new Map<string, number>();
  for (const attempt of projection.attempts) {
    const held = latestAttemptOrdinal.get(attempt.runId) ?? 0;
    if (attempt.attemptOrdinal > held)
      latestAttemptOrdinal.set(attempt.runId, attempt.attemptOrdinal);
  }
  const latestCapture = projection.checkpoints.reduce(
    (max, checkpoint) => Math.max(max, DateTime.toEpochMillis(checkpoint.capturedAt)),
    Number.NEGATIVE_INFINITY,
  );
  return {
    ...projection,
    nodes: mergeHistoryEntities(
      projection.nodes,
      support.nodes,
      (node) =>
        ACTIVE_NODE_STATUSES.has(node.status) || (node.runId !== null && newRunIds.has(node.runId)),
    ),
    checkpoints: mergeHistoryEntities(
      fillDeferredCheckpoints(projection.checkpoints, support.checkpoints),
      support.checkpoints,
      (checkpoint) => DateTime.toEpochMillis(checkpoint.capturedAt) > latestCapture,
    ),
    runs: mergeHistoryEntities(projection.runs, support.runs, (run) => newRunIds.has(run.id)),
    attempts: mergeHistoryEntities(
      projection.attempts,
      support.attempts,
      (attempt) =>
        newRunIds.has(attempt.runId) ||
        ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.attemptOrdinal > (latestAttemptOrdinal.get(attempt.runId) ?? Infinity),
    ),
  };
}

/** A viewport snapshot lists recent checkpoints without files; their page fills them in. */
function fillDeferredCheckpoints(
  current: OrchestrationV2ThreadProjection["checkpoints"],
  older: OrchestrationV2ThreadProjection["checkpoints"],
): OrchestrationV2ThreadProjection["checkpoints"] {
  if (!current.some((checkpoint) => checkpoint.deferredFileCount !== undefined)) return current;
  const olderById = new Map(older.map((checkpoint) => [checkpoint.id, checkpoint]));
  let filled = false;
  const next = current.map((checkpoint) => {
    const candidate = olderById.get(checkpoint.id);
    if (
      checkpoint.deferredFileCount === undefined ||
      candidate === undefined ||
      candidate.deferredFileCount !== undefined
    )
      return checkpoint;
    filled = true;
    return candidate;
  });
  return filled ? next : current;
}

/** Historical pages fill missing entities without replacing newer live values. */
function mergeHistoryEntities<T extends { readonly id: string }>(
  current: ReadonlyArray<T>,
  older: ReadonlyArray<T>,
  isNewer: (value: T) => boolean,
): ReadonlyArray<T> {
  const ids = new Set(current.map((value) => value.id));
  const missing = older.filter((value) => !ids.has(value.id));
  if (missing.length === 0) return current;
  const newer = missing.filter(isNewer);
  return newer.length === 0
    ? [...missing, ...current]
    : [...missing.filter((value) => !newer.includes(value)), ...current, ...newer];
}

export function applyHistoryPageMeta(
  current: ThreadHistoryMeta,
  page: {
    readonly nextCursor: string | null;
    readonly hasMoreHistory: boolean;
  },
): ThreadHistoryMeta {
  return {
    historyCursor: page.nextCursor,
    hasMoreHistory: page.hasMoreHistory,
    loading: false,
    error: null,
    expanded: true,
    // Preserve the partial-timeline watermark across load-earlier pages.
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
  };
}

/** Whether a client timeline should render its load-earlier control. */
export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}
