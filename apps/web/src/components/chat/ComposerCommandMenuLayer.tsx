import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { observeResize } from "~/lib/observeResize";

/**
 * Pins `layer` above the composer's main surface. Geometry is written straight
 * to the layer's style so scrolls and resizes never re-render the menu.
 */
function followComposerAnchor(layer: HTMLElement, anchor: HTMLElement): () => void {
  const updatePosition = () => {
    const form = anchor.closest<HTMLElement>('[data-chat-composer-form="true"]');
    const mainSurface = form?.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    const rect = (mainSurface ?? form ?? anchor).getBoundingClientRect();
    const rootFontSizePx =
      Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    const drawerInsetRem = Number.parseFloat(
      window.getComputedStyle(form ?? anchor).getPropertyValue("--chat-composer-drawer-inset"),
    );
    const drawerInset = drawerInsetRem * rootFontSizePx;
    const width = rect.width - drawerInset * 2;
    if (width <= 0) {
      layer.hidden = true;
      return;
    }
    const composerOverlap = rootFontSizePx + 1;
    layer.hidden = false;
    layer.style.bottom = `${window.innerHeight - rect.top - composerOverlap}px`;
    layer.style.left = `${rect.left + drawerInset}px`;
    layer.style.maxHeight = `${Math.max(96, rect.top - 24 + composerOverlap)}px`;
    layer.style.width = `${width}px`;
  };

  updatePosition();
  window.addEventListener("resize", updatePosition);
  window.addEventListener("scroll", updatePosition, true);

  const observed: Element[] = [anchor];
  for (let element = anchor.parentElement; element; element = element.parentElement) {
    observed.push(element);
  }
  const stopObserving = observeResize(observed, updatePosition);

  return () => {
    stopObserving();
    window.removeEventListener("resize", updatePosition);
    window.removeEventListener("scroll", updatePosition, true);
  };
}

export function ComposerCommandMenuLayer(props: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const anchor = props.anchor;
  if (!anchor) return null;

  return createPortal(
    <div
      // Stays hidden until the anchor has been measured (before paint).
      hidden
      className="pointer-events-auto fixed z-40 flex flex-col"
      data-composer-drawer-layer="true"
    >
      {/* React attaches refs children-first and siblings in order, so this first child places the
          layer before the menu's own refs (such as scrolling the active row into view) measure. */}
      <span
        hidden
        ref={(marker) => {
          const layer = marker?.parentElement;
          if (!layer) return;
          return followComposerAnchor(layer, anchor);
        }}
      />
      {props.children}
    </div>,
    document.body,
  );
}
