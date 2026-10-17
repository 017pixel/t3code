import { useLayoutEffect, type ComponentProps } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput } from "../../session-logic";
import { useThreadVisibleTurnItems } from "../../state/entities";
import { rememberReadyThreadTimeline, timelineHasEphemeralPreviewUrls } from "../ChatView.logic";
import { MessagesTimeline } from "./MessagesTimeline";

const NO_OPTIMISTIC_MESSAGES: TimelineEntriesInput["optimisticMessages"] = [];

export interface LiveTimelineSource extends Omit<TimelineEntriesInput, "visibleTurnItems"> {
  readonly threadRef: ScopedThreadRef | null;
  readonly threadKey: string | null;
  /** While the thread is loading, its timeline is not remembered for thread switches. */
  readonly loading: boolean;
}

/**
 * The one place that follows streamed text. ChatView reads the quiet
 * projection, so a chunk re-renders this host and the timeline, not the chat
 * chrome. `live` is null while a remembered or held timeline is painted.
 */
export function LiveMessagesTimeline({
  live,
  ...props
}: ComponentProps<typeof MessagesTimeline> & { readonly live: LiveTimelineSource | null }) {
  const visibleTurnItems = useThreadVisibleTurnItems(live?.threadRef ?? null);
  const liveEntries = useIncrementalTimelineEntries(live?.threadKey ?? null, {
    visibleTurnItems,
    optimisticMessages: live?.optimisticMessages ?? NO_OPTIMISTIC_MESSAGES,
    ...(live?.anchoredMessages === undefined ? {} : { anchoredMessages: live.anchoredMessages }),
    ...(live?.attachmentUrlById === undefined ? {} : { attachmentUrlById: live.attachmentUrlById }),
    ...(live?.attempts === undefined ? {} : { attempts: live.attempts }),
    ...(live?.nodes === undefined ? {} : { nodes: live.nodes }),
    ...(live?.plans === undefined ? {} : { plans: live.plans }),
  });
  const threadKey = live?.threadKey ?? null;
  const loading = live?.loading ?? true;
  const { markdownCwd, workspaceRoot } = props;
  useLayoutEffect(() => {
    if (loading || liveEntries.length === 0 || timelineHasEphemeralPreviewUrls(liveEntries)) {
      return;
    }
    rememberReadyThreadTimeline({
      threadKey,
      entries: liveEntries,
      markdownCwd: markdownCwd ?? null,
      workspaceRoot: workspaceRoot ?? null,
    });
  }, [liveEntries, loading, markdownCwd, threadKey, workspaceRoot]);
  return (
    <MessagesTimeline
      {...props}
      timelineEntries={live === null ? props.timelineEntries : liveEntries}
    />
  );
}
