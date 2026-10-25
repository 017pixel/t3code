import { useState } from "react";
import type { AssistantCitationRequest, AssistantCitationTarget } from "./AssistantCitationSource";
import type { CitationPhase } from "./citationProcedure";
import { registerCommands } from "../../shortcuts/dispatcher";

const CITATION_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** One activation of a citation; virtual row remounts and listeners share it. */
interface CitationNavigation {
  readonly target: AssistantCitationTarget;
  /**
   * Attaches to the citation viewport (it includes the minimap) for this
   * activation. Owned by the activation so the viewport's ref callback only
   * re-attaches when the activation changes.
   */
  readonly attachDismissal: (citationViewport: HTMLElement) => () => void;
}

interface CitationSettlement {
  /** Per activation, not per key: Back/Forward can restore an earlier key. */
  readonly target: AssistantCitationTarget;
  /** Dismissed citations also drop their highlight; completed ones keep it. */
  readonly dismissed: boolean;
}

export function useAssistantCitationTarget({
  request,
  phase,
  onManualNavigation,
}: {
  request: AssistantCitationRequest | null;
  phase: CitationPhase | null;
  onManualNavigation: () => void;
}) {
  const [settlement, setSettlement] = useState<CitationSettlement | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const onListLoad = () => setListLoaded(true);

  // Rows and listeners mutate the activation, so it lives as long as its
  // request; a target belongs to one request, so returning to an earlier key
  // never reuses it.
  const [navigation, setNavigation] = useState<CitationNavigation | null>(null);
  let current = navigation;
  if ((request?.key ?? null) !== (navigation?.target.key ?? null)) {
    current = request ? createCitationNavigation(request) : null;
    setNavigation(current);
  }
  function createCitationNavigation(next: AssistantCitationRequest): CitationNavigation {
    let done = false;
    let tookOver = false;
    const activationRef: AssistantCitationTarget["activationRef"] = {
      current: { scrolled: false, dismissed: false },
    };
    const target: AssistantCitationTarget = {
      ...next,
      activationRef,
      onComplete: () => {
        done = true;
        // The thread-open follow can run after the scroll started.
        onManualNavigation();
        setSettlement({ target, dismissed: false });
      },
    };
    const attachDismissal = (citationViewport: HTMLElement) => {
      // The follow must yield before the citation row starts scrolling, and the
      // release travels through the viewport, so it happens once per activation
      // when the activation first meets a mounted viewport.
      if (!tookOver && !done) {
        tookOver = true;
        onManualNavigation();
      }
      // User navigation stops a pending citation scroll; Escape dismisses it outright.
      const dismiss = (onlyPending: boolean) => {
        const activation = activationRef.current;
        if (activation.dismissed || (onlyPending && (activation.scrolled || done))) return;
        activation.dismissed = true;
        activation.cancelScroll?.();
        if (!activation.scrolled && !done) onManualNavigation();
        done = true;
        setSettlement({ target, dismissed: true });
      };
      const onNavigation = () => dismiss(true);
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY !== 0) dismiss(true);
      };
      const stopKeys = registerCommands(
        {},
        {
          observe: (event) => {
            if (event.key === "Escape") {
              dismiss(false);
            } else if (
              CITATION_SCROLL_KEYS.has(event.key) &&
              event.target instanceof Node &&
              citationViewport.contains(event.target)
            ) {
              dismiss(true);
            }
          },
        },
      );
      document.addEventListener("pointerdown", onNavigation, true);
      citationViewport.addEventListener("wheel", onWheel, { passive: true });
      citationViewport.addEventListener("touchmove", onNavigation, { passive: true });
      return () => {
        stopKeys();
        document.removeEventListener("pointerdown", onNavigation, true);
        citationViewport.removeEventListener("wheel", onWheel);
        citationViewport.removeEventListener("touchmove", onNavigation);
      };
    };
    return { target, attachDismissal };
  }

  const settled = current !== null && settlement?.target === current.target ? settlement : null;
  const target =
    current !== null && phase?._tag === "ready" && listLoaded && settled?.dismissed !== true
      ? current.target
      : null;
  const positioning = current !== null && phase?._tag !== "failed" && settled === null;

  return {
    target,
    positioning,
    onListLoad,
    attachDismissal: current?.attachDismissal ?? null,
    alwaysRender:
      target && positioning && phase?._tag === "ready" ? { keys: [phase.rowId] } : undefined,
  };
}
