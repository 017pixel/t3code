import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import { observeResize } from "~/lib/observeResize";
import { resolveRestingComposerControlsLayout } from "../composerFooterLayout";
import { useRef, useState } from "react";

export function useRestingComposerControlsLayout(
  host: HTMLDivElement | null,
  useControlsAsHost = false,
) {
  const controlsRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{
    hiddenCount: number;
    iconOnlyCount?: number;
    visible: boolean;
  }>({ hiddenCount: 0, visible: true });

  // Re-attaches when the host changes, so the observers always watch the current pair.
  const attachControls = (controls: HTMLDivElement | null) => {
    controlsRef.current = controls;
    const currentHost = useControlsAsHost ? controls : host;
    if (!currentHost || !controls) return;

    const measure = () => {
      const measurement = measureRestingComposerControls(controls);
      if (!measurement) return;
      const style = getComputedStyle(currentHost);
      const hostWidth =
        currentHost.clientWidth -
        (Number.parseFloat(style.paddingInlineStart) || 0) -
        (Number.parseFloat(style.paddingInlineEnd) || 0);

      setLayout((current) => {
        const next = resolveRestingComposerControlsLayout({
          ...measurement,
          hostWidth,
          previous: current,
        });
        return next.hiddenCount === current.hiddenCount &&
          next.iconOnlyCount === current.iconOnlyCount &&
          next.visible === current.visible
          ? current
          : next;
      });
    };

    let stopObserving = () => {};
    const observeControls = () => {
      stopObserving();
      stopObserving = observeResize(
        [
          currentHost,
          controls,
          ...controls.querySelectorAll<HTMLElement>(
            "[data-resting-block], [data-composer-control-label], [data-chat-provider-model-picker-label]",
          ),
        ],
        measure,
      );
      measure();
    };
    observeControls();
    const mutations = new MutationObserver(observeControls);
    mutations.observe(controls, { childList: true, subtree: true, characterData: true });
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopObserving();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
      controlsRef.current = null;
    };
  };

  return {
    controlsRef,
    attachControls,
    hiddenBlockCount: layout.hiddenCount,
    iconOnlyBlockCount: layout.iconOnlyCount ?? 0,
    controlsVisible: layout.visible,
  };
}
