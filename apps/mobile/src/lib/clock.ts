import { deadlineStore, minuteTick, secondTick } from "@t3tools/client-runtime/clock";
import { useState, useSyncExternalStore } from "react";

/** Re-renders once when `deadlineMs` (epoch ms) is reached; `null` never passes. */
export function useDeadlinePassed(deadlineMs: number | null): boolean {
  const store = deadlineStore(deadlineMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * `Date.now()` captured at mount and re-read when `deadlineMs` changes or
 * passes, so comparisons against the deadline flip exactly once.
 */
export function useNowAfter(deadlineMs: number | null): number {
  const passed = useDeadlinePassed(deadlineMs);
  const [snapshot, setSnapshot] = useState(() => ({ deadlineMs, passed, nowMs: Date.now() }));
  if (snapshot.deadlineMs !== deadlineMs || snapshot.passed !== passed) {
    const next = { deadlineMs, passed, nowMs: Date.now() };
    setSnapshot(next);
    return next.nowMs;
  }
  return snapshot.nowMs;
}

/** Epoch ms floored to the second, advancing each wall-clock second. */
export function useNowSecond(): number {
  return useSyncExternalStore(secondTick.subscribe, secondTick.getSnapshot, secondTick.getSnapshot);
}

/** ISO timestamp truncated to the minute, advancing each wall-clock minute. */
export function useNowMinute(): string {
  return useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot);
}
