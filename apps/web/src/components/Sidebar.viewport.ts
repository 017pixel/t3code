import { useEffect, useState } from "react";

const observers = new Map<
  Element | null,
  {
    observer: IntersectionObserver;
    listeners: Map<Element, (visible: boolean) => void>;
  }
>();

/** Share viewport observation across row slots; expensive content mounts only nearby. */
export function useSidebarRowViewport(node: HTMLElement | null, initiallyVisible: boolean) {
  const [visible, setVisible] = useState(
    initiallyVisible || typeof IntersectionObserver === "undefined",
  );
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
          for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
        },
        { root, rootMargin: "240px 0px" },
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
