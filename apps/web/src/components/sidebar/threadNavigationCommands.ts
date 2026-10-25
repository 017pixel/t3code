import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef, THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { type CommandHandlers, commandScopeRef } from "../../shortcuts/dispatcher";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../../threadRoutes";
import { resolveAdjacentThreadId } from "../Sidebar.logic";

const KEY_SEPARATOR = "\n";

/**
 * Thread keys in a form the React Compiler compares by value, so the scope ref
 * stays put while thread shells stream in and re-registers only when the order moves.
 */
export function threadKeyList(keys: readonly string[]): string {
  return keys.join(KEY_SEPARATOR);
}

function splitThreadKeys(list: string): string[] {
  return list === "" ? [] : list.split(KEY_SEPARATOR);
}

/** The open thread, read from the router when a handler runs rather than at render. */
export function readRouteThreadRef(router: AnyRouter): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  return resolveActiveThreadRouteRef(target, draft);
}

/**
 * Thread traversal and jump shortcuts, live while the sidebar element is mounted.
 * The route and terminal state are read at key time, so navigating or toggling the
 * terminal leaves the scope registered as it was.
 */
export function threadNavigationScopeRef(input: {
  /** From `threadKeyList`. */
  readonly traversalKeys: string;
  /** From `threadKeyList`; index N is `thread.jump.N+1`. */
  readonly jumpKeys: string;
  readonly router: AnyRouter;
  /** Maps the route thread to the row key it highlights; must be stable across renders. */
  readonly rowKeyForRoute?: (threadRef: ScopedThreadRef) => string;
  readonly navigate: (threadRef: ScopedThreadRef) => unknown;
}) {
  const { traversalKeys, jumpKeys, router, rowKeyForRoute = scopedThreadKey, navigate } = input;
  const go = (event: KeyboardEvent, key: string | null | undefined) => {
    const threadRef = key ? parseScopedThreadKey(key) : null;
    if (!threadRef) return false;
    event.preventDefault();
    event.stopPropagation();
    void navigate(threadRef);
    return true;
  };
  const traverse = (direction: "previous" | "next") => (event: KeyboardEvent) => {
    const routeThreadRef = readRouteThreadRef(router);
    return go(
      event,
      resolveAdjacentThreadId({
        threadIds: splitThreadKeys(traversalKeys),
        currentThreadId: routeThreadRef ? rowKeyForRoute(routeThreadRef) : null,
        direction,
      }),
    );
  };
  const commands: CommandHandlers = {
    "thread.previous": traverse("previous"),
    "thread.next": traverse("next"),
  };
  for (const [index, command] of THREAD_JUMP_KEYBINDING_COMMANDS.entries()) {
    commands[command] = (event) => go(event, splitThreadKeys(jumpKeys)[index]);
  }
  return commandScopeRef(commands, {
    when: (event) => !event.repeat && !isCommandPaletteOpen() && !isModelPickerOpen(),
    context: () => {
      const routeThreadRef = readRouteThreadRef(router);
      return {
        terminalOpen: routeThreadRef
          ? selectThreadTerminalUiState(
              useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
              routeThreadRef,
            ).terminalOpen
          : false,
      };
    },
  });
}
