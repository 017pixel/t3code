import type {
  OrchestrationV2Checkpoint,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { isOrchestrationV2TurnItemVisible } from "@t3tools/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly expanded: boolean;
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

export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

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

function mergeMissingEntities<T extends { readonly id: unknown }>(
  current: ReadonlyArray<T>,
  older: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const ids = new Set(current.map((entity) => entity.id));
  const missing = older.filter((entity) => {
    if (ids.has(entity.id)) return false;
    ids.add(entity.id);
    return true;
  });
  return missing.length === 0 ? current : [...missing, ...current];
}

function hydrateCheckpointFiles(
  current: OrchestrationV2Checkpoint,
  older: OrchestrationV2Checkpoint | undefined,
): OrchestrationV2Checkpoint {
  const { deferredFileCount, ...checkpoint } = current;
  if (
    deferredFileCount === undefined ||
    older === undefined ||
    older.deferredFileCount !== undefined ||
    older.files.length !== deferredFileCount ||
    current.threadId !== older.threadId ||
    current.scopeId !== older.scopeId ||
    current.runId !== older.runId ||
    current.nodeId !== older.nodeId ||
    current.parentCheckpointId !== older.parentCheckpointId ||
    current.ordinalWithinScope !== older.ordinalWithinScope ||
    current.appRunOrdinal !== older.appRunOrdinal ||
    current.ref !== older.ref ||
    current.status !== older.status ||
    DateTime.toEpochMillis(current.capturedAt) !== DateTime.toEpochMillis(older.capturedAt)
  ) {
    return current;
  }
  return { ...checkpoint, files: older.files };
}

function mergeHistorySupport(
  projection: OrchestrationV2ThreadProjection,
  support: OrchestrationV2ThreadHistoryPage["support"],
): OrchestrationV2ThreadProjection {
  if (support === undefined) return projection;
  const nodes = mergeMissingEntities(projection.nodes, support.nodes);
  const runs = mergeMissingEntities(projection.runs, support.runs);
  const attempts = mergeMissingEntities(projection.attempts, support.attempts);
  const olderCheckpoints = new Map(
    support.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
  );
  const hydrated = projection.checkpoints.map((checkpoint) =>
    hydrateCheckpointFiles(checkpoint, olderCheckpoints.get(checkpoint.id)),
  );
  const checkpoints = mergeMissingEntities(
    hydrated.every((checkpoint, index) => checkpoint === projection.checkpoints[index])
      ? projection.checkpoints
      : hydrated,
    support.checkpoints,
  );
  return nodes === projection.nodes &&
    runs === projection.runs &&
    attempts === projection.attempts &&
    checkpoints === projection.checkpoints
    ? projection
    : { ...projection, nodes, runs, attempts, checkpoints };
}

export function mergeOlderHistoryIntoProjection(
  current: OrchestrationV2ThreadProjection,
  olderItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  support?: OrchestrationV2ThreadHistoryPage["support"],
): OrchestrationV2ThreadProjection {
  const projection = mergeHistorySupport(current, support);
  if (olderItems.length === 0) {
    return projection;
  }

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
  if (page.length === 0) return projection;
  const visible = [
    ...page,
    ...projection.visibleTurnItems.filter((row) => !pageKeys.has(projectedItemKey(row))),
  ];
  // Ordinals are local to the item thread. Keep inherited source order, including
  // fork markers, while inserting activity below a retained prompt in that source.
  const sourceOrder = new Map<string, number>();
  for (const row of visible) {
    if (!sourceOrder.has(row.item.threadId)) sourceOrder.set(row.item.threadId, sourceOrder.size);
  }
  visible.sort(
    (left, right) =>
      sourceOrder.get(left.item.threadId)! - sourceOrder.get(right.item.threadId)! ||
      left.item.ordinal - right.item.ordinal ||
      String(left.item.id).localeCompare(String(right.item.id)),
  );
  if (
    visible.length === projection.visibleTurnItems.length &&
    visible.every((row, index) => row === projection.visibleTurnItems[index])
  )
    return projection;
  return {
    ...projection,
    turnItems: [...turnItemById.values()],
    visibleTurnItems: renumberVisible(visible),
  };
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
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
  };
}

export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}
