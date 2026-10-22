import { useEffect, useState } from "react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

interface SelectedRowSpan {
  readonly listKey: string;
  readonly anchorRowId: string;
  readonly focusRowId: string;
}

function timelineRowId(viewport: HTMLElement, node: Node | null) {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  const row = element?.closest<HTMLElement>("[data-timeline-row-id]");
  return row && viewport.contains(row) ? (row.dataset.timelineRowId ?? null) : null;
}

/**
 * Row keys spanned by a native text selection inside the timeline. The list
 * recycles rows that scroll out of its buffer, which replaces the text node a
 * selection endpoint lives in and collapses the selection mid-drag; pinning
 * the span keeps every selected row mounted until the selection goes away.
 */
export function useTimelineSelectionRowKeys(
  viewport: HTMLElement | null,
  rows: ReadonlyArray<MessagesTimelineRow>,
  listKey: string,
): string[] {
  const [span, setSpan] = useState<SelectedRowSpan | null>(null);

  useEffect(() => {
    if (!viewport) return;
    const update = () => {
      const selection = window.getSelection();
      const active = selection !== null && !selection.isCollapsed;
      const anchorRowId = active ? timelineRowId(viewport, selection.anchorNode) : null;
      const selectedFocusRowId = active ? timelineRowId(viewport, selection.focusNode) : null;
      setSpan((current) => {
        if (anchorRowId === null) return null;
        // A drag past the list edge puts the focus outside it; keep the last row it reached.
        const focusRowId =
          selectedFocusRowId ??
          (current?.anchorRowId === anchorRowId ? current.focusRowId : anchorRowId);
        return current?.listKey === listKey &&
          current.anchorRowId === anchorRowId &&
          current.focusRowId === focusRowId
          ? current
          : { listKey, anchorRowId, focusRowId };
      });
    };
    update();
    document.addEventListener("selectionchange", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      setSpan(null);
    };
  }, [listKey, viewport]);

  if (span === null || span.listKey !== listKey) return [];
  const anchorIndex = rows.findIndex((row) => row.id === span.anchorRowId);
  if (anchorIndex < 0) return [];
  const focusIndex = rows.findIndex((row) => row.id === span.focusRowId);
  const end = focusIndex < 0 ? anchorIndex : focusIndex;
  return rows
    .slice(Math.min(anchorIndex, end), Math.max(anchorIndex, end) + 1)
    .map((row) => row.id);
}
