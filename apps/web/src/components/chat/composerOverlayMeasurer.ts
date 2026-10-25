import { observeResize } from "~/lib/observeResize";

import { resolveComposerTimelineInset, resolveScrollToEndClearance } from "../composerFooterLayout";

interface ComposerOverlayPublishers {
  readonly setOverlayElement: (element: HTMLDivElement | null) => void;
  readonly setTimelineInset: (inset: number) => void;
  readonly setReservedHeight: (height: number) => void;
  readonly setScrollToEndClearance: (clearance: number) => void;
}

interface ComposerOverlayMeasurer {
  /** Ref callback for the overlay element. Identity is stable for the measurer's lifetime. */
  readonly attach: (overlay: HTMLDivElement) => () => void;
  /** Publishes a height the composer measured itself, such as a transition's destination. */
  readonly publishHeight: (height: number) => void;
  /** Re-measures the overlay as it is now laid out. */
  readonly remeasure: () => void;
  /**
   * Starts a new measurement series (thread switch, composer mounted): the
   * held heights start over from zero and the overlay is re-measured.
   */
  readonly startSeries: () => void;
  /**
   * Ends the series while the composer is still in the DOM. The held heights
   * reset without measuring, and the overlay observer re-measures once the
   * composer has left the layout.
   */
  readonly endSeries: () => void;
  /** Starts a new series when the thread differs from the last one measured. */
  readonly showThread: (threadKey: string | null) => void;
}

/**
 * Owns the overlay's held heights and publishes the timeline inset, the
 * reserved composer height, and the scroll-to-end clearance from the
 * committed DOM, so a resize callback between renders sees the layout it measures.
 */
export function createComposerOverlayMeasurer(
  publishers: ComposerOverlayPublishers,
): ComposerOverlayMeasurer {
  const held = { inset: 0, reserved: 0, expanded: 0 };
  let current: HTMLDivElement | null = null;
  let threadKey: string | null = null;

  const publish = (overlay: HTMLElement, height: number) => {
    const nextHeight = Math.ceil(height);
    if (nextHeight <= 0) return;
    const isResting = overlay.querySelector('[data-composer-resting="true"]') !== null;
    const modelStrip = overlay.querySelector<HTMLElement>('[data-composer-model-strip="true"]');
    const restingOnlyHeight =
      modelStrip && isResting
        ? Math.max(
            0,
            modelStrip.offsetHeight + Number.parseFloat(getComputedStyle(modelStrip).marginTop),
          )
        : 0;
    const noticeStack = overlay.querySelector<HTMLElement>('[data-composer-banner-stack="true"]');
    const expandedNoticesHeight = noticeStack
      ? Math.max(
          0,
          noticeStack.getBoundingClientRect().height -
            Number.parseFloat(getComputedStyle(noticeStack).minHeight),
        )
      : 0;
    const nextInset = resolveComposerTimelineInset({
      currentInset: held.inset,
      overlayHeight: height,
      isResting,
      restingOnlyHeight,
      expandedNoticesHeight,
    });
    if (held.inset !== nextInset) {
      held.inset = nextInset;
      publishers.setTimelineInset(nextInset);
    }
    // The terminal drawer and placeholder lay out against the expanded composer.
    // Remembering it while the mobile strip is collapsed keeps the drawer still as
    // focus moves; a collapsed strip can still grow, so the reservation follows it
    // up. A hero composer's overlay fills the pane, so only its stack counts.
    const stack = overlay.querySelector<HTMLElement>('[data-chat-composer-stack="true"]');
    const isDraftHero = overlay.dataset.draftHero === "true";
    const expandedComposerHeight =
      isDraftHero && stack ? Math.ceil(stack.getBoundingClientRect().height) : nextInset;
    const mobileCollapsed = Boolean(
      stack?.querySelector('[data-chat-composer-mobile-collapsed="true"]'),
    );
    if (!mobileCollapsed) held.expanded = expandedComposerHeight;
    const reservedHeight = Math.max(held.expanded, expandedComposerHeight);
    if (held.reserved !== reservedHeight) {
      held.reserved = reservedHeight;
      publishers.setReservedHeight(reservedHeight);
    }
    const mainSurface = overlay.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    const button = overlay.parentElement?.querySelector<HTMLElement>(
      'button[aria-label="Scroll to end"]',
    );
    const clearance =
      mainSurface && button
        ? resolveScrollToEndClearance({
            overlayHeight: nextHeight,
            mainSurfaceTop: mainSurface.getBoundingClientRect().top,
            button: button.getBoundingClientRect(),
            attachments: Array.from(
              overlay.querySelectorAll<HTMLElement>('[data-composer-banner-surface="attached"]'),
              (element) => element.getBoundingClientRect(),
            ),
          })
        : nextHeight;
    publishers.setScrollToEndClearance(clearance);
  };

  const measure = (overlay: HTMLElement) =>
    publish(overlay, overlay.getBoundingClientRect().height);
  const resetHeld = () => {
    held.inset = 0;
    held.reserved = 0;
    held.expanded = 0;
  };
  const startSeries = () => {
    resetHeld();
    if (current) measure(current);
  };

  return {
    attach: (overlay) => {
      current = overlay;
      publishers.setOverlayElement(overlay);
      measure(overlay);
      // The hero overlay fills the pane, so the composer's own growth only
      // shows on its stack. The stack always renders, so observing it in
      // every layout keeps the observation independent of the hero state.
      // Entering or leaving the hero layout resizes the overlay itself.
      const stack = overlay.querySelector('[data-chat-composer-stack="true"]');
      const stopObserving = observeResize(stack ? [overlay, stack] : overlay, () =>
        measure(overlay),
      );
      return () => {
        stopObserving();
        if (current === overlay) {
          current = null;
          publishers.setOverlayElement(null);
        }
      };
    },
    publishHeight: (height) => {
      if (current) publish(current, height);
    },
    remeasure: () => {
      if (current) measure(current);
    },
    startSeries,
    endSeries: resetHeld,
    showThread: (nextThreadKey) => {
      if (nextThreadKey === threadKey) return;
      threadKey = nextThreadKey;
      startSeries();
    },
  };
}
