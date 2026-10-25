import { useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState } from "react-native";

type Listener = () => void;

/**
 * Subscribes to AppState status changes. Returns the unsubscribe function, so
 * it plugs straight into useSyncExternalStore and atom finalizers.
 */
export function subscribeAppState(onChange: Listener): () => void {
  const subscription = AppState.addEventListener("change", () => onChange());
  return () => subscription.remove();
}

export function isAppActive(): boolean {
  return AppState.currentState === "active";
}

/** Runs `onActive` each time the app returns to the foreground. */
export function subscribeAppActive(onActive: Listener): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") onActive();
  });
  return () => subscription.remove();
}

export function useAppActive(): boolean {
  return useSyncExternalStore(subscribeAppState, isAppActive);
}

function isAppForeground(): boolean {
  return AppState.currentState !== "background";
}

/**
 * True unless the app is backgrounded. Unlike useAppActive, the transient
 * "inactive" state (Control Center, the app switcher, a system prompt) still
 * counts as foreground, so live streams do not reconnect around it.
 */
export function useAppForeground(): boolean {
  return useSyncExternalStore(subscribeAppState, isAppForeground);
}

/**
 * Reads a synchronous native value whenever the app returns to the
 * foreground, where system settings (clock format, palettes) may have changed.
 * `getSnapshot` must return a stable value between changes.
 */
export function useValueOnAppActive<A>(getSnapshot: () => A): A {
  return useSyncExternalStore(subscribeAppActive, getSnapshot);
}

// Null until the native seed resolves; read as reduced so animated consumers
// never start motion a reduce-motion user has turned off.
let reduceMotionEnabled: boolean | null = null;
const reduceMotionListeners = new Set<Listener>();
let reduceMotionSubscription: { remove: () => void } | null = null;

function setReduceMotionEnabled(next: boolean) {
  if (next === reduceMotionEnabled) return;
  reduceMotionEnabled = next;
  for (const listener of reduceMotionListeners) listener();
}

function subscribeReduceMotion(onChange: Listener): () => void {
  reduceMotionListeners.add(onChange);
  if (reduceMotionSubscription === null) {
    reduceMotionSubscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotionEnabled,
    );
    // The native event only reports changes; seed the current value once.
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotionEnabled, () => undefined);
  }
  return () => {
    reduceMotionListeners.delete(onChange);
    if (reduceMotionListeners.size === 0) {
      reduceMotionSubscription?.remove();
      reduceMotionSubscription = null;
    }
  };
}

export function useReduceMotionEnabled(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, () => reduceMotionEnabled ?? true);
}
