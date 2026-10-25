// @effect-diagnostics globalTimers:off globalDate:off - Render clocks for React hooks, outside an Effect runtime.

/**
 * A `useSyncExternalStore`-shaped clock. Snapshots stay cached between
 * notifications while subscribed, as `useSyncExternalStore` requires.
 */
export interface ClockStore<A> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => A;
}

// setTimeout fires immediately for delays beyond a signed 32-bit int.
const MAX_TIMEOUT_MS = 2_147_483_647;

function makeTickStore<A>(read: () => A, periodMs: number): ClockStore<A> {
  let value = read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  // Each tick lands on a wall-clock boundary so every subscriber updates in
  // the same frame instead of each drifting on its own phase.
  const schedule = () => {
    timer = setTimeout(
      () => {
        const next = read();
        if (next !== value) {
          value = next;
          for (const listener of listeners) listener();
        }
        schedule();
      },
      periodMs - (Date.now() % periodMs),
    );
  };

  return {
    subscribe: (listener) => {
      if (listeners.size === 0) {
        value = read();
        schedule();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => {
      if (timer === undefined) value = read();
      return value;
    },
  };
}

/** Epoch ms floored to the second, advancing on each wall-clock second. */
export const secondTick: ClockStore<number> = makeTickStore(
  () => Math.floor(Date.now() / 1000) * 1000,
  1000,
);

/** ISO timestamp truncated to the minute (`YYYY-MM-DDTHH:mm`). */
export const minuteTick: ClockStore<string> = makeTickStore(
  () => new Date().toISOString().slice(0, 16),
  60_000,
);

export interface DeadlineStore extends ClockStore<boolean> {
  /**
   * Re-checks `Date.now()` and notifies if the deadline has passed. For callers
   * that observe the deadline first, e.g. a click after a throttled or slept
   * timer, so the snapshot catches up without waiting for the late timer.
   */
  readonly refresh: () => void;
}

const neverPassed: DeadlineStore = {
  subscribe: () => () => {},
  getSnapshot: () => false,
  refresh: () => {},
};

const deadlines = new Map<number, DeadlineStore>();

/**
 * Whether `Date.now()` has reached `deadlineMs`. One timer per distinct
 * deadline, shared by its subscribers; once passed the snapshot stays true.
 * Stores register only while subscribed, so renders React discards leak nothing.
 * A non-finite deadline never passes.
 */
export function deadlineStore(deadlineMs: number | null): DeadlineStore {
  if (deadlineMs === null || !Number.isFinite(deadlineMs)) return neverPassed;
  const existing = deadlines.get(deadlineMs);
  if (existing !== undefined) return existing;

  let passed = Date.now() >= deadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const pass = () => {
    clearTimeout(timer);
    timer = undefined;
    passed = true;
    for (const listener of listeners) listener();
  };

  const arm = () => {
    const delay = deadlineMs - Date.now();
    if (delay <= 0) {
      pass();
      return;
    }
    timer = setTimeout(arm, Math.min(delay, MAX_TIMEOUT_MS));
  };

  const store: DeadlineStore = {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        if (!deadlines.has(deadlineMs)) deadlines.set(deadlineMs, store);
        if (!passed) arm();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearTimeout(timer);
          timer = undefined;
          if (deadlines.get(deadlineMs) === store) deadlines.delete(deadlineMs);
        }
      };
    },
    getSnapshot: () => {
      if (!passed && timer === undefined) passed = Date.now() >= deadlineMs;
      return passed;
    },
    refresh: () => {
      if (!passed && Date.now() >= deadlineMs) pass();
    },
  };
  return store;
}
