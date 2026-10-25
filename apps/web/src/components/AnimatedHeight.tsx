import { type ReactNode, useState } from "react";
import { observeResize } from "../lib/observeResize";

const HEIGHT_TRANSITION_FALLBACK_MS = 250;

export function AnimatedHeight({
  children,
  holdHeight = false,
}: {
  readonly children: ReactNode;
  readonly holdHeight?: boolean;
}) {
  const [heightState, setHeightState] = useState<{
    readonly height: number | null;
    readonly isClipping: boolean;
  }>({ height: null, isClipping: false });

  const stopClipping = () =>
    setHeightState((currentState) =>
      currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
    );

  const measureContent = (element: HTMLDivElement | null) => {
    if (holdHeight || !element) return;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;
    let fallbackTimeoutId: number | null = null;
    let lastMeasuredHeight: number | null = null;

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.scrollHeight || element.getBoundingClientRect().height);
      if (nextHeight === lastMeasuredHeight) return;
      lastMeasuredHeight = nextHeight;
      setHeightState((currentState) => {
        if (currentState.height === nextHeight) return currentState;
        return {
          height: nextHeight,
          isClipping: currentState.height !== null,
        };
      });
      // transitionend never fires when motion is reduced or the transition is
      // interrupted; a height change mid-transition restarts the fallback.
      if (fallbackTimeoutId !== null) window.clearTimeout(fallbackTimeoutId);
      fallbackTimeoutId = window.setTimeout(() => {
        fallbackTimeoutId = null;
        stopClipping();
      }, HEIGHT_TRANSITION_FALLBACK_MS);
    };
    const cancelPendingFrames = () => {
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
        firstFrameId = null;
      }
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
        secondFrameId = null;
      }
    };
    const updateHeightAfterPaint = () => {
      cancelPendingFrames();
      updateHeight();
      firstFrameId = window.requestAnimationFrame(() => {
        firstFrameId = null;
        updateHeight();
        secondFrameId = window.requestAnimationFrame(() => {
          secondFrameId = null;
          updateHeight();
        });
      });
    };

    updateHeightAfterPaint();
    const stopObserving = observeResize(element, updateHeightAfterPaint);
    return () => {
      stopObserving();
      cancelPendingFrames();
      if (fallbackTimeoutId !== null) {
        window.clearTimeout(fallbackTimeoutId);
        // Held height clips on its own, and no pending transition can end it.
        stopClipping();
      }
    };
  };

  return (
    <div
      data-slot="animated-height"
      className="transition-[height] duration-200 ease-out motion-reduce:transition-none [overflow-clip-margin:2px]"
      style={
        heightState.height === null
          ? undefined
          : {
              height: heightState.height,
              overflow: holdHeight || heightState.isClipping ? "clip" : "visible",
            }
      }
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "height") return;
        stopClipping();
      }}
    >
      <div ref={measureContent} style={holdHeight ? { height: "100%" } : undefined}>
        {children}
      </div>
    </div>
  );
}
