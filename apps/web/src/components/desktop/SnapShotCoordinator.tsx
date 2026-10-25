import {
  type DesktopPendingSnapShot,
  type DesktopSnapShotEvent,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  createNewThreadHandler,
  type NewThreadHandler,
  resolveDefaultProjectRef,
} from "../../hooks/useHandleNewThread";
import { getClientSettings, subscribeClientSettings } from "../../hooks/useSettings";
import { readProjects, readThreadShell } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { compressImageToByteLimit, dataUrlToFile } from "../../lib/imageCompression";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  dismissSnapShotAnimation,
  finishSnapShotAnimation,
  getPendingSnapShotAnimations,
  updateSnapShotAnimationSource,
  waitForSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { playSnapShotSound } from "../../lib/snapShotSound";
import {
  dispatchSnapShotComposerFocus,
  getDesktopSnapShotBridge,
  type DesktopSnapShotBridge,
} from "../../lib/desktopSnapShot";
import {
  countQuestionRequestAttachments,
  openQuestionAttachmentDraft,
} from "../chat/usePendingThreadRequests";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = DraftId | ScopedThreadRef;
type CaptureFailure = "missing-project" | "delivery";

function isSameCaptureTarget(a: CaptureTarget, b: CaptureTarget): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

function isSameRouteThread(target: ScopedThreadRef, routeThreadRef: ScopedThreadRef | null) {
  return (
    routeThreadRef !== null &&
    routeThreadRef.environmentId === target.environmentId &&
    routeThreadRef.threadId === target.threadId
  );
}

export function resolveExistingSnapShotTarget(
  target: CaptureTarget,
  routeThreadRef: ScopedThreadRef | null,
): CaptureTarget | null {
  const store = useComposerDraftStore.getState();
  if (typeof target === "string") {
    const draftSession = store.getDraftSession(target);
    if (draftSession?.promotedTo) return draftSession.promotedTo;
    return draftSession ? target : null;
  }
  return isSameRouteThread(target, routeThreadRef) ||
    store.getDraftSessionByRef(target) !== null ||
    readThreadShell(target) !== null
    ? target
    : null;
}

// Pin absence too: a later question must never claim an earlier capture. Only the thread on
// screen shows its question, so a capture for any other thread goes to that thread's draft.
export function resolveSnapShotAttachmentTarget(
  pins: Map<string, DraftId | null>,
  id: string,
  target: CaptureTarget,
  routeThreadRef: ScopedThreadRef | null,
): CaptureTarget {
  const open =
    typeof target !== "string" && isSameRouteThread(target, routeThreadRef)
      ? openQuestionAttachmentDraft(target)
      : null;
  if (!pins.has(id)) pins.set(id, open?.draftId ?? null);
  const pinned = pins.get(id);
  return pinned && pinned === open?.draftId ? pinned : target;
}

const NEXT_PAINT_FALLBACK_MS = 100;

export async function beginSnapShotAnimationWhenReady(
  id: string,
  target: Promise<CaptureTarget | null>,
  pendingStarts: Set<string>,
): Promise<void> {
  pendingStarts.add(id);
  try {
    const resolvedTarget = await target;
    if (pendingStarts.delete(id) && resolvedTarget) {
      beginSnapShotAnimation(id, resolvedTarget);
    }
  } finally {
    pendingStarts.delete(id);
  }
}

export function dismissFailedSnapShot(
  id: string | undefined,
  soundedIds: Set<string>,
  pendingStarts: Set<string>,
): void {
  if (id) {
    pendingStarts.delete(id);
    soundedIds.delete(id);
    void dismissSnapShotAnimation(id);
  } else {
    pendingStarts.clear();
    soundedIds.clear();
    dismissAllSnapShotAnimations();
  }
}

function resolveSnapShotTargetOnce(
  resolutionRef: { current: Promise<CaptureTarget | null> | null },
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  if (resolutionRef.current) return resolutionRef.current;
  const resolution = resolveTarget().finally(() => {
    if (resolutionRef.current === resolution) resolutionRef.current = null;
  });
  resolutionRef.current = resolution;
  return resolution;
}

export function resolveSnapShotDeliveryTarget(
  targets: Map<string, Promise<CaptureTarget | null>>,
  id: string,
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  const existing = targets.get(id);
  if (existing) return existing;
  const target = resolveTarget().catch(() => null);
  targets.set(id, target);
  void target.then((resolved) => {
    if (!resolved && targets.get(id) === target) targets.delete(id);
  });
  return target;
}

async function afterNextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const fallback = window.setTimeout(resolve, NEXT_PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  });
}

export async function deliverSnapShot(
  bridge: DesktopSnapShotBridge,
  item: DesktopPendingSnapShot,
  resolveTarget: () => CaptureTarget,
): Promise<void> {
  const store = useComposerDraftStore.getState();
  updateSnapShotAnimationSource(item.id, item.source);
  const capture = await bridge.readSnapShot(item.id);
  const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
  const compressed = await compressImageToByteLimit(original, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!compressed.ok) {
    finishSnapShotAnimation(item.id);
    throw new Error("The captured window is too large to attach.");
  }
  const file = compressed.file;
  const source = resizeSnapShotSource(capture.source, compressed.imageSize);
  const dataUrl = compressed.recompressed ? await readFileAsDataUrl(file) : capture.dataUrl;
  const target = resolveTarget();
  const alreadyAttached =
    store.getComposerDraft(target)?.images.some(({ id }) => id === capture.id) ?? false;
  if (!alreadyAttached) {
    const questionAttachmentCount =
      typeof target === "string" ? countQuestionRequestAttachments(target) : null;
    const image = {
      type: "image" as const,
      id: capture.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
      source,
    };
    // Only question drafts may bypass addImage's thread-session gate.
    const added =
      questionAttachmentCount === null
        ? store.addImage(target, image)
        : questionAttachmentCount < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
          store.addImages(target, [image]).includes(capture.id);
    if (!added) throw new Error("Remove an attachment, then try this capture again.");
  }
  const persisted: PersistedComposerImageAttachment = {
    id: capture.id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl,
    source,
  };
  const persistedAttachments =
    store
      .getComposerDraft(target)
      ?.persistedAttachments.filter((attachment) => attachment.id !== capture.id) ?? [];
  await store.syncPersistedAttachments(target, [...persistedAttachments, persisted]);
  if (!store.getComposerDraft(target)?.persistedAttachments.some(({ id }) => id === capture.id)) {
    throw new Error("The captured window could not be saved to the draft.");
  }

  // Paint the attachment before removing the capture overlay to avoid missing frames at landing.
  if (getPendingSnapShotAnimations().some((animation) => animation.id === capture.id)) {
    await afterNextPaint();
    await waitForSnapShotAnimationDestination(capture.id).catch(() => undefined);
    finishSnapShotAnimation(capture.id);
    await afterNextPaint();
  }
  await bridge.acknowledgeSnapShot(capture.id);
  dispatchSnapShotComposerFocus();
}

function readRouteTarget(router: AnyRouter) {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  return {
    routeThreadRef: target?.kind === "server" ? target.threadRef : null,
    routeDraftId: target?.kind === "draft" ? target.draftId : null,
  };
}

/** The project a capture opens a new draft in when no thread or draft can take it. */
function readCaptureProjectRef(router: AnyRouter, handleNewThread: NewThreadHandler) {
  const { routeThreadRef, routeDraftId } = readRouteTarget(router);
  const drafts = useComposerDraftStore.getState();
  return resolveThreadActionProjectRef({
    activeDraftThread: routeThreadRef
      ? drafts.getDraftThread(routeThreadRef)
      : routeDraftId
        ? drafts.getDraftSession(routeDraftId)
        : null,
    activeThread: (routeThreadRef ? readThreadShell(routeThreadRef) : null) ?? undefined,
    defaultProjectRef: resolveDefaultProjectRef(
      readProjects(),
      useUiStateStore.getState().projectOrder,
    ),
    handleNewThread,
  });
}

/**
 * Delivers desktop window captures into the thread or draft on screen. Captures
 * arrive from the desktop shell at any time, so this runs for the life of the app
 * and follows the snapShotEnabled setting.
 */
export function startSnapShotCoordinator(router: AnyRouter): () => void {
  const bridge = getDesktopSnapShotBridge();
  if (!bridge) return () => {};
  const handleNewThread = createNewThreadHandler(router);
  const captureTargets = new Map<string, Promise<CaptureTarget | null>>();
  const questionPins = new Map<string, DraftId | null>();
  const targetResolution: { current: Promise<CaptureTarget | null> | null } = { current: null };
  let draining: Promise<void> | null = null;
  let rerunRequested = false;
  const soundedCaptureIds = new Set<string>();
  const reportedCaptureFailures = new Map<string, Set<CaptureFailure>>();
  const pendingAnimationStarts = new Set<string>();

  // Captures go to the last thread or draft on screen, even from routes that show neither.
  const currentRouteTarget = (): CaptureTarget | null => {
    const { routeThreadRef, routeDraftId } = readRouteTarget(router);
    return routeThreadRef ?? routeDraftId;
  };
  let lastRouteTarget = currentRouteTarget();
  const recordRouteTarget = () => {
    const current = currentRouteTarget();
    if (current && (lastRouteTarget === null || !isSameCaptureTarget(current, lastRouteTarget))) {
      lastRouteTarget = current;
    }
  };
  const routeThreadRef = () => readRouteTarget(router).routeThreadRef;

  // Reuse the resolved target until navigation so captures in one drain share a draft.
  // A resolution records it against the route it started from, so a route change while it is
  // pending cannot hand that draft to the new route.
  let settledTarget: {
    readonly routeTarget: CaptureTarget | null;
    readonly target: CaptureTarget | null;
  } | null = null;
  const readSettledTarget = (routeTarget: CaptureTarget | null) =>
    settledTarget && settledTarget.routeTarget === routeTarget ? settledTarget.target : routeTarget;
  const settleTarget = (routeTarget: CaptureTarget | null, target: CaptureTarget | null) => {
    settledTarget = { routeTarget, target };
  };

  const resolveTarget = async (): Promise<CaptureTarget | null> => {
    const routeTarget = lastRouteTarget;
    const lastTarget = readSettledTarget(routeTarget);
    if (lastTarget) {
      const existingTarget = resolveExistingSnapShotTarget(lastTarget, routeThreadRef());
      if (existingTarget) {
        settleTarget(routeTarget, existingTarget);
        return existingTarget;
      }
      settleTarget(routeTarget, null);
    }
    const projectRef = readCaptureProjectRef(router, handleNewThread);
    if (!projectRef) return null;
    const created = await handleNewThread(projectRef);
    if (!created) return null;
    settleTarget(routeTarget, created.draftId);
    return created.draftId;
  };

  const resolveCaptureTarget = () => resolveSnapShotTargetOnce(targetResolution, resolveTarget);

  const playCaptureSound = (id: string) => {
    const settings = getClientSettings();
    if (!settings.snapShotPlaySound || soundedCaptureIds.has(id)) return;
    soundedCaptureIds.add(id);
    try {
      playSnapShotSound(settings.snapShotSound);
    } catch {}
  };

  const reportOnce = (
    id: string,
    failure: CaptureFailure,
    toast: Parameters<typeof toastManager.add>[0],
  ) => {
    if (!getClientSettings().snapShotEnabled) return;
    const failures = reportedCaptureFailures.get(id) ?? new Set<CaptureFailure>();
    if (failures.has(failure)) return;
    failures.add(failure);
    reportedCaptureFailures.set(id, failures);
    toastManager.add(toast);
  };

  const drain = async () => {
    if (!getClientSettings().snapShotEnabled) return;
    if (draining) {
      rerunRequested = true;
      return draining;
    }

    const operation = (async () => {
      do {
        rerunRequested = false;
        const pending = await bridge.listPendingSnapShots();
        for (const item of pending) {
          if (!getClientSettings().snapShotEnabled) return;
          playCaptureSound(item.id);
          const capturedTarget = await resolveSnapShotDeliveryTarget(
            captureTargets,
            item.id,
            resolveCaptureTarget,
          );
          if (!getClientSettings().snapShotEnabled) return;
          const target = capturedTarget
            ? resolveExistingSnapShotTarget(capturedTarget, routeThreadRef())
            : null;
          if (!target) {
            await dismissSnapShotAnimation(item.id);
            reportOnce(
              item.id,
              "missing-project",
              stackedThreadToast({
                type: "error",
                title: "Snapshot taken, but no project is available",
                description: "Add a project, then capture the window again.",
              }),
            );
            continue;
          }

          try {
            // Pending captures may have arrived without a requested event; pin before reading.
            resolveSnapShotAttachmentTarget(questionPins, item.id, target, routeThreadRef());
            await deliverSnapShot(bridge, item, () =>
              resolveSnapShotAttachmentTarget(questionPins, item.id, target, routeThreadRef()),
            );
            captureTargets.delete(item.id);
            questionPins.delete(item.id);
            soundedCaptureIds.delete(item.id);
            reportedCaptureFailures.delete(item.id);
          } catch (error) {
            await dismissSnapShotAnimation(item.id);
            reportOnce(
              item.id,
              "delivery",
              stackedThreadToast({
                type: "error",
                title: "Snapshot failed",
                description: `Capture ${item.id}: ${
                  error instanceof Error ? error.message : "Try the capture again."
                }`,
              }),
            );
          }
        }
      } while (rerunRequested && getClientSettings().snapShotEnabled);
    })()
      .catch((error: unknown) => {
        dismissAllSnapShotAnimations();
        if (!getClientSettings().snapShotEnabled) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Snapshot failed",
            description: error instanceof Error ? error.message : "Try the capture again.",
          }),
        );
      })
      .finally(() => {
        draining = null;
      });
    draining = operation;
    return operation;
  };

  const handleSnapShotEvent = (event: DesktopSnapShotEvent) => {
    if (!getClientSettings().snapShotEnabled) return;
    switch (event.type) {
      case "requested": {
        const current = readSettledTarget(lastRouteTarget);
        const target = current ? resolveExistingSnapShotTarget(current, routeThreadRef()) : null;
        // Creating a new draft would navigate the renderer before a self-capture finishes.
        if (target) {
          resolveSnapShotAttachmentTarget(questionPins, event.id, target, routeThreadRef());
          void resolveSnapShotDeliveryTarget(captureTargets, event.id, () =>
            Promise.resolve(target),
          );
        } else if (!questionPins.has(event.id)) {
          questionPins.set(event.id, null);
        }
        return;
      }
      case "started": {
        playCaptureSound(event.id);
        const target = resolveSnapShotDeliveryTarget(
          captureTargets,
          event.id,
          resolveCaptureTarget,
        ).then(
          (target) =>
            target &&
            resolveSnapShotAttachmentTarget(questionPins, event.id, target, routeThreadRef()),
        );
        if (
          getClientSettings().snapShotAnimations &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          void beginSnapShotAnimationWhenReady(event.id, target, pendingAnimationStarts);
        }
        return;
      }
      case "ready":
        void drain();
        return;
      case "failed": {
        if (event.id) {
          captureTargets.delete(event.id);
          questionPins.delete(event.id);
        }
        dismissFailedSnapShot(event.id, soundedCaptureIds, pendingAnimationStarts);
        void bridge.getSnapShotState().then((state) => {
          if (!getClientSettings().snapShotEnabled) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Snapshot failed",
              description: state.message ?? "Try the capture again.",
            }),
          );
        });
        return;
      }
      case "shortcut-changed":
        return;
    }
  };

  // Listens to the desktop only while captures are enabled; enabling drains what queued meanwhile.
  let stopEvents: (() => void) | null = null;
  const followEnabled = () => {
    const enabled = getClientSettings().snapShotEnabled;
    if (enabled && stopEvents === null) {
      stopEvents = bridge.onSnapShotEvent(handleSnapShotEvent);
      void drain();
    } else if (!enabled && stopEvents !== null) {
      stopEvents();
      stopEvents = null;
    }
  };

  const dismissOnBlur = () => {
    pendingAnimationStarts.clear();
    dismissAllSnapShotAnimations();
  };
  const drainOnFocus = () => void drain();
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") dismissOnBlur();
    else void drain();
  };

  const unsubscribeRoute = router.subscribe("onResolved", recordRouteTarget);
  const unsubscribeSettings = subscribeClientSettings(followEnabled);
  followEnabled();
  window.addEventListener("blur", dismissOnBlur);
  window.addEventListener("focus", drainOnFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    unsubscribeRoute();
    unsubscribeSettings();
    stopEvents?.();
    stopEvents = null;
    window.removeEventListener("blur", dismissOnBlur);
    window.removeEventListener("focus", drainOnFocus);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
