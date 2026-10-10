import { useSyncExternalStore, type ComponentType } from "react";

let surface: ComponentType | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The chat layout registers its thread surface here the first time it
 * renders. The root layout keeps rendering it from then on, so leaving the
 * chat for a full page hides the thread view instead of unmounting it, while
 * routes that never open a thread do not load the chat code.
 */
export function registerChatSurface(component: ComponentType) {
  if (surface === component) return;
  surface = component;
  for (const listener of listeners) listener();
}

export function ChatSurfaceSlot() {
  const Surface = useSyncExternalStore(subscribe, () => surface);
  return Surface ? <Surface /> : null;
}
