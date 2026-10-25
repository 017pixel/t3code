import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { create } from "zustand";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import {
  COMPOSER_TYPING_IDLE_MS,
  createComposerTypingGuardState,
  updateComposerTypingGuard,
} from "./composerTypingGuard";

type TypingGuardEvent = Parameters<typeof updateComposerTypingGuard>[1];

const NO_HELD_REQUEST_IDS: ReadonlySet<string> = new Set();

// Only one composer can hold focus, so a single guard follows the focused composer. It watches
// that composer's thread for new requests while focused, so it holds what arrives mid-sentence.
const useTypingGuard = create(() => ({
  owner: null as object | null,
  scope: null as string | null,
  state: createComposerTypingGuardState(),
}));

let stopWatchingRequests: (() => void) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function dispatch(event: TypingGuardEvent): void {
  useTypingGuard.setState(({ state }) => ({ state: updateComposerTypingGuard(state, event) }));
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  const { state } = useTypingGuard.getState();
  if (state.held.size === 0) return;
  idleTimer = setTimeout(
    () => {
      idleTimer = null;
      dispatch({ type: "idle" });
    },
    Math.max(0, state.lastTypedAt + COMPOSER_TYPING_IDLE_MS - Date.now()),
  );
}

function enterScope(owner: object, scope: string, threadRef: ScopedThreadRef | null): void {
  const current = useTypingGuard.getState();
  if (current.owner !== owner) useTypingGuard.setState({ owner });
  if (current.scope === scope) return;
  stopWatchingRequests?.();
  stopWatchingRequests = null;
  useTypingGuard.setState({
    scope,
    state: { ...createComposerTypingGuardState(), focused: current.state.focused },
  });
  if (!threadRef) return;
  stopWatchingRequests = appAtomRegistry.subscribe(
    environmentThreadDetails.pendingRequestsAtom(threadRef),
    (pending) =>
      dispatch({
        type: "requests",
        requestIds: pending
          ? [...pending.approvals, ...pending.userInputs].map((request) => request.requestId)
          : [],
        now: Date.now(),
      }),
    { immediate: true },
  );
}

function leaveScope(owner: object): void {
  if (useTypingGuard.getState().owner !== owner) return;
  dispatch({ type: "blur" });
  stopWatchingRequests?.();
  stopWatchingRequests = null;
  useTypingGuard.setState({ owner: null, scope: null });
}

/** Whether the typing guard is holding `requestId` back from the focused composer right now. */
export function isRequestHeldByTypingGuard(requestId: string): boolean {
  return useTypingGuard.getState().state.held.has(requestId);
}

/**
 * The guard's events for one composer. `owner` identifies the composer, so a composer that lost
 * the guard to another cannot release or re-scope it.
 */
export function composerTypingGuardHandlers(
  owner: object,
  scope: string,
  threadRef: ScopedThreadRef | null,
) {
  const ownsGuard = () => useTypingGuard.getState().owner === owner;
  return {
    onDraftChange: () => {
      if (!ownsGuard()) return;
      // The composer can switch threads while it keeps focus.
      enterScope(owner, scope, threadRef);
      dispatch({ type: "type", now: Date.now() });
    },
    onFocus: () => {
      enterScope(owner, scope, threadRef);
      dispatch({ type: "focus" });
    },
    onBlur: () => leaveScope(owner),
    onSend: () => {
      if (ownsGuard()) dispatch({ type: "send" });
    },
    /** A composer removed while focused gets no blur event. */
    onUnmount: () => leaveScope(owner),
  };
}

/**
 * Holds back approvals and questions that arrive while the user is typing in the composer for
 * `scope`, so a keystroke never lands in a control that appeared under the cursor.
 */
export function useComposerTypingGuard(scope: string, threadRef: ScopedThreadRef | null) {
  const [owner] = useState(() => ({}));
  // Release depends only on the owner. A scoped release would change identity on every thread
  // switch, re-running the form's ref cleanup and releasing a guard the focused composer holds.
  const [onUnmount] = useState(() => () => leaveScope(owner));
  const heldRequestIds = useTypingGuard((guard) =>
    guard.owner === owner && guard.scope === scope ? guard.state.held : NO_HELD_REQUEST_IDS,
  );
  return { heldRequestIds, ...composerTypingGuardHandlers(owner, scope, threadRef), onUnmount };
}
