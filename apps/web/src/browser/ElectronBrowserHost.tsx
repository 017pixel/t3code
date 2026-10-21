import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DesktopPreviewOpenLinkEvent,
  FILL_PREVIEW_VIEWPORT,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type ComponentProps, useEffect, useEffectEvent, useState } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { isElectron } from "~/env";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { useDesktopHostedPreviewSessions } from "~/components/preview/usePreviewSession";
import { useActivePreviewSessions } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserDefaults } from "./browserDefaults";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { openUrlInPreview } from "./openFileInPreview";
import { acquireDesktopTab } from "./desktopTabLifetime";
import { hostsServerTabInBackground, rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

export function ElectronBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  useDesktopHostedPreviewSessions(primaryEnvironmentId);
  const activeSessions = Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef
      ? Object.values(previewState.sessions)
          .filter(
            (snapshot) =>
              snapshot.runtime !== "server" ||
              rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot) ||
              hostsServerTabInBackground(threadRef.environmentId, primaryEnvironmentId, snapshot),
          )
          .map((snapshot) => ({
            threadRef,
            snapshot,
            background: hostsServerTabInBackground(
              threadRef.environmentId,
              primaryEnvironmentId,
              snapshot,
            ),
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
          }))
      : [];
  });
  // Electron destroys a moved webview's guest, so the render order must not follow the server's
  // updatedAt order. Any fixed order works; this one is not a display order.
  const sessions = activeSessions.toSorted((left, right) =>
    left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
  );

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const onOpenLink = useEffectEvent(({ tabId, url, background }: DesktopPreviewOpenLinkEvent) => {
    const source = sessions.find((session) => session.runtimeTabId === tabId);
    if (!source) return;
    void openUrlInPreview({
      threadRef: source.threadRef,
      url,
      openPreview,
      profileId: source.snapshot.profileId,
      background,
    });
  });
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onOpenLink(onOpenLink);
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(
        ({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor, background }) => {
          const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
          if (background) {
            return (
              <BackgroundBrowserTab
                key={runtimeTabId}
                threadRef={threadRef}
                tabId={snapshot.tabId}
                runtimeTabId={runtimeTabId}
                initialUrl={url}
                profileId={snapshot.profileId}
              />
            );
          }
          return (
            <AuthorizedBrowserWebview
              key={runtimeTabId}
              threadRef={threadRef}
              tabId={snapshot.tabId}
              runtimeTabId={runtimeTabId}
              initialUrl={url}
              viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
              pictureInPicture={pictureInPicture}
              profileId={snapshot.profileId}
              zoomFactor={zoomFactor}
              serverDriven={snapshot.runtime === "server"}
              {...(snapshot.runtime === "server"
                ? {
                    serverRendering: {
                      colorScheme: snapshot.colorScheme ?? "system",
                      zoomFactor: snapshot.zoomFactor ?? 1,
                    },
                  }
                : {})}
            />
          );
        },
      )}
    </div>
  );
}

/** Holds the desktop tab open in its own window; the panel streams it from the server. */
function BackgroundBrowserTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly profileId: string | undefined;
}) {
  const { tabId, runtimeTabId } = props;
  const { environmentId, threadId } = props.threadRef;
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const profileId = useTabProfileId(props.profileId);
  const hydrated = useClientSettingsHydrated();
  // Fixed at creation, like a webview's partition and first URL.
  const [initialUrl] = useState(props.initialUrl);
  useEffect(() => {
    if (!canOperatePreview || !hydrated) return;
    const lease = acquireDesktopTab(
      runtimeTabId,
      { threadId, tabId },
      {
        environmentId,
        ...(profileId === undefined ? {} : { profileId }),
        ...(initialUrl === null ? {} : { url: initialUrl }),
      },
    );
    return lease.release;
  }, [
    canOperatePreview,
    hydrated,
    environmentId,
    threadId,
    tabId,
    runtimeTabId,
    profileId,
    initialUrl,
  ]);
  return null;
}

function AuthorizedBrowserWebview(props: ComponentProps<typeof HostedBrowserWebview>) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  const profileId = useTabProfileId(props.profileId);
  return canOperatePreview ? <HostedBrowserWebview {...props} profileId={profileId} /> : null;
}

/**
 * It is latched once settings load: Electron fixes the partition when the guest attaches, so a
 * later settings change must not move a live tab.
 */
function useTabProfileId(profileId: string | undefined): string | undefined {
  const hydrated = useClientSettingsHydrated();
  const defaultProfileId = useBrowserDefaults().profileId;
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  if (profileId === undefined && hydrated && fallback === undefined) {
    setFallback(defaultProfileId);
  }
  return profileId ?? fallback;
}
