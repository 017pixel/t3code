import { startTransition, useEffect, useState } from "react";

/**
 * How many rows of a long list to render. The first paint gets `initial`
 * rows and the rest follow in a transition, so opening the page paints at
 * once and rendering the remainder never blocks input.
 */
export function useProgressiveRowLimit(initial: number): number {
  const [limit, setLimit] = useState(initial);
  useEffect(() => {
    if (limit === Number.POSITIVE_INFINITY) return;
    const frame = requestAnimationFrame(() =>
      startTransition(() => setLimit(Number.POSITIVE_INFINITY)),
    );
    return () => cancelAnimationFrame(frame);
  }, [limit]);
  return limit;
}
