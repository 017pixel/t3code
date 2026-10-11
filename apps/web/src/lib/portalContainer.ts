import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";

/**
 * Where popups portal to; undefined means document.body. A subtree that React
 * hides in <Activity> (a kept thread view, the thread sidebar on settings)
 * supplies a container that hides with it, since React 19.2 hides a hidden
 * subtree's own DOM but not what it portaled elsewhere.
 */
export const PortalContainerContext = createContext<HTMLElement | undefined>(undefined);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext);
}

/**
 * A popup container of its own in body, hidden while `hidden` is set or the
 * caller's effects are torn down. With a `lifetime` (a kept view) it is
 * removed when the view is released, since hiding the view tears its effects
 * down too; otherwise when the caller unmounts, so that caller sits outside
 * the <Activity> it serves.
 */
export function useOwnPortalContainer(
  hidden: boolean,
  lifetime: { hold(release: () => void): unknown } | null,
): HTMLElement {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.hidden = true;
    return element;
  });
  useLayoutEffect(() => {
    if (!container.isConnected) {
      document.body.append(container);
      lifetime?.hold(() => container.remove());
    }
    container.toggleAttribute("hidden", hidden);
    // Hiding a kept view runs this cleanup too; its popups stay mounted but out of sight.
    return () => {
      container.toggleAttribute("hidden", true);
    };
  }, [container, hidden, lifetime]);
  useEffect(() => {
    if (lifetime !== null) return;
    return () => container.remove();
  }, [container, lifetime]);
  return container;
}
