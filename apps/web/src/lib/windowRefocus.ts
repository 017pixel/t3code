// Returning to the window re-fires focus on the element that already held it. That focus arrives
// after the window's own focus event, so the window focus marks the frame in which element focus
// is a refocus rather than the user moving focus.
let refocusFrame: number | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    if (refocusFrame !== null) window.cancelAnimationFrame(refocusFrame);
    refocusFrame = window.requestAnimationFrame(() => {
      refocusFrame = null;
    });
  });
}

/** True between the window regaining focus and the next frame. */
export function isWindowRefocusFrame(): boolean {
  return refocusFrame !== null;
}
