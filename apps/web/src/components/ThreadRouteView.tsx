import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Activity,
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import ChatView from "./ChatView";
import { createKeptViewLifetime, KeptViewLifetimeContext } from "./keptView";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useThreadRefs, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import {
  buildThreadRouteParams,
  resolveKeptThreadViews,
  resolveThreadRouteRenderState,
  resolveThreadRouteTarget,
  threadRouteTargetFromKey,
  threadRouteTargetKey,
  type KeptThreadView,
  type ThreadRouteTarget,
} from "../threadRoutes";

// Kept views re-render only when their own thread or route kind changes.
const KeptChatView = memo(ChatView);

/**
 * The single chat surface behind both `/draft/$draftId` and
 * `/$environmentId/$threadId`. Each draft gets its own ChatView instance (so
 * a background send's state stays with the draft it came from), and that
 * instance carries the draft through its promotion to a server thread: the
 * thread route keeps keying by the draft id while the draft record exists,
 * so the route swap only changes props and the timeline never paints an
 * empty frame.
 *
 * The last few server threads stay rendered inside hidden `<Activity>`
 * boundaries, so a revisit only reveals the view it already painted. Hidden
 * views keep their DOM and state; React disconnects their effects and store
 * subscriptions until they are shown again.
 *
 * Rendered by KeptChatSurface rather than by the two leaf routes, since an
 * element only survives a route swap when the same parent renders it.
 */
export const ThreadRouteView = memo(function ThreadRouteView({
  target,
}: {
  target: ThreadRouteTarget;
}) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  // The server thread this view is about: the route's own ref, or the draft's
  // reserved ref once the server knows it.
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : (draftSession?.promotedTo ?? inferredThreadRef);
  const serverThread = useThreadShell(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const shell = useEnvironmentQuery(
    serverThreadRef === null ? null : environmentShell.stateAtom(serverThreadRef.environmentId),
  );
  const serverThreadShell = serverThread;
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    draftThreadExists: draftThread !== null,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    // Navigation already resolved onto this path, so a drop aimed here
    // passed its landing check; once the thread reads as missing it can
    // never be attached, release it even when there is nowhere to redirect.
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, target]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let activeView: Omit<KeptThreadView, "visit"> | null = null;
  if (target.kind === "draft") {
    if (draftSession) {
      activeView = {
        key: target.draftId,
        threadKey: scopedThreadKey(draftSession),
        environmentId: draftSession.environmentId,
        threadId: draftSession.threadId,
        draftId: target.draftId,
      };
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    activeView = {
      key: scopedThreadKey(target.threadRef),
      threadKey: scopedThreadKey(target.threadRef),
      environmentId: target.threadRef.environmentId,
      threadId: target.threadRef.threadId,
      draftId: null,
    };
  }
  const [keptViews, setKeptViews] = useState<ReadonlyArray<KeptThreadView>>([]);
  const nextKeptViews = resolveKeptThreadViews(keptViews, activeView);
  if (nextKeptViews !== keptViews) {
    setKeptViews(nextKeptViews);
  }
  // One lifetime per kept view, released once the view is gone for good.
  const lifetimesRef = useRef(new Map<string, ReturnType<typeof createKeptViewLifetime>>());
  const insetRef = useRef<HTMLElement | null>(null);
  const lifetimeFor = (key: string) => {
    let lifetime = lifetimesRef.current.get(key);
    if (lifetime === undefined) {
      lifetime = createKeptViewLifetime();
      lifetimesRef.current.set(key, lifetime);
    }
    return lifetime;
  };
  useLayoutEffect(() => {
    const keys = new Set(keptViews.map((view) => view.key));
    for (const [key, lifetime] of lifetimesRef.current) {
      if (keys.has(key)) continue;
      lifetimesRef.current.delete(key);
      lifetime.dispose();
    }
  }, [keptViews]);
  useEffect(() => {
    const lifetimes = lifetimesRef.current;
    const inset = insetRef.current;
    return () => {
      // Hidden behind a full page, the views stay in the document and keep their
      // lifetimes; only an unmount releases them.
      setTimeout(() => {
        if (inset?.isConnected) return;
        for (const lifetime of lifetimes.values()) lifetime.dispose();
        lifetimes.clear();
      }, 0);
    };
  }, []);
  const activeViewKey =
    activeView === null
      ? null
      : (nextKeptViews.find((view) =>
          activeView.draftId === null
            ? view.threadKey === activeView.threadKey
            : view.key === activeView.key,
        )?.key ?? null);

  return (
    <SidebarInset
      ref={insetRef}
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      {nextKeptViews.map((view) => (
        <Activity key={view.key} mode={view.key === activeViewKey ? "visible" : "hidden"}>
          <KeptViewLifetimeContext value={lifetimeFor(view.key)}>
            {view.draftId === null ? (
              <KeptChatView
                environmentId={view.environmentId}
                threadId={view.threadId}
                routeKind="server"
              />
            ) : (
              <KeptChatView
                draftId={view.draftId}
                environmentId={view.environmentId}
                threadId={view.threadId}
                routeKind="draft"
                forceExpandedMobileComposer
              />
            )}
          </KeptViewLifetimeContext>
        </Activity>
      ))}
    </SidebarInset>
  );
});

/**
 * Hosts the thread view above the route outlet. A full page (settings, pull
 * requests) hides the chat rather than unmounting it, so returning to a
 * thread only reveals it.
 */
export function KeptChatSurface() {
  const targetKey = useParams({
    strict: false,
    select: (params) => threadRouteTargetKey(resolveThreadRouteTarget(params)),
  });
  // The URL and sidebar selection commit with the click; the thread view
  // swap follows in a transition, so opening a thread never holds that frame.
  const deferredTargetKey = useDeferredValue(targetKey);
  const [shownTargetKey, setShownTargetKey] = useState(deferredTargetKey);
  if (deferredTargetKey !== null && deferredTargetKey !== shownTargetKey) {
    setShownTargetKey(deferredTargetKey);
  }
  const target = useMemo(() => threadRouteTargetFromKey(shownTargetKey), [shownTargetKey]);
  if (target === null) return null;
  return (
    <Activity mode={targetKey !== null && deferredTargetKey !== null ? "visible" : "hidden"}>
      <ThreadRouteView target={target} />
    </Activity>
  );
}
