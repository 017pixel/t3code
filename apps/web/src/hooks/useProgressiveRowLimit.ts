import { startTransition, useEffect, useState } from "react";

/**
 * How many rows of a long list to render. The first paint gets `initial`
 * rows and the rest follow in small transitions between paints. A single
 * transition for the whole remainder still commits hundreds of controls at once.
 */
export function useProgressiveRowLimit(initial: number, total: number): number {
  const [limit, setLimit] = useState(initial);
  useEffect(() => {
    if (limit >= total) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        startTransition(() => setLimit((current) => Math.min(total, current + initial))),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [initial, limit, total]);
  return limit;
}
