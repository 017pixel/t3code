import { createContext, useContext } from "react";

/**
 * Where popups portal to; undefined means document.body. A kept thread view
 * supplies a container that hides with the view (see KeptViewFrame), since
 * React 19.2 hides a hidden view's own DOM but not what it portaled elsewhere.
 */
export const PortalContainerContext = createContext<HTMLElement | undefined>(undefined);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext);
}
