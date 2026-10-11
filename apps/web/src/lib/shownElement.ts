/**
 * The first element matching `selector` that is rendered. A kept thread view
 * that is hidden keeps its DOM (React hides it with `display: none`),
 * including open popups and state attributes, so document-wide checks for
 * "is a menu open" must skip it.
 */
export function queryShownElement(selector: string): Element | null {
  if (typeof document === "undefined") return null;
  for (const element of document.querySelectorAll(selector)) {
    const shown =
      typeof element.checkVisibility === "function"
        ? element.checkVisibility()
        : element.getClientRects().length > 0;
    if (shown) return element;
  }
  return null;
}
