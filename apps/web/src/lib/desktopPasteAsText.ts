import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import { registerMenuAction } from "../shortcuts/dispatcher";
import { isMacPlatform } from "./utils";

// Electron can deliver its native menu action just before the paste event, while browsers
// normally deliver keydown first. A short deadline bridges both event paths without leaving
// later pastes in bypass mode.
const ARM_WINDOW_MS = 1_000;

const FOCUS_TAKES_PASTE_SELECTOR =
  'input, textarea, select, button, a[href], summary, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="button"], [role="menuitem"], [role="option"]';

type PasteAsTextArm = {
  readonly until: number;
  readonly origin: "shortcut" | "menu";
  readonly target: EventTarget | null;
};

let arm: PasteAsTextArm | null = null;

function armsPasteFor(current: PasteAsTextArm, scope: Element | null): boolean {
  if (current.target instanceof Node && scope?.contains(current.target)) return true;
  // The menu item has no keyboard target. It reaches the composer when nothing else that takes
  // a paste holds focus.
  return (
    current.origin === "menu" &&
    !(current.target instanceof Element && current.target.closest(FOCUS_TAKES_PASTE_SELECTOR))
  );
}

/** Whether the next paste into `scope` should bypass auto-attachment, without consuming it. */
export function isPasteAsTextArmed(scope: Element | null, now = Date.now()): boolean {
  return arm !== null && now <= arm.until && armsPasteFor(arm, scope);
}

/** Like isPasteAsTextArmed, but disarms: one shortcut press covers one paste. */
export function consumePasteAsText(scope: Element | null, now = Date.now()): boolean {
  const armed = isPasteAsTextArmed(scope, now);
  arm = null;
  return armed;
}

export function armPasteAsText(
  origin: PasteAsTextArm["origin"],
  target: EventTarget | null,
  now = Date.now(),
): void {
  arm = { until: now + ARM_WINDOW_MS, origin, target };
}

function disarmPasteAsText(): void {
  arm = null;
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))) {
        armPasteAsText("shortcut", event.target);
      }
    },
    true,
  );
  window.addEventListener("blur", disarmPasteAsText);
  // Bubble phase: a composer that handles the paste consumes the arm first, and a paste anywhere
  // else must not leave it armed for the next one.
  window.addEventListener("paste", disarmPasteAsText);
}

registerMenuAction("paste-as-text", () => {
  armPasteAsText("menu", document.activeElement);
  void window.desktopBridge?.pasteAsText?.();
});
