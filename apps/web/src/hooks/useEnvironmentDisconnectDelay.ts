import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useDeadlinePassed } from "./useDeadline";

const DISCONNECT_DELAY_MS = 20_000;

export function useEnvironmentDisconnectDelay(unavailableEnvironmentId: EnvironmentId | null) {
  return useEnvironmentStateHeldFor(unavailableEnvironmentId, DISCONNECT_DELAY_MS);
}

/**
 * Whether `environmentId` has stayed the same non-null value for `delayMs`. Every change starts a
 * new delay, so leaving and returning to an id restarts it.
 */
export function useEnvironmentStateHeldFor(environmentId: EnvironmentId | null, delayMs: number) {
  const [held, setHeld] = useState(() => ({
    environmentId,
    since: Date.now(),
  }));
  if (held.environmentId !== environmentId) {
    setHeld({ environmentId, since: Date.now() });
  }
  const elapsed = useDeadlinePassed(held.environmentId === null ? null : held.since + delayMs);
  return environmentId !== null && held.environmentId === environmentId && elapsed;
}
