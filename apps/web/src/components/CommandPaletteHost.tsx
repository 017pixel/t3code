import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  COMMAND_PALETTE_ELEMENT_ID,
  onOpenCommandPalette,
  setCommandPaletteRequested,
} from "../commandPaletteBus";
import { ComposerHandleContext } from "../composerHandleContext";
import { useTheme } from "../hooks/useTheme";
import { resolveShortcutCommand } from "../keybindings";
import { preloadAfterComposer } from "../lib/loadableComponent";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform } from "../lib/utils";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { reduceCommandPaletteUiState, type SearchOverlayMode } from "./CommandPalette.logic";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import {
  commandPaletteSurface,
  diffPanelSurface,
  filePreviewSurface,
  preloadTerminalDrawer,
} from "./lazySurfaces";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";

// Keep palette views out of the startup graph; close on a failed load.
function CommandPaletteUnavailable({ onUnavailable }: { onUnavailable: () => void }) {
  useEffect(() => onUnavailable(), [onUnavailable]);
  return null;
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

/** Whether the requested view has rendered its text input, which then takes the keys. */
function paletteTextInputMounted(mode: SearchOverlayMode): boolean {
  const palette = document.getElementById(COMMAND_PALETTE_ELEMENT_ID);
  return (
    palette?.dataset.paletteMode === mode &&
    palette.querySelector("input, textarea, [contenteditable='true']") != null
  );
}

/** Option on macOS and AltGr elsewhere can type characters. */
function typedText(event: globalThis.KeyboardEvent): string | null {
  if ([...event.key].length !== 1 || event.metaKey) return null;
  const altGraph = event.getModifierState("AltGraph");
  if (event.ctrlKey && !altGraph) return null;
  if (event.altKey && !altGraph && !isMacPlatform(navigator.platform)) return null;
  return event.key;
}

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

export const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

export function CommandPaletteHost({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const requestedModeRef = useRef<SearchOverlayMode>("command");
  useLayoutEffect(() => {
    requestedModeRef.current = state.mode;
  }, [state.mode]);
  // Stays mounted after the first open so closing still animates out.
  const [CommandPaletteDialog, setCommandPaletteDialog] = useState<
    typeof commandPaletteSurface.Component | null
  >(null);
  if (state.open && CommandPaletteDialog === null) {
    setCommandPaletteDialog(() => commandPaletteSurface.Component);
  }
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const closeUnavailablePalette = useCallback(() => {
    setCommandPaletteDialog(null);
    setOpen(false);
  }, [setOpen]);
  const toggleMode = useCallback((mode: SearchOverlayMode) => {
    // Keys can arrive before React replaces the old mode's focused input.
    requestedModeRef.current = mode;
    dispatch({ _tag: "ToggleMode", mode });
  }, []);
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, appearanceMode, setAppearanceMode } = useTheme();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  // Block background shortcuts while the palette's chunk loads too.
  useLayoutEffect(() => {
    setCommandPaletteRequested(state.open);
    return () => setCommandPaletteRequested(false);
  }, [state.open]);

  useEffect(
    () =>
      preloadAfterComposer([
        commandPaletteSurface.preload,
        preloadTerminalDrawer,
        () => router.preloadRoute({ to: "/settings/general" }),
        diffPanelSurface.preload,
        filePreviewSurface.preload,
      ]),
    [router],
  );
  useEffect(() => {
    const onModifier = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") void commandPaletteSurface.preload();
    };
    window.addEventListener("keydown", onModifier, true);
    return () => window.removeEventListener("keydown", onModifier, true);
  }, []);

  // Buffer typing while lazy views load; file/content search handle their own Escape.
  const loadingQuery =
    state.openIntent === null
      ? ""
      : state.openIntent.kind === "search"
        ? state.openIntent.query
        : null;
  useLayoutEffect(() => {
    if (!state.open || loadingQuery === null) return;
    let query = loadingQuery;
    let queryMode = state.mode;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const mode = requestedModeRef.current;
      if (paletteTextInputMounted(mode) || event.isComposing) return;
      if (queryMode !== mode) {
        queryMode = mode;
        query = "";
      }
      const text = typedText(event);
      if (text === null && event.key !== "Backspace" && event.key !== "Escape") return;
      if (event.key === "Escape") {
        if (mode !== "command") return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const palette = document.getElementById(COMMAND_PALETTE_ELEMENT_ID);
      // Replacement views can carry an initial query while waiting for focus.
      if (query === "" && palette?.dataset.paletteMode === mode) {
        query = palette.querySelector<HTMLInputElement>('input[role="combobox"]')?.value ?? "";
      }
      query = text === null ? query.slice(0, -1) : query + text;
      dispatch({ _tag: "TypeAhead", query });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [loadingQuery, setOpen, state.mode, state.open]);

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: composerHandleRef.current?.isModelPickerOpen() ?? false,
        },
      });
      if (command === "appearance.cycle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
        } else {
          toastManager.add({
            id: "appearance-cycle",
            title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
            timeout: 1500,
          });
        }
        return;
      }
      if (command === "theme.select") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        dispatch({ _tag: "OpenChangeTheme" });
        return;
      }
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command === "usage.open") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate({ to: "/usage" });
        return;
      }
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    appearanceMode,
    keybindings,
    navigate,
    previewOpen,
    resolvedTheme,
    setAppearanceMode,
    setOpen,
    terminalOpen,
    theme,
    themeHalves,
    toggleMode,
  ]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else if (detail.query !== undefined) {
          dispatch({
            _tag: "OpenSearch",
            query: detail.query,
            ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
          });
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {/* Block background focus calls for the entire time the palette is open. */}
        <div className="contents" inert={state.open}>
          {children}
        </div>
        {CommandPaletteDialog ? (
          <RenderErrorBoundary
            fallback={<CommandPaletteUnavailable onUnavailable={closeUnavailablePalette} />}
          >
            <CommandDialogPopup
              aria-label={
                state.mode === "files"
                  ? "File picker"
                  : state.mode === "content"
                    ? "Search project contents"
                    : "Command palette"
              }
              className={cn("overflow-hidden", state.mode === "content" && "h-105")}
              id={COMMAND_PALETTE_ELEMENT_ID}
              data-command-palette="true"
              data-palette-mode={state.mode}
              data-testid="command-palette"
              finalFocus={() => {
                composerHandleRef.current?.focusAtEnd();
                return false;
              }}
              onBackdropPointerDown={() => setOpen(false)}
            >
              <Suspense fallback={null}>
                <CommandPaletteDialog
                  mode={state.mode}
                  openIntent={state.openIntent}
                  setOpen={setOpen}
                  openOverlayMode={toggleMode}
                  clearOpenIntent={clearOpenIntent}
                />
              </Suspense>
            </CommandDialogPopup>
          </RenderErrorBoundary>
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}
