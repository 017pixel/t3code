import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import type { OpenPreviewMutation } from "../browser/openFileInPreview";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClosedViewStore } from "../closedViewStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { effectiveShortcutsForCommand } from "../keybindings";
import {
  planNextReopen,
  pullRequestsSearchForRestore,
  reopenClosedView,
} from "../reopenClosedView";
import {
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanel,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { toastManager } from "./ui/toast";

const PREVIEW_FORWARDED_LAYOUT_COMMANDS = [
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
] as const;

const isGlobalPullRequests = (ref: ScopedThreadRef) =>
  scopedThreadKey(ref) === scopedThreadKey(PULL_REQUESTS_PANEL_REF);

function readRouteThreadRef(router: AnyRouter): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (target?.kind === "server") return target.threadRef;
  if (target?.kind !== "draft") return null;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId)) : null;
}

const readTerminalOpen = (threadRef: ScopedThreadRef | null) =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  ).terminalOpen;

const openPreview: OpenPreviewMutation = (input) =>
  runAtomCommand(appAtomRegistry, previewEnvironment.open, input);

async function reopenNext(router: AnyRouter) {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  const drafts = useComposerDraftStore.getState();
  const panelsByThread = useRightPanelStore.getState().byThreadKey;
  const { drop, restore } = planNextReopen(useClosedViewStore.getState().entries, (entry) => {
    const ref = entry.threadRef;
    const panel = selectThreadRightPanelState(panelsByThread, ref);
    if (isGlobalPullRequests(ref)) {
      return {
        environmentKnown: true,
        catalogReady: true,
        ownerExists: true,
        shellLive: true,
        panel,
      };
    }
    return {
      environmentKnown: catalog.entries.has(ref.environmentId),
      catalogReady: catalog.isReady,
      ownerExists: readThreadShell(ref) !== null || drafts.getDraftThreadByRef(ref) !== null,
      shellLive:
        appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live",
      panel,
    };
  });
  for (const entry of drop) useClosedViewStore.getState().remove(entry.id);
  if (!restore) return;

  const ref = restore.threadRef;
  const globalPullRequests = isGlobalPullRequests(ref);
  const thread = globalPullRequests ? null : readThreadShell(ref);
  const owner = thread ?? drafts.getDraftThreadByRef(ref);
  const project = owner ? readProject(scopeProjectRef(ref.environmentId, owner.projectId)) : null;
  if (!(await reopenClosedView(restore, { openPreview, workspaceAvailable: project !== null }))) {
    useClosedViewStore.getState().defer(restore.id);
    return;
  }
  useClosedViewStore.getState().remove(restore.id);
  if (globalPullRequests) {
    const selected = selectSelectedRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      ref,
    );
    await router.navigate({
      to: "/pull-requests",
      search: (previous: Record<string, unknown>) =>
        pullRequestsSearchForRestore(previous, selected),
    });
  } else {
    const draftId = thread === null ? drafts.getDraftIdByRef(ref) : null;
    if (draftId !== null)
      await router.navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
      });
    else
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
  }
}

/**
 * A focused browser page is a separate process, so these chords never reach the app's
 * keydown listener. The desktop claims them in the guest and sends each command back as a
 * menu action.
 */
function startForwardedPreviewShortcuts(router: AnyRouter): () => void {
  const preview = window.desktopBridge?.preview;
  if (!preview?.setForwardedShortcuts) return () => {};
  // The composer draft store changes on every keystroke, so bail before expanding shortcuts
  // unless an input to them changed.
  let lastInputs: {
    keybindings: ResolvedKeybindingsConfig;
    terminalOpen: boolean;
    hasHistory: boolean;
  } | null = null;
  let lastSignature: string | null = null;

  const sync = () => {
    const keybindings = appAtomRegistry.get(primaryServerKeybindingsAtom);
    const terminalOpen = readTerminalOpen(readRouteThreadRef(router));
    const hasHistory = useClosedViewStore.getState().entries.length > 0;
    if (
      lastInputs?.keybindings === keybindings &&
      lastInputs.terminalOpen === terminalOpen &&
      lastInputs.hasHistory === hasHistory
    ) {
      return;
    }
    lastInputs = { keybindings, terminalOpen, hasHistory };
    const options = {
      context: {
        previewFocus: true,
        previewOpen: true,
        terminalFocus: false,
        terminalOpen,
        editableFocus: false,
        modelPickerOpen: false,
        isDesktop: true,
        isWeb: false,
      },
    };
    const commands = [
      ...(hasHistory ? (["view.reopenClosed"] as const) : []),
      ...PREVIEW_FORWARDED_LAYOUT_COMMANDS,
    ];
    const shortcuts = commands.flatMap((command) =>
      effectiveShortcutsForCommand(keybindings, command, options).map((shortcut) => ({
        command,
        shortcut,
      })),
    );
    const signature = JSON.stringify(shortcuts);
    if (signature === lastSignature) return;
    lastSignature = signature;
    void preview.setForwardedShortcuts?.(shortcuts).catch(() => undefined);
  };

  const unsubscribes = [
    appAtomRegistry.subscribe(primaryServerKeybindingsAtom, sync),
    useClosedViewStore.subscribe(sync),
    useTerminalUiStateStore.subscribe(sync),
    useComposerDraftStore.subscribe(sync),
    router.subscribe("onResolved", sync),
  ];
  sync();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    void preview.setForwardedShortcuts?.([]).catch(() => undefined);
  };
}

/** Reopen-closed-view from the keyboard and the desktop menu, one restore at a time. */
export function installReopenClosedViewCommands(router: AnyRouter): () => void {
  let pending = Promise.resolve();
  const enqueueReopen = () => {
    pending = pending
      .then(() => reopenNext(router))
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not reopen view",
          description: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const unregisterCommands = registerCommands(
    {
      "view.reopenClosed": (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) enqueueReopen();
      },
    },
    {
      capture: true,
      when: (event) =>
        !isCommandPaletteOpen() &&
        useClosedViewStore.getState().entries.length > 0 &&
        !(event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]")),
      context: () => {
        const threadRef = readRouteThreadRef(router);
        return {
          terminalOpen: readTerminalOpen(threadRef),
          previewOpen:
            selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) ===
            "preview",
        };
      },
    },
  );
  const unregisterMenuAction = registerMenuAction("view.reopenClosed", () => {
    if (!isCommandPaletteOpen()) enqueueReopen();
  });
  const stopForwardedShortcuts = startForwardedPreviewShortcuts(router);
  return () => {
    unregisterCommands();
    unregisterMenuAction();
    stopForwardedShortcuts();
  };
}
