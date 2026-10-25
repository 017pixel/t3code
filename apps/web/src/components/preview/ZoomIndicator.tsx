import { useState } from "react";

import { useDeadlinePassed } from "~/hooks/useDeadline";
import { cn } from "~/lib/utils";

const HIDE_AFTER_MS = 1500;
const ZOOM_EPSILON = 0.001;

interface Props {
  zoomFactor: number;
}

export function ZoomIndicator({ zoomFactor }: Props) {
  // The first factor is not a change, so it never shows the indicator.
  const [shown, setShown] = useState<{ factor: number; atMs: number | null }>({
    factor: zoomFactor,
    atMs: null,
  });
  let shownAtMs = shown.atMs;
  if (Math.abs(shown.factor - zoomFactor) >= ZOOM_EPSILON) {
    const next = { factor: zoomFactor, atMs: Date.now() };
    setShown(next);
    shownAtMs = next.atMs;
  }
  const hidden = useDeadlinePassed(shownAtMs === null ? null : shownAtMs + HIDE_AFTER_MS);
  const visible = shownAtMs !== null && !hidden;

  const percent = `${Math.round(zoomFactor * 100)}%`;

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none absolute top-3 right-3 z-20 select-none rounded-full border border-border/70 bg-popover/95 px-2.5 py-1 text-xs font-medium text-foreground shadow-md/10 backdrop-blur transition-all duration-200 ease-out",
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1",
      )}
    >
      {percent}
    </div>
  );
}
