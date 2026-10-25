import { pasteTextToFocusComposer, shouldRedirectInputToComposer } from "./composerFocusRedirect";
import { readPastedComposerContext } from "../composerInlineTokenPaste";
import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import { isMacPlatform } from "../../lib/utils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import type { ComposerHandleRef } from "../../composerHandleContext";

/**
 * Paste-to-focus: the resting composer blurs on a click into the timeline, so a paste that
 * follows has no editable target and would be dropped. This sends it to the composer instead.
 * Returns the cleanup, for the chat root's ref callback, which only mounts with an active thread.
 */
export function attachPasteToFocusComposer(composerRef: ComposerHandleRef): () => void {
  let pasteAsTextShortcutUntil = 0;
  const keyHandler = (event: KeyboardEvent) => {
    if (
      shouldRedirectInputToComposer(event) &&
      isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
    ) {
      pasteAsTextShortcutUntil = Date.now() + 1_000;
    }
  };
  const handler = (event: ClipboardEvent) => {
    if (isCommandPaletteOpen()) return;
    if (getTerminalFocusOwner() !== null) return;
    if (composerRef.current?.isModelPickerOpen()) return;
    const text = pasteTextToFocusComposer(event);
    const clipboardData = event.clipboardData;
    if (text === null || clipboardData === null) return;
    const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntil;
    pasteAsTextShortcutUntil = 0;
    if (
      ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
        composerRef.current?.pasteTextAtEnd(text, { bypassAutoAttachment })) ||
      composerRef.current?.insertTextAtEnd(text, { clipboardData })
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  window.addEventListener("keydown", keyHandler, true);
  window.addEventListener("paste", handler, true);
  return () => {
    window.removeEventListener("keydown", keyHandler, true);
    window.removeEventListener("paste", handler, true);
  };
}
