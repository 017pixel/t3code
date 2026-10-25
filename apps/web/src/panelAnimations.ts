import { createContext, useContext, useEffect, useState } from "react";
import { type PanelAnimationDurationMs } from "@t3tools/contracts/settings";

import { useDeadlinePassed } from "./hooks/useDeadline";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useClientSettings } from "./hooks/useSettings";

const PanelAnimationSuppressionContext = createContext(false);

export const PanelAnimationSuppressionProvider = PanelAnimationSuppressionContext.Provider;

export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<string | null>(null);
  const suppressed = paintedNavigationKey !== navigationKey;

  useEffect(() => {
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => setPaintedNavigationKey(navigationKey));
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

export function usePanelAnimationSettings(): {
  active: boolean;
  durationMs: PanelAnimationDurationMs;
} {
  const durationMs = useClientSettings((settings) => settings.panelAnimationDurationMs);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const suppressed = useContext(PanelAnimationSuppressionContext);
  return { active: durationMs > 0 && !prefersReducedMotion && !suppressed, durationMs };
}

export function usePanelPresence<T>(
  open: boolean,
  value: T | null,
  animated: boolean,
  scopeKey: string | null,
  durationMs: PanelAnimationDurationMs,
): { present: boolean; value: T | null } {
  const [retained, setRetained] = useState<{ scopeKey: string | null; value: T | null } | null>(
    open ? { scopeKey, value } : null,
  );
  if (open && (retained?.scopeKey !== scopeKey || retained.value !== value)) {
    setRetained({ scopeKey, value });
  }

  // A closed panel stays present until its exit animation has had time to run.
  const [exit, setExit] = useState<{ open: boolean; deadlineMs: number | null }>({
    open,
    deadlineMs: null,
  });
  if (exit.open !== open) {
    setExit({ open, deadlineMs: open || !animated ? null : Date.now() + durationMs });
  } else if (!animated && exit.deadlineMs !== null) {
    setExit({ open, deadlineMs: null });
  }
  const exitDone = useDeadlinePassed(exit.deadlineMs);
  const present = open || (animated && exit.deadlineMs !== null && !exitDone);

  const retainedValue = retained?.scopeKey === scopeKey ? retained.value : null;
  const visible = open || (animated && present && retained?.scopeKey === scopeKey);
  return { present: visible, value: open ? value : visible ? retainedValue : null };
}
