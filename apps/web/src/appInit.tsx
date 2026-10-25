import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createBrowserHistory, createHashHistory } from "@tanstack/react-router";

import { applyAppearanceContrast } from "./appearanceContrast";
import { applyAppearanceFontVariables } from "./appearanceFonts";
import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "./branding";
import { resolveServerBackedAppDisplayName } from "./branding.logic";
import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { startBrowserProfileReporting } from "./browser/BrowserProfileReporter";
import { startElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { startIndexDraftStart } from "./components/indexDraftStart";
import { startNewThreadLinks } from "./components/promptLinks/openNewThreadLink";
import { startHostFreezeToasts } from "./components/HostFreezeToastCoordinator";
import { KeybindingsConfigWarning } from "./components/KeybindingsConfigWarning";
import { createKeybindingsUpdateToastController } from "./components/KeybindingsUpdateToast.logic";
import { startLegacyThreadMigrationToast } from "./components/LegacyThreadMigrationToast";
import { startPermissionUpdateNotices } from "./components/PermissionUpdateNotice";
import { startProjectCloneToasts } from "./components/ProjectCloneToastCoordinator";
import { startGuideRunNotifications } from "./components/pullRequest/guide/PullRequestGuideRunCoordinator";
import { installReopenClosedViewCommands } from "./components/ReopenClosedViewShortcut";
import { startSlowRpcRequestToasts } from "./components/SlowRpcRequestToastCoordinator";
import { startThreadNotifications } from "./components/ThreadNotificationCoordinator";
import { startDesktopUpdateLaunchNotice } from "./components/sidebar/updateEverythingRun";
import { startDesktopAppActivation } from "./components/desktop/DesktopAppActivationCoordinator";
import { startDesktopWebLinks } from "./components/desktop/DesktopWebLinkCoordinator";
import { startFirstRunGate, whileFirstRunAppOpen } from "./components/onboarding/firstRunGateStore";
import { startPreviewTitleRecording } from "./browserHistoryStore";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { isElectron } from "./env";
import { startDefaultThemeAdoption } from "./hooks/useDefaultTheme";
import { startEnvironmentThemeRepaint } from "./hooks/useEnvironmentTheme";
import {
  getClientSettings,
  startModelPreferencesMigration,
  subscribeClientSettings,
} from "./hooks/useSettings";
import { syncBrowserChromeTheme } from "./hooks/useTheme";
import { installDesktopPasteAsText } from "./lib/desktopPasteAsText";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "./logicalProject";
import { startProviderAuthDelivery } from "./providerAuthDelivery";
import { getRouter, type AppRouter } from "./router";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import { readProject } from "./state/entities";
import {
  primaryServerConfigAtom,
  primaryServerConfigEventAtom,
  primaryServerWelcomeAtom,
} from "./state/server";
import { environmentShell, liveShellEnvironmentIdsAtom } from "./state/shell";
import { environmentThreadShells } from "./state/threads";
import { useUiStateStore } from "./uiStateStore";

/** Writes appearance settings onto the document, touching only the groups that changed. */
function startClientAppearance(): void {
  const root = document.documentElement;
  let applied: ClientSettings | null = null;
  const apply = () => {
    const settings = getClientSettings();
    const previous = applied;
    applied = settings;
    if (previous?.diffColorScheme !== settings.diffColorScheme) {
      root.dataset.diffColorScheme = settings.diffColorScheme;
    }
    if (previous?.chatWidth !== settings.chatWidth) {
      root.dataset.chatWidth = settings.chatWidth;
    }
    if (previous?.appearanceContrast !== settings.appearanceContrast) {
      applyAppearanceContrast(root, settings.appearanceContrast);
    }
    if (previous?.glassOpacity !== settings.glassOpacity) {
      root.style.setProperty("--glass-opacity", `${settings.glassOpacity}%`);
      if (settings.glassOpacity === 100) {
        root.style.setProperty("--glass-blur", "0px");
      } else {
        root.style.removeProperty("--glass-blur");
      }
    }
    if (
      previous?.fontFamilySans !== settings.fontFamilySans ||
      previous.fontFamilyCode !== settings.fontFamilyCode ||
      previous.fontFamilyComposer !== settings.fontFamilyComposer ||
      previous.fontSizeInterface !== settings.fontSizeInterface ||
      previous.fontSizePrompt !== settings.fontSizePrompt ||
      previous.fontSizeCode !== settings.fontSizeCode ||
      previous.fontSmoothing !== settings.fontSmoothing
    ) {
      applyAppearanceFontVariables(root, {
        sans: settings.fontFamilySans,
        code: settings.fontFamilyCode,
        composer: settings.fontFamilyComposer,
        sizeInterface: settings.fontSizeInterface,
        sizePrompt: settings.fontSizePrompt,
        sizeCode: settings.fontSizeCode,
        smoothing: settings.fontSmoothing,
      });
    }
  };
  subscribeClientSettings(apply);
  apply();
}

function startDocumentTitle(): void {
  appAtomRegistry.subscribe(
    primaryServerConfigAtom,
    (config) => {
      document.title = resolveServerBackedAppDisplayName({
        baseName: APP_BASE_NAME,
        fallbackDisplayName: APP_DISPLAY_NAME,
        fallbackStageLabel: APP_STAGE_LABEL,
        primaryServerVersion: config?.environment.serverVersion ?? null,
      });
    },
    { immediate: true },
  );
}

/** Toasts each keybindings reload the primary server reports. */
function startKeybindingsUpdateToasts(): void {
  const controller = createKeybindingsUpdateToastController({});
  appAtomRegistry.subscribe(primaryServerConfigEventAtom, (event) => {
    const decision = controller.handle(event);
    if (!decision) return;

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    const serverConfig = appAtomRegistry.get(primaryServerConfigAtom);
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: (
          <KeybindingsConfigWarning
            message={decision.message}
            environmentId={appAtomRegistry.get(primaryEnvironmentIdAtom)}
            configPath={serverConfig?.keybindingsConfigPath ?? null}
            availableEditors={serverConfig?.availableEditors ?? []}
          />
        ),
      }),
    );
  });
}

/**
 * Opens the server's cwd bootstrap thread from home once the app is past the first-run gate,
 * so the welcome payload's navigation never races the gate's own redirect to /welcome.
 */
function startBootstrapNavigation(router: AppRouter): void {
  let handledBootstrapThreadId: string | null = null;
  // A visit to /welcome means the bootstrap already chose a route, so the first welcome
  // handled after it records its thread instead of navigating.
  let skipNextBootstrapNavigation = router.state.location.pathname === "/welcome";
  router.subscribe("onResolved", () => {
    if (router.state.location.pathname === "/welcome") skipNextBootstrapNavigation = true;
  });

  const handleWelcome = async (payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload?.bootstrapProjectId || !payload.bootstrapThreadId) return;
    const environmentId = payload.environment.environmentId;
    const projectRef = scopeProjectRef(environmentId, payload.bootstrapProjectId);
    const bootstrapProject = readProject(projectRef);
    const serverCwd = appAtomRegistry.get(primaryServerConfigAtom)?.cwd;
    const bootstrapProjectKey =
      (bootstrapProject
        ? deriveLogicalProjectKeyFromSettings(
            bootstrapProject,
            selectProjectGroupingSettings(getClientSettings()),
          )
        : null) ??
      (serverCwd ? derivePhysicalProjectKeyFromPath(environmentId, serverCwd) : null) ??
      scopedProjectKey(projectRef);
    useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

    if (router.state.location.pathname !== "/") return;
    if (skipNextBootstrapNavigation) {
      skipNextBootstrapNavigation = false;
      handledBootstrapThreadId = payload.bootstrapThreadId;
      return;
    }
    if (handledBootstrapThreadId === payload.bootstrapThreadId) return;
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: payload.bootstrapThreadId },
      replace: true,
    });
    handledBootstrapThreadId = payload.bootstrapThreadId;
  };

  whileFirstRunAppOpen(() =>
    appAtomRegistry.subscribe(
      primaryServerWelcomeAtom,
      (payload) => void handleWelcome(payload).catch(() => undefined),
      { immediate: true },
    ),
  );
}

function startComposerDraftServices(): void {
  subscribeComposerDraftModelReconciliation({
    registry: appAtomRegistry,
    threadShellAtom: environmentThreadShells.threadShellAtom,
    threadRefsAtom: environmentThreadShells.threadRefsAtom,
    shellStateAtom: environmentShell.stateAtom,
  });
}

function startRouteServices(router: AppRouter): void {
  installReopenClosedViewCommands(router);
  startIndexDraftStart(router);
  startNewThreadLinks(router);

  // Each route paints its own surface, which the browser chrome samples once it is on screen.
  // onRendered only fires for a new href; onResolved also covers `router.invalidate()`, which
  // can swap the root between the bare outlet and the shell at the same address.
  const resyncBrowserChrome = () => window.requestAnimationFrame(syncBrowserChromeTheme);
  router.subscribe("onRendered", resyncBrowserChrome);
  router.subscribe("onResolved", resyncBrowserChrome);
}

// Compat shim until the web-chat-view layer: services the base chat view and
// sidebar still run themselves are not started here yet.
/**
 * Starts every app-lifetime service once, before the first render, and returns the router.
 * They run for the life of the page, so their disposers (kept for tests) are dropped here.
 */
export function startAppServices(): AppRouter {
  // Ahead of the history: the provider auth code must leave the address before anything reads it.
  startProviderAuthDelivery();

  // Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
  const router = getRouter(isElectron ? createHashHistory() : createBrowserHistory());

  if (isElectron) {
    syncDocumentElectronPlatformClasses(navigator.platform);
    syncDocumentWindowControlsOverlayClass();
  }

  installDesktopPasteAsText(window.desktopBridge, window);
  startClientAppearance();
  startDocumentTitle();
  startEnvironmentThemeRepaint();
  startDefaultThemeAdoption();
  startModelPreferencesMigration();

  startComposerDraftServices();
  startPreviewTitleRecording();
  startBrowserProfileReporting();
  if (isElectron) startElectronBrowserHost();
  startRouteServices(router);
  startFirstRunGate(router);
  startBootstrapNavigation(router);
  if (isElectron) {
    startDesktopAppActivation(router);
    startDesktopWebLinks(router);
  }

  startKeybindingsUpdateToasts();
  startSlowRpcRequestToasts();
  startHostFreezeToasts();
  startLegacyThreadMigrationToast();
  startPermissionUpdateNotices(router);
  startProjectCloneToasts(router);
  startThreadNotifications(appAtomRegistry, router);
  startGuideRunNotifications(appAtomRegistry, router);
  if (isElectron) startDesktopUpdateLaunchNotice();

  return router;
}
