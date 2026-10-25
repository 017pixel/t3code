import type {
  DesktopPreviewColorScheme,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState, type UIEvent } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { cn, isMacPlatform } from "~/lib/utils";

import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { useActiveBrowserRecordingTabIds } from "./browserRecording";
import {
  browserViewportSettingKey,
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { acquireDesktopTab, withDesktopTab } from "./desktopTabLifetime";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { usePreviewWebviewConfig } from "./previewWebviewConfigState";
import { useBrowserLayoutZoomFactor } from "./useBrowserLayoutZoomFactor";
import { useBrowserViewportResize } from "./useBrowserViewportResize";
import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  type WebviewCrashRecoveryState,
} from "./webviewCrashRecovery";

interface ElectronWebview extends HTMLElement {
  src: string;
  partition: string;
  preload?: string;
  webpreferences?: string;
  getWebContentsId: () => number;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview;
  }
}

/**
 * Publishes where the guest is painted inside the wrapper. Reads the box this
 * render committed to the guest, so the panel, viewport, zoom, drag and scroll
 * changes that move it all report through here.
 */
function presentWebviewContent(runtimeTabId: string, wrapper: HTMLElement, webview: HTMLElement) {
  const { style } = webview;
  const scale = Number.parseFloat(style.scale) || 1;
  useBrowserSurfaceStore.getState().presentContent(runtimeTabId, {
    x: Number.parseFloat(style.left),
    y: Number.parseFloat(style.top),
    width: Number.parseFloat(style.width) * scale,
    height: Number.parseFloat(style.height) * scale,
    scale,
    scrollLeft: wrapper.scrollLeft,
    scrollTop: wrapper.scrollTop,
  });
}

export function HostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly pictureInPicture: boolean;
  /** Fixed for the tab lifetime; Electron reads partition before guest attachment. */
  readonly profileId: string | undefined;
  readonly zoomFactor: number;
  readonly serverDriven?: boolean;
  readonly serverRendering?: {
    readonly colorScheme: DesktopPreviewColorScheme;
    readonly zoomFactor: number;
  };
}) {
  const {
    threadRef,
    tabId,
    runtimeTabId,
    initialUrl,
    viewport,
    pictureInPicture,
    zoomFactor,
    profileId,
    serverDriven = false,
    serverRendering,
  } = props;
  const clientSettingsHydrated = useClientSettingsHydrated();
  const config = usePreviewWebviewConfig(threadRef.environmentId, profileId);
  const [initialSrc] = useState(() => initialUrl ?? "about:blank");
  const crashRecoveryRef = useRef<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[runtimeTabId];
      return {
        content: current?.content ?? null,
        cornerRadius: current?.cornerRadius ?? 0,
        fitSourceContent: current?.fitSourceContent ?? false,
        fittedSourceContent: current?.fittedSourceContent ?? null,
        rect: resolveBrowserSurfacePanelRect(state.byTabId, runtimeTabId),
        visible: current?.visible ?? false,
        zIndex: current?.zIndex ?? 30,
      };
    }),
  );
  const backgroundActivity = useBrowserSurfaceStore(
    (state) => (state.activityByTabId[runtimeTabId] ?? 0) > 0,
  );
  const recordingActive = useActiveBrowserRecordingTabIds().has(runtimeTabId);
  usePreviewBridge({ threadRef, tabId, runtimeTabId, serverDriven });

  const serverColorScheme = serverRendering?.colorScheme;
  const serverZoomFactor = serverRendering?.zoomFactor;

  useEffect(() => {
    if (!clientSettingsHydrated) return;
    crashRecoveryRef.current = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
    const lease = acquireDesktopTab(
      runtimeTabId,
      serverDriven ? { threadId: threadRef.threadId, tabId } : undefined,
    );
    return lease.release;
  }, [clientSettingsHydrated, runtimeTabId, serverDriven, tabId, threadRef.threadId]);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview;
    if (!bridge || serverColorScheme === undefined) return;
    withDesktopTab(runtimeTabId, () => bridge.setColorScheme(runtimeTabId, serverColorScheme));
  }, [runtimeTabId, serverColorScheme]);
  useEffect(() => {
    const bridge = window.desktopBridge?.preview;
    if (!bridge || serverZoomFactor === undefined) return;
    withDesktopTab(runtimeTabId, () => bridge.setZoomFactor(runtimeTabId, serverZoomFactor));
  }, [runtimeTabId, serverZoomFactor]);

  const [webviewGeneration, setWebviewGeneration] = useState(0);
  // A remounted guest reloads the page it crashed on, latched per generation so
  // later navigations do not reload the webview through its src.
  const [recovery, setRecovery] = useState({ generation: 0, src: initialSrc });
  if (recovery.generation !== webviewGeneration) {
    setRecovery({ generation: webviewGeneration, src: initialUrl ?? initialSrc });
  }

  // A crash recovery remounts the webview under a new key, so this runs once per guest element.
  const attachWebview = (node: HTMLElement | null) => {
    const webview = node as ElectronWebview | null;
    const wrapper = webview?.closest<HTMLElement>("[data-preview-viewport]");
    if (!webview || !wrapper) return;
    // The wrapper sizes the canvas and the guest's box carries the viewport and zoom,
    // so a resize of either is a new layout, which starts scrolled to its origin.
    const stopObservingLayout = observeResize([wrapper, webview], () => {
      wrapper.scrollTo({ left: 0, top: 0 });
      presentWebviewContent(runtimeTabId, wrapper, webview);
    });
    const bridge = previewBridge;
    if (!config || !bridge) return stopObservingLayout;
    // Its own reference to the main-process tab, so registration can wait for the
    // tab's creation instead of failing with PreviewTabNotFoundError on a fast
    // about:blank attachment.
    const lease = acquireDesktopTab(
      runtimeTabId,
      serverDriven ? { threadId: threadRef.threadId, tabId } : undefined,
    );
    let disposed = false;
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
    const register = () => {
      void (async () => {
        try {
          await lease.ready;
          if (disposed) return;
          const webContentsId = webview.getWebContentsId();
          if (Number.isInteger(webContentsId) && webContentsId > 0) {
            await bridge.registerWebview(runtimeTabId, webContentsId);
          }
        } catch {}
      })();
    };
    const recoverGuest = () => {
      if (disposed || recoveryTimeout !== null) return;
      const plan = planWebviewCrashRecovery(crashRecoveryRef.current, Date.now());
      if (!plan) return;
      crashRecoveryRef.current = plan.state;
      recoveryTimeout = setTimeout(() => {
        recoveryTimeout = null;
        if (!disposed) setWebviewGeneration((generation) => generation + 1);
      }, plan.delayMs);
    };
    // Guest clicks only emit focus here; replay pointerdown to dismiss host popups.
    const dismissHostPopups = () => {
      webview.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
      );
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    webview.addEventListener("render-process-gone", recoverGuest);
    webview.addEventListener("focus", dismissHostPopups);
    register();
    return () => {
      disposed = true;
      if (recoveryTimeout !== null) clearTimeout(recoveryTimeout);
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      webview.removeEventListener("render-process-gone", recoverGuest);
      webview.removeEventListener("focus", dismissHostPopups);
      lease.release();
      stopObservingLayout();
    };
  };

  const active = presentation.visible && presentation.rect !== null;
  const lastRect = presentation.rect;
  const layoutZoomFactor = useBrowserLayoutZoomFactor(zoomFactor);
  const viewportWidth = viewport._tag === "fill" ? null : viewport.width;
  const viewportHeight = viewport._tag === "fill" ? null : viewport.height;
  const viewportAspectRatio =
    viewportWidth === null || viewportHeight === null ? null : viewportWidth / viewportHeight;
  const lockedAspectRatio =
    aspectRatioLocked && viewportAspectRatio !== null ? viewportAspectRatio : null;
  const handleAspectRatioChange = (aspectRatio: number | null) => {
    setAspectRatioLocked(aspectRatio !== null);
  };
  const content = presentation.content;
  const hiddenWidth =
    viewport._tag !== "fill"
      ? viewport.width * layoutZoomFactor
      : content
        ? content.width / content.scale
        : (lastRect?.width ?? 1280);
  const hiddenHeight =
    viewport._tag !== "fill"
      ? viewport.height * layoutZoomFactor
      : content
        ? content.height / content.scale
        : (lastRect?.height ?? 800);
  const containerSize =
    active && lastRect ? lastRect : { width: hiddenWidth, height: hiddenHeight };
  const deviceToolbarVisible = active && viewport._tag !== "fill" && !presentation.fitSourceContent;
  const {
    activeDrag,
    attachFrame,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout: viewportLayout,
  } = useBrowserViewportResize({
    target: { threadRef, tabId, runtimeTabId },
    viewport,
    zoomFactor: layoutZoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio: lockedAspectRatio,
  });
  const fittedSourceViewport =
    presentation.fitSourceContent && lastRect
      ? resolveFittedBrowserViewport(viewport, presentation.fittedSourceContent, layoutZoomFactor)
      : null;
  const layout =
    fittedSourceViewport && lastRect
      ? resolveBrowserViewportLayout(lastRect, fittedSourceViewport, layoutZoomFactor)
      : viewportLayout;

  const handleWrapperScroll = (event: UIEvent<HTMLDivElement>) => {
    const webview = event.currentTarget.querySelector("webview");
    if (webview) presentWebviewContent(runtimeTabId, event.currentTarget, webview);
  };

  if (!clientSettingsHydrated || !config) return null;

  const renderingActive = active || backgroundActivity || pictureInPicture || recordingActive;
  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active,
    renderingActive,
    // Electron 43 can permanently blank a macOS webview after `visibility: hidden`.
    keepPaintableWhenInactive: isMacPlatform(navigator.platform),
    cornerRadius: presentation.cornerRadius,
    zIndex: presentation.zIndex,
    rect: lastRect,
    hiddenSize: { width: hiddenWidth, height: hiddenHeight },
  });

  return (
    <div
      className="fixed overflow-hidden bg-muted/35"
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      onScroll={handleWrapperScroll}
      data-preview-rendering={renderingActive ? "active" : "suspended"}
      data-preview-viewport={runtimeTabId}
    >
      <div
        ref={attachFrame}
        className="relative"
        style={{ width: layout.canvasWidth, height: layout.canvasHeight }}
      >
        {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
          <BrowserDeviceToolbar
            setting={effectiveViewport}
            width={Math.max(1, Math.round(active && lastRect ? lastRect.width : hiddenWidth))}
            aspectRatio={lockedAspectRatio}
            onAspectRatioChange={handleAspectRatioChange}
            onChange={commitViewportChange}
          />
        ) : null}
        <webview
          key={webviewGeneration}
          ref={attachWebview}
          // Electron needs allowpopups at attachment. React drops boolean values for unknown attributes.
          {...({ allowpopups: "true" } as unknown as { readonly allowpopups?: boolean })}
          src={recovery.src}
          partition={config.partition}
          webpreferences={config.webPreferences}
          {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
          data-preview-tab={runtimeTabId}
          data-preview-server-tab={tabId}
          data-preview-viewport-mode={effectiveViewport._tag}
          data-preview-viewport-key={browserViewportSettingKey(effectiveViewport)}
          data-preview-css-width={
            fittedSourceViewport
              ? fittedSourceViewport.width
              : effectiveViewport._tag === "fill"
                ? Math.max(1, Math.round(layout.viewportWidth / layoutZoomFactor))
                : effectiveViewport.width
          }
          data-preview-css-height={
            fittedSourceViewport
              ? fittedSourceViewport.height
              : effectiveViewport._tag === "fill"
                ? Math.max(1, Math.round(layout.viewportHeight / layoutZoomFactor))
                : effectiveViewport.height
          }
          aria-hidden={active ? undefined : true}
          className={cn(
            "absolute flex overflow-hidden bg-white",
            active && !layout.fillsPanel && "ring-1 ring-border/70 shadow-sm",
          )}
          style={{
            left: layout.viewportX,
            top: layout.viewportY,
            width: layout.viewportWidth / layout.viewportScale,
            height: layout.viewportHeight / layout.viewportScale,
            scale: layout.viewportScale < 1 ? String(layout.viewportScale) : undefined,
            transformOrigin: "top left",
          }}
        />
        {active && effectiveViewport._tag !== "fill" && !fittedSourceViewport ? (
          <>
            <BrowserViewportResizeHandles
              layout={layout}
              activeDirection={activeDrag?.direction ?? null}
              onPointerDown={handleResizePointerDown}
              onKeyDown={handleResizeKeyDown}
            />
            {activeDrag ? (
              <div
                className="pointer-events-none absolute z-40 -translate-x-1/2 rounded-md border border-border/80 bg-background/95 px-2 py-1 text-2xs font-medium tabular-nums text-foreground shadow-md backdrop-blur-sm"
                style={{
                  left: layout.viewportX + layout.viewportWidth / 2,
                  top: layout.viewportY + 10,
                }}
                aria-hidden="true"
              >
                {activeDrag.width} × {activeDrag.height}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
