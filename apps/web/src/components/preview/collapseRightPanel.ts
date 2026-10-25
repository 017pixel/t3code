import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

export const RIGHT_PANEL_SHELL_ATTRIBUTE = "data-right-panel-shell";
export const RIGHT_PANEL_TOGGLE_SELECTOR = "[data-right-panel-toggle]";

/**
 * Every action that collapses the inline right panel goes through here, so focus
 * leaves the panel for its toggle before the panel turns inert.
 */
export function collapseRightPanel(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().collapse(threadRef, {
    panel: document.querySelector(`[${RIGHT_PANEL_SHELL_ATTRIBUTE}]`),
    returnFocusTo: document.querySelector<HTMLElement>(RIGHT_PANEL_TOGGLE_SELECTOR),
  });
}

/** Collapses first when closing `surfaceIds` leaves the open panel with no surfaces. */
export function collapseRightPanelIfEmptied(
  threadRef: ScopedThreadRef,
  surfaceIds: ReadonlySet<string>,
): void {
  const { isOpen, surfaces } = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  if (isOpen && surfaces.every((surface) => surfaceIds.has(surface.id))) {
    collapseRightPanel(threadRef);
  }
}
