import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";

function toThreadRef(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ScopedThreadRef | null {
  return environmentId !== null && threadId !== null
    ? scopeThreadRef(environmentId, threadId)
    : null;
}

/** Key by ids: streaming shell identity changes must not retrigger effects. */
export function useActiveThreadRef(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): ScopedThreadRef | null {
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.id ?? null;
  const [ref, setRef] = useState(() => toThreadRef(environmentId, threadId));
  if ((ref?.environmentId ?? null) !== environmentId || (ref?.threadId ?? null) !== threadId) {
    const next = toThreadRef(environmentId, threadId);
    setRef(next);
    return next;
  }
  return ref;
}

/**
 * The thread key the router is showing now, for async continuations that must not touch a thread
 * the user has since left. A draft route resolves through its session, or its promotion redirect.
 */
export function readRouteThreadKey(router: Pick<AnyRouter, "state">): string | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (target === null) return null;
  if (target.kind === "server") return scopedThreadKey(target.threadRef);
  const drafts = useComposerDraftStore.getState();
  const session = drafts.getDraftSession(target.draftId);
  if (session) return scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId));
  const redirect = drafts.getPromotedDraftRedirect(target.draftId);
  return redirect ? scopedThreadKey(redirect) : null;
}
