import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Activity,
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import ChatView from "./ChatView";
import {
  createKeptViewLifetimes,
  KeptViewFrame,
  KeptViewLifetimeContext,
  setUrlRouteTargetKey,
} from "./keptView";
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
import {
  useEnvironmentThreadRefs,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { environmentThreadDetails } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";
import { isElectron } from "../env";
import { isBootHeld, releaseBootHoldAfterPaint, retainBootHold } from "../connection/catalog";
import {
  buildThreadRouteParams,
  finishWarmingThreadView,
  isThreadRouteSnapshotAuthoritative,
  keepReleasedThreadView,
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

/** Threads with a kept view, as of the last commit; read by KeptChatSurface. */
let keptThreadKeys: ReadonlySet<string> = new Set();

/** How long the user must leave the app alone before a kept view warms up. */
const WARM_UP_QUIET_MS = 1_000;
let lastUserInputAt = 0;
let trackingUserInput = false;
/**
 * Hides the view that is laying out out of sight. Its effects are live then,
 * so its window shortcut and paste listeners would answer input along with
 * the shown view's.
 */
let interruptWarmUp: (() => void) | null = null;
function trackUserInput() {
  if (trackingUserInput || typeof window === "undefined") return;
  trackingUserInput = true;
  // Added before any warming view's listeners, so it runs first and the
  // hidden view's listeners are already removed when the event reaches them.
  const record = () => {
    lastUserInputAt = performance.now();
    interruptWarmUp?.();
  };
  for (const type of ["keydown", "pointerdown", "wheel", "paste"] as const) {
    window.addEventListener(type, record, { capture: true, passive: true });
  }
}

/**
 * Runs `callback` once the user has left the app alone for WARM_UP_QUIET_MS
 * and the browser is idle. Returns a function that cancels it.
 */
function whenQuietAndIdle(callback: () => void, initialDelayMs: number): () => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const attempt = () => {
    const quietFor = performance.now() - lastUserInputAt;
    if (quietFor < WARM_UP_QUIET_MS) {
      timeout = setTimeout(attempt, WARM_UP_QUIET_MS - quietFor);
    } else if (typeof requestIdleCallback === "function") {
      idle = requestIdleCallback(
        () => {
          idle = undefined;
          if (performance.now() - lastUserInputAt < WARM_UP_QUIET_MS) attempt();
          else callback();
        },
        { timeout: 2_000 },
      );
    } else {
      callback();
    }
  };
  timeout = setTimeout(attempt, initialDelayMs);
  return () => {
    clearTimeout(timeout);
    if (idle !== undefined) cancelIdleCallback(idle);
  };
}

let bootChatViewDeferred = false;

// How long the chat view waits for the session before rendering from the
// snapshot. Desktop skips this wait because its backend is still starting.
// A slow tunnel eventually renders the composer without its session.
const BOOT_SESSION_WAIT_MS = 750;

/**
 * On a boot painting from its snapshot, the first frame shows the sidebar and
 * this view's frame, and the chat view renders after it, so its large first
 * render does not hold back that frame.
 *
 * Desktop renders the cached chat view in one task after that first frame.
 * For web, if the environment's session answers within BOOT_SESSION_WAIT_MS,
 * the screen switches to live data and the chat view renders with it in one
 * task, with nothing left to redo. Otherwise it renders from the snapshot as
 * a transition, which yields so the connection keeps making progress, and the
 * switch to live data waits until it has painted.
 */
function useBootDeferredChatView(environmentId: EnvironmentId | null): boolean {
  const [ready, setReady] = useState(() => bootChatViewDeferred || !isBootHeld());
  const pendingReleaseRef = useRef<(() => void) | null>(null);
  const sessionConfigAtom = useEffectEvent(() =>
    environmentId === null ? null : environmentSession.initialConfigValueAtom(environmentId),
  );
  useEffect(() => {
    if (ready) return;
    bootChatViewDeferred = true;
    const release = retainBootHold();
    let mounted = false;
    let stopWaiting = () => {};
    const renderLive = () => {
      if (mounted) return;
      mounted = true;
      stopWaiting();
      // The screen switches to live data in this task and the chat view
      // renders in the next, so neither waits on the other's long task, and
      // its effects run after it paints.
      release();
      setTimeout(() => setReady(true), 0);
    };
    const renderFromSnapshot = (urgent = false) => {
      if (mounted) return;
      mounted = true;
      stopWaiting();
      // Released after the chat view's own commit paints, or on unmount.
      pendingReleaseRef.current = release;
      if (urgent) setReady(true);
      else startTransition(() => setReady(true));
    };
    const afterFirstFrame = () => {
      const configAtom = sessionConfigAtom();
      if (configAtom === null) return renderFromSnapshot();
      if (appAtomRegistry.get(configAtom) !== null) return renderLive();
      // A desktop backend is still booting. Let the user type from the cached
      // screen immediately; sending still waits for the authenticated session.
      // Not as a transition: the boot's other updates keep restarting one,
      // which held the composer back by about 0.9 s.
      if (isElectron) return renderFromSnapshot(true);
      // A task later, so the requests the session sends as it starts go out
      // before this render instead of queuing behind it.
      const unsubscribe = appAtomRegistry.subscribe(configAtom, (config) => {
        if (config !== null) setTimeout(renderLive, 0);
      });
      const timeout = setTimeout(() => renderFromSnapshot(), BOOT_SESSION_WAIT_MS);
      stopWaiting = () => {
        unsubscribe();
        clearTimeout(timeout);
      };
    };
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      afterFirstFrame();
    };
    const frame = requestAnimationFrame(() => setTimeout(start, 0));
    const timer = setTimeout(start, 100);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      stopWaiting();
      if (!mounted) release();
    };
  }, [ready]);
  useEffect(() => {
    const release = pendingReleaseRef.current;
    if (!ready || release === null) return;
    const cancel = releaseBootHoldAfterPaint(release);
    pendingReleaseRef.current = null;
    return cancel;
  }, [ready]);
  return ready;
}

/**
 * The single chat surface behind both `/draft/$draftId` and
 * `/$environmentId/$threadId`. Each draft gets its own ChatView instance (so
 * a background send's state stays with the draft it came from), and that
 * instance carries the draft through its promotion to a server thread: the
 * thread route reuses the view that already shows the thread, under the
 * draft's key, so the route swap only changes props and the timeline never
 * paints an empty frame.
 *
 * The last few server threads stay rendered inside hidden `<Activity>`
 * boundaries, so a revisit only reveals the view it already painted. Hidden
 * views keep their DOM and state; React disconnects their effects and store
 * subscriptions until they are shown again. A first open switches an
 * existing view to the new thread, as the single shared view used to, and
 * keeps the thread it showed in a new hidden view once the app is idle (see
 * `resolveKeptThreadViews`). A draft's view is dropped once another view is
 * shown, as before.
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
  const chatViewReady = useBootDeferredChatView(
    target.kind === "server"
      ? target.threadRef.environmentId
      : (draftSession?.environmentId ?? null),
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
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shell.data?.status);
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
        // Only the thread fields: a draft session also carries a projectId.
        threadKey: scopedThreadKey({
          environmentId: draftSession.environmentId,
          threadId: draftSession.threadId,
        }),
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
  const [releasedView, setReleasedView] = useState<KeptThreadView | null>(null);
  const keptUpdate = resolveKeptThreadViews(keptViews, activeView);
  const nextKeptViews = keptUpdate.views;
  if (nextKeptViews !== keptViews) {
    setKeptViews(nextKeptViews);
    if (keptUpdate.released !== null) setReleasedView(keptUpdate.released);
  }
  // A first open took over the shown view. The thread it showed gets a view
  // of its own again, which warms up out of sight (see KeptViewFrame) so a
  // revisit only reveals it. Mounting it is long work, so it waits until the
  // shown thread has loaded and the user has left the app alone. The view
  // first renders hidden, which React does at idle priority in small slices;
  // only laying it out (its effects and measurements) is one task, and that
  // waits for the next quiet, idle moment.
  const shownThreadStatus = useThreadStatus(target.kind === "server" ? target.threadRef : null);
  const shownThreadLoaded =
    target.kind !== "server" || shownThreadStatus === "live" || shownThreadStatus === "deleted";
  useEffect(trackUserInput, []);
  useEffect(() => {
    if (releasedView === null || !shownThreadLoaded) return;
    return whenQuietAndIdle(
      () =>
        startTransition(() => {
          setKeptViews((current) => keepReleasedThreadView(current, releasedView));
          setReleasedView(null);
        }),
      WARM_UP_QUIET_MS,
    );
  }, [releasedView, shownThreadLoaded]);
  const [laidOutWarmKey, setLaidOutWarmKey] = useState<string | null>(null);
  const warmingKey = keptViews.find((view) => view.warming === true)?.key ?? null;
  const layingOutKey = warmingKey !== null && warmingKey === laidOutWarmKey ? warmingKey : null;
  useEffect(() => {
    if (warmingKey === null || layingOutKey !== null) return;
    return whenQuietAndIdle(() => startTransition(() => setLaidOutWarmKey(warmingKey)), 0);
  }, [layingOutKey, warmingKey]);
  // Input while the view lays out hides it again; it lays out at the next
  // quiet moment.
  useLayoutEffect(() => {
    if (layingOutKey === null) return;
    interruptWarmUp = () => flushSync(() => setLaidOutWarmKey(null));
    return () => {
      interruptWarmUp = null;
    };
  }, [layingOutKey]);
  const finishWarming = (viewKey: string) => {
    setKeptViews((current) => finishWarmingThreadView(current, viewKey));
    setLaidOutWarmKey(null);
  };
  useLayoutEffect(() => {
    keptThreadKeys = new Set(
      keptViews.flatMap((view) => (view.draftId === null ? [view.threadKey] : [])),
    );
  }, [keptViews]);
  // One lifetime per kept view, released once the view is gone for good.
  const [lifetimes] = useState(createKeptViewLifetimes);
  const insetRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    lifetimes.retain(new Set(keptViews.map((view) => view.key)));
  }, [keptViews, lifetimes]);
  useEffect(() => {
    const inset = insetRef.current;
    return () => {
      // Hidden behind a full page, the views stay in the document and keep their
      // lifetimes; only an unmount releases them.
      setTimeout(() => {
        if (!inset?.isConnected) lifetimes.retain(new Set());
      }, 0);
    };
  }, [lifetimes]);
  const activeViewKey =
    activeView === null
      ? null
      : (nextKeptViews.find((view) =>
          activeView.draftId === null
            ? view.threadKey === activeView.threadKey
            : view.key === activeView.key,
        )?.key ?? null);
  // A hidden view keeps its DOM, so its media would keep playing. Pause it
  // whenever the shown view changes or the whole chat is hidden, as leaving a
  // thread used to.
  useLayoutEffect(() => {
    const inset = insetRef.current;
    return () => {
      for (const media of inset?.querySelectorAll<HTMLMediaElement>("video, audio") ?? []) {
        if (!media.paused) media.pause();
      }
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each change of the shown view pauses the one it hid.
  }, [activeViewKey]);

  return (
    <SidebarInset
      ref={insetRef}
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      {chatViewReady &&
        nextKeptViews.map((view) => (
          <Activity
            key={view.key}
            mode={view.key === activeViewKey || view.key === layingOutKey ? "visible" : "hidden"}
          >
            <KeptViewFrame
              viewKey={view.key}
              warming={view.warming === true && view.key !== activeViewKey}
              onWarm={finishWarming}
            >
              <KeptViewLifetimeContext value={lifetimes.get(view.key)}>
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
            </KeptViewFrame>
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
  // Revealing a kept thread follows the click in a transition, so the URL and
  // sidebar selection paint at once. A first open renders with the click, as
  // the single shared view did: deferring it only delays its data render.
  const deferredTargetKey = useDeferredValue(targetKey);
  const targetThreadKey = targetKey?.startsWith("server:")
    ? targetKey.slice("server:".length)
    : null;
  const reveal = targetThreadKey !== null && keptThreadKeys.has(targetThreadKey);
  // Coming back from a full page there is no thread on screen to keep
  // showing, so the kept one is revealed with the click.
  const shownKey = reveal && deferredTargetKey !== null ? deferredTargetKey : targetKey;
  // Keys typed before a deferred reveal lands go to the URL's thread.
  useLayoutEffect(() => setUrlRouteTargetKey(targetKey), [targetKey]);
  // Start loading the thread with the click, ahead of its view.
  useEffect(() => {
    const urgentTarget = threadRouteTargetFromKey(targetKey);
    if (urgentTarget?.kind !== "server") return;
    return appAtomRegistry.mount(environmentThreadDetails.threadAtom(urgentTarget.threadRef));
  }, [targetKey]);
  const [shownTargetKey, setShownTargetKey] = useState(shownKey);
  if (shownKey !== null && shownKey !== shownTargetKey) {
    setShownTargetKey(shownKey);
  }
  const target = useMemo(() => threadRouteTargetFromKey(shownTargetKey), [shownTargetKey]);
  if (target === null) return null;
  return (
    <Activity mode={targetKey !== null && shownKey !== null ? "visible" : "hidden"}>
      <ThreadRouteView target={target} />
    </Activity>
  );
}
