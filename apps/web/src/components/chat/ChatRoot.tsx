import { useRouter, type AnyRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { readRouteThreadKey } from "../../hooks/useActiveThreadRef";
import { matchesMediaQuery } from "../../hooks/useMediaQuery";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { shouldRefocusComposerOnWindowFocus } from "../ChatView.logic";
import { registerOpenFavoriteEditorCommand } from "./OpenInPickerShortcut";
import { attachPasteToFocusComposer } from "./pasteToFocusComposer";

function shouldRefocusComposerNow(router: AnyRouter): boolean {
  if (matchesMediaQuery("max-sm")) return false;
  const threadKey = readRouteThreadKey(router);
  if (threadKey === null) return false;
  return !useTerminalUiStateStore.getState().terminalUiStateByThreadKey[threadKey]?.terminalOpen;
}

function attachWindowRefocus(router: AnyRouter, focusComposer: () => void): () => void {
  let frame: number | null = null;
  const onWindowFocus = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (!shouldRefocusComposerNow(router)) return;
    // The element that held focus receives it again after the window's own event, and the
    // composer ignores that same frame so a restored focus does not lift a scroll-collapsed
    // composer. Wait one more frame so this focus counts as a request to expand it.
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (!shouldRefocusComposerNow(router)) return;
        if (document.querySelector("[data-mcp-app-fullscreen]") !== null) return;
        if (shouldRefocusComposerOnWindowFocus(document.activeElement)) focusComposer();
      });
    });
  };
  window.addEventListener("focus", onWindowFocus);
  return () => {
    window.removeEventListener("focus", onWindowFocus);
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}

/**
 * Owns the chat view's window-level input (favorites, paste, refocus on window focus). Its own
 * component because ChatView is not compiled: the ref callback depends only on stable props, so
 * listeners attach once per root. Handlers read route state when they run.
 */
export function ChatRoot(props: {
  readonly composerRef: ComposerHandleRef;
  /** Must be identity-stable, like the other two callbacks. */
  readonly focusComposer: () => void;
  readonly onElement: (element: HTMLDivElement | null) => void;
  readonly children: ReactNode;
}) {
  const { composerRef, focusComposer, onElement } = props;
  const router = useRouter();
  const attach = (node: HTMLDivElement) => {
    onElement(node);
    const releaseOpenFavorite = registerOpenFavoriteEditorCommand();
    const releasePaste = attachPasteToFocusComposer(composerRef);
    const releaseRefocus = attachWindowRefocus(router, focusComposer);
    return () => {
      onElement(null);
      releaseOpenFavorite();
      releasePaste();
      releaseRefocus();
    };
  };
  return (
    <div
      ref={attach}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {props.children}
    </div>
  );
}
