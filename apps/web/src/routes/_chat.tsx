import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AuthPreviewOperateScope, type ServerConfig } from "@t3tools/contracts";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { registerChatSurface } from "../components/chatSurfaceSlot";
import { KeptChatSurface } from "../components/ThreadRouteView";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects, waitForProject } from "../state/entities";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentSession, useEnvironmentScope } from "../state/session";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread, useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  clearPendingLandingDraft,
  readPendingLandingDraft,
  usePendingLandingDraft,
} from "../bootLanding";
import { environmentCatalog } from "../connection/catalog";
import { useScratchProject } from "../hooks/useScratchProject";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { liveServerConfigValueAtom, primaryServerKeybindingsAtom } from "~/state/server";
import { useComposerDraftStore } from "../composerDraftStore";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const canOperatePreview = useEnvironmentScope(
    routeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (command === "thread.undo") {
        if (event.repeat || isModelPickerOpen()) return;
        if (undoLatestThreadAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.newWithoutProject") {
        const environmentId = scratchEnvironmentId(
          activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
        );
        if (environmentId === null) return;
        event.preventDefault();
        event.stopPropagation();
        void startScratchThread(environmentId);
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // The default sidebar routes creation through the command palette
        // whenever there is a real choice to make; the legacy sidebar (and
        // single-project setups) keep the immediate contextual create.
        if (!legacySidebarEnabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef || (!canOperatePreview && !previewOpen)) return;
        if (!isPreviewAvailableFor(routeThreadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!canOperatePreview) return;
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    canOperatePreview,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    primaryEnvironmentId,
    projectGroupCount,
    routeThreadRef,
    scratchEnvironmentId,
    selectedThreadKeysSize,
    startScratchThread,
    legacySidebarEnabled,
    terminalOpen,
  ]);

  return null;
}

/** Applies the server's defaults to a draft the index route opened early. */
function LandingDraftDefaults() {
  const landing = usePendingLandingDraft();
  const handleNewThread = useNewThreadHandler();
  // Load balancing can move the draft to another machine of its project
  // before the defaults land; they come from, and go to, wherever it is now.
  const draft = useComposerDraftStore((store) =>
    landing === null ? null : store.getDraftSession(landing.draftId),
  );
  const projectRef = useMemo(
    () =>
      landing === null
        ? null
        : draft === null
          ? landing.projectRef
          : scopeProjectRef(draft.environmentId, draft.projectId),
    [draft, landing],
  );
  // A machine the user picked stands, and the draft stops waiting on any.
  const movedByUser =
    draft !== null &&
    draft.environmentSelection === "manual" &&
    projectRef !== null &&
    landing !== null &&
    (projectRef.environmentId !== landing.projectRef.environmentId ||
      projectRef.projectId !== landing.projectRef.projectId);
  // Waits for the server to answer this session; the live config then also
  // carries any change made since, for a landing that runs after boot.
  const sessionConfig = useAtomValue(
    projectRef === null
      ? NO_LIVE_CONFIG_ATOM
      : environmentSession.initialConfigValueAtom(projectRef.environmentId),
  );
  const currentConfig = useAtomValue(liveServerConfigValueAtom(projectRef?.environmentId ?? null));
  const liveConfig = sessionConfig === null ? null : (currentConfig ?? sessionConfig);
  // One run per place the draft sits: load balancing can move it during one.
  const startedRef = useRef<string | null>(null);
  // The snapshot can name an environment this browser has since removed. Its
  // config never arrives, so the draft stops waiting for it and reports the
  // environment as unavailable instead of connecting forever.
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const landingEnvironmentGone =
    projectRef !== null && catalog.isReady && !catalog.entries.has(projectRef.environmentId);
  const dropLanding = landingEnvironmentGone || movedByUser;
  useEffect(() => {
    if (landing !== null && dropLanding) clearPendingLandingDraft(landing.draftId);
  }, [dropLanding, landing]);
  useEffect(() => {
    if (landing === null || projectRef === null || liveConfig === null || dropLanding) return;
    const startedKey = `${landing.draftId} ${projectRef.environmentId} ${projectRef.projectId}`;
    if (startedRef.current === startedKey) return;
    startedRef.current = startedKey;
    // A machine the draft moved to can answer before its projects arrive, and
    // the defaults need the project. The screen may still show the snapshot's
    // settings; the defaults use the server's.
    void waitForProject(projectRef)
      .catch(() => undefined)
      .then(() =>
        readPendingLandingDraft() === landing
          ? handleNewThread(projectRef, {
              replace: true,
              landing,
              serverSettings: liveConfig.settings,
            })
          : null,
      )
      .catch(() => undefined)
      .finally(() => {
        // Moved meanwhile: the run for where it went clears the landing.
        const draftNow = useComposerDraftStore.getState().getDraftSession(landing.draftId);
        if (
          draftNow !== null &&
          (draftNow.environmentId !== projectRef.environmentId ||
            draftNow.projectId !== projectRef.projectId)
        ) {
          return;
        }
        clearPendingLandingDraft(landing.draftId);
      });
  }, [dropLanding, handleNewThread, landing, liveConfig, projectRef]);
  return null;
}

const NO_LIVE_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("web-landing-no-live-config"),
);

function ChatRouteLayout() {
  // The thread routes render nothing here: the root layout hosts their view
  // (see KeptChatSurface) so it outlives the route swaps around it.
  useLayoutEffect(() => registerChatSurface(<KeptChatSurface />), []);
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <LandingDraftDefaults />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
