import type { Wakeups } from "@t3tools/client-runtime/connection";

export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-reconnect"
>;

/**
 * The wakeup for returning to the foreground. Without a background visit the
 * app only went inactive, such as for Control Center or Face ID, and its
 * socket was never suspended, so there is nothing to check.
 */
export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup | null {
  if (backgroundedAtMs === null) return null;
  return activeAtMs - backgroundedAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}
