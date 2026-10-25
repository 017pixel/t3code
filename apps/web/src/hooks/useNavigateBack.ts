import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import { registerCommands } from "../shortcuts/dispatcher";

function useNavigateBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  return () => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };
}

/**
 * Ref callback for a page's root: Escape leaves the page while it is mounted.
 * It observes after every command scope, so Escape only goes back when nothing
 * else (a selection, a dialog, a drag) claimed it.
 */
export function useEscapeToGoBack(onEscape?: () => void) {
  const navigateBack = useNavigateBack();
  const handleEscape = onEscape ?? navigateBack;

  return (node: Element | null) =>
    node === null
      ? undefined
      : registerCommands(
          {},
          {
            observe: (event, consumed) => {
              if (consumed || event.repeat || event.isComposing || event.key !== "Escape") return;
              event.preventDefault();
              const activeElement = document.activeElement;
              if (activeElement instanceof HTMLElement) activeElement.blur();
              handleEscape();
            },
          },
        );
}
