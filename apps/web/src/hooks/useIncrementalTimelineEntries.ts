import { useState } from "react";
import { timelineHasEphemeralPreviewUrls } from "../components/ChatView.logic";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
  type TimelineEntry,
} from "../session-logic";

function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  return (
    left.visibleTurnItems === right.visibleTurnItems &&
    left.optimisticMessages === right.optimisticMessages &&
    left.anchoredMessages === right.anchoredMessages &&
    left.attachmentUrlById === right.attachmentUrlById &&
    left.attempts === right.attempts &&
    left.nodes === right.nodes &&
    left.plans === right.plans
  );
}

/**
 * Remounting LegendList (or handing it an empty first paint) punches a hole
 * through the chat pane — white in light mode — so cmd+1/2/3 spam flashes even
 * when the destination is already cached. The last ready timeline per thread
 * is kept so a switch back paints it while the detail resyncs.
 */
export type ReadyThreadTimeline = {
  threadKey: string;
  entries: TimelineEntry[];
  markdownCwd: string | null;
  workspaceRoot: string | null;
};

/** Paths the remembered rows render against; null while the detail is loading. */
export type ReadyTimelineContext = {
  markdownCwd: string | null;
  workspaceRoot: string | null;
};

const MAX_READY_THREAD_TIMELINES = 16;

// Map insertion order is the LRU order: the last key is the most recent.
const readyThreadTimelines = new Map<string, ReadyThreadTimeline>();
let lastReadyThreadKey: string | null = null;

export function rememberReadyThreadTimeline(
  threadKey: string,
  entries: TimelineEntry[],
  context: ReadyTimelineContext,
): void {
  const current = readyThreadTimelines.get(threadKey);
  if (
    current !== undefined &&
    current.entries === entries &&
    current.markdownCwd === context.markdownCwd &&
    current.workspaceRoot === context.workspaceRoot &&
    lastReadyThreadKey === threadKey
  ) {
    return;
  }
  // Handoff blob preview URLs are short-lived; a remembered copy could outlive them.
  if (entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
    return;
  }
  readyThreadTimelines.delete(threadKey);
  readyThreadTimelines.set(threadKey, { threadKey, entries, ...context });
  lastReadyThreadKey = threadKey;
  while (readyThreadTimelines.size > MAX_READY_THREAD_TIMELINES) {
    const oldest = readyThreadTimelines.keys().next().value;
    if (oldest === undefined) break;
    readyThreadTimelines.delete(oldest);
  }
}

export function peekReadyThreadTimeline(threadKey: string | null): TimelineEntry[] | null {
  return threadKey === null ? null : (readyThreadTimelines.get(threadKey)?.entries ?? null);
}

/** The most recently ready timeline across threads. */
export function peekLastReadyThreadTimeline(): ReadyThreadTimeline | null {
  return lastReadyThreadKey === null
    ? null
    : (readyThreadTimelines.get(lastReadyThreadKey) ?? null);
}

export function resetReadyThreadTimelines(): void {
  readyThreadTimelines.clear();
  lastReadyThreadKey = null;
}

/**
 * Timeline entries for a thread, derived from the previous projection so
 * unchanged rows keep their identity and memoized rows skip rendering. A new
 * thread starts from scratch. With a `ready` context, the produced entries are
 * also remembered for painting a later switch back to this thread.
 */
export function useIncrementalTimelineEntries(
  threadKey: string | null,
  input: TimelineEntriesInput,
  ready: ReadyTimelineContext | null = null,
): TimelineEntriesProjection["entries"] {
  const [state, setState] = useState(() => ({
    threadKey,
    projection: deriveTimelineEntriesFromVisibleTurnItemsWithState(input),
  }));
  let entries = state.projection.entries;
  if (state.threadKey !== threadKey || !sameInput(state.projection.input, input)) {
    const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      input,
      state.threadKey === threadKey ? state.projection : null,
    );
    setState({ threadKey, projection });
    entries = projection.entries;
  }
  if (threadKey !== null && ready !== null) {
    rememberReadyThreadTimeline(threadKey, entries, ready);
  }
  return entries;
}
