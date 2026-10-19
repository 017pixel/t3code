import type { Wakeups } from "@t3tools/client-runtime/connection";

export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-reconnect" | "application-refocused"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup {
  if (backgroundedAtMs === null) return "application-refocused";
  return activeAtMs - backgroundedAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}
