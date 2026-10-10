import { useCallback, useRef, useState } from "react";

/**
 * Element state for a callback ref. A hidden `<Activity>` (a kept thread
 * view) detaches refs but leaves the element in the document, so a null only
 * lands once the element has really left it. Hiding and revealing a view
 * then keeps its measurements instead of resetting and recomputing them.
 */
export function useElementState<T extends Element>(): readonly [
  T | null,
  (element: T | null) => void,
] {
  const [element, setElement] = useState<T | null>(null);
  const latestRef = useRef<T | null>(null);
  const setRef = useCallback((next: T | null) => {
    if (next !== null) {
      latestRef.current = next;
      setElement(next);
      return;
    }
    const previous = latestRef.current;
    if (previous === null) return;
    // A removed element is out of the document once the commit finishes.
    queueMicrotask(() => {
      if (latestRef.current !== previous || previous.isConnected) return;
      latestRef.current = null;
      setElement(null);
    });
  }, []);
  return [element, setRef] as const;
}
