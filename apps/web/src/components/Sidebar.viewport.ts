import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Placeholder heights of the two row variants, which the first mount budget also counts. */
export const SIDEBAR_ROW_HEIGHT_REM = { card: 5.125, slim: 2.25 } as const;
const ROW_OBSERVER_MARGIN_PX = 240;

let initialRowBudgetRem: number | null = null;

/**
 * How far down the list the first paint reaches, in rem: the window height
 * plus the observer margin. Rows that start inside it mount with the list, so
 * a tall window never paints them blank for a frame while the observer runs.
 */
export function sidebarInitialRowBudgetRem(): number {
  if (initialRowBudgetRem === null) {
    if (typeof window === "undefined") return 0;
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    initialRowBudgetRem = (window.innerHeight + ROW_OBSERVER_MARGIN_PX) / rootPx;
  }
  return initialRowBudgetRem;
}

const observers = new Map<
  Element | null,
  {
    observer: IntersectionObserver;
    listeners: Map<Element, (visible: boolean) => void>;
  }
>();
// Scroll viewports the observer has reported on, so they have painted rows.
// Until then a list starts at the top and the mount budget is exact.
const paintedRoots = new WeakSet<Element>();

/** Share viewport observation across row slots; expensive content mounts only nearby. */
export function useSidebarRowViewport(node: HTMLElement | null, initiallyVisible: boolean) {
  const [visible, setVisible] = useState(
    initiallyVisible || typeof IntersectionObserver === "undefined",
  );
  const placedRef = useRef(false);
  useLayoutEffect(() => {
    // A slot that joins a painted list (an opened shelf, Show more, a new
    // search result) can land anywhere in a scrolled viewport. It reads its
    // real box once before paint rather than showing blank until the observer
    // reports. Boot keeps the budget, so it never forces a layout.
    if (!node || placedRef.current) return;
    placedRef.current = true;
    const root = node.closest('[data-slot="scroll-area-viewport"]');
    if (visible || !root || !paintedRoots.has(root)) return;
    const bounds = root.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    if (
      bounds.height > 0 &&
      box.bottom > bounds.top - ROW_OBSERVER_MARGIN_PX &&
      box.top < bounds.bottom + ROW_OBSERVER_MARGIN_PX
    ) {
      // oxlint-disable-next-line react/set-state-in-effect -- The slot must render its row before the first paint.
      setVisible(true);
    }
  }, [node, visible]);
  useEffect(() => {
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const root = node.closest('[data-slot="scroll-area-viewport"]');
    let group = observers.get(root);
    if (!group) {
      const listeners = new Map<Element, (visible: boolean) => void>();
      const observer = new IntersectionObserver(
        (entries) => {
          if (root) paintedRoots.add(root);
          for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
        },
        { root, rootMargin: `${ROW_OBSERVER_MARGIN_PX}px 0px` },
      );
      group = { observer, listeners };
      observers.set(root, group);
    }
    group.listeners.set(node, setVisible);
    group.observer.observe(node);
    return () => {
      group.listeners.delete(node);
      group.observer.unobserve(node);
      if (group.listeners.size === 0) {
        group.observer.disconnect();
        observers.delete(root);
      }
    };
  }, [node]);
  return [visible, setVisible] as const;
}
