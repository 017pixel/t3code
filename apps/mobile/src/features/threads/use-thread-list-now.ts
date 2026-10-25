import { useState } from "react";

import { useDeadlinePassed, useNowMinute } from "../../lib/clock";
import { nextSnoozeWakeAfter } from "./threadListV2";

/**
 * The thread list's clock as an ISO timestamp. It advances on each wall-clock
 * minute and the moment any snooze expires, so the list re-partitions on time
 * instead of on the next minute tick. Waking on every snoozed thread, not just
 * the ones the list shows as snoozed, only costs an extra render.
 */
export function useThreadListNow(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>,
): string {
  const minute = useNowMinute();
  const [clock, setClock] = useState(() => ({
    minute,
    wakeMs: null as number | null,
    nowMs: Date.now(),
  }));
  const wakeMs = nextSnoozeWakeAfter(threads, clock.nowMs);
  const wakePassed = useDeadlinePassed(wakeMs);
  if (clock.minute !== minute || (wakePassed && clock.wakeMs !== wakeMs)) {
    const next = { minute, wakeMs, nowMs: Date.now() };
    setClock(next);
    return new Date(next.nowMs).toISOString();
  }
  return new Date(clock.nowMs).toISOString();
}
