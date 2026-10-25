import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act } from "../../test/render";

const state = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  workspaceAvailable: true,
  navigate: vi.fn(),
  openPreview: vi.fn(),
  setShortcuts: vi.fn(async () => undefined),
  toast: vi.fn(),
}));

// No original spread: it pulls in settings and the theme library, which import the mocked
// server state while its factory is still resolving.
vi.mock(import("./preview/openPreviewSession"), () => ({
  openPreviewSession: state.openPreview as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) };
});
vi.mock(import("../connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map([["remote", {}]]) }) as never,
    },
  };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const live = Atom.make({ status: "live" });
  return {
    ...actual,
    environmentShell: { ...actual.environmentShell, stateValueAtom: (() => live) as never },
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ projectId: "project-1", worktreePath: null })) as never,
  readProject: (() =>
    state.workspaceAvailable ? { workspaceRoot: "/work/project" } : null) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { useClosedViewStore } from "../closedViewStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { dispatchMenuAction } from "../shortcuts/dispatcher";
import { installReopenClosedViewCommands } from "./ReopenClosedViewShortcut";

const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
const snapshot = {
  threadId: ref.threadId,
  tabId: "closed-tab",
  navStatus: { _tag: "Success", url: "https://example.com", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-22T12:00:00.000Z",
} as const;
function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    params: {},
    workspaceAvailable: true,
  });
  state.navigate.mockResolvedValue(undefined);
  state.openPreview.mockReset();
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
}

const menuAction = (action: string) => dispatchMenuAction(action);

async function installShortcut() {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64"));
  window.desktopBridge = {
    preview: { setForwardedShortcuts: state.setShortcuts },
    onMenuAction: () => () => {},
  } as unknown as NonNullable<typeof window.desktopBridge>;
  stack.defer(() => {
    delete window.desktopBridge;
  });
  const router = {
    state: {
      get matches() {
        return [{ params: state.params }];
      },
    },
    navigate: state.navigate,
    subscribe: () => () => {},
  } as unknown as AnyRouter;
  stack.defer(installReopenClosedViewCommands(router));
  const environment = stack.move();
  return {
    /** Attaches an element to the document until the test ends. */
    append(element: HTMLElement) {
      document.body.append(element);
      environment.defer(() => element.remove());
      return element;
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

function press(target: Element = document.body) {
  const event = new KeyboardEvent("keydown", {
    key: "T",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("root reopen shortcut", () => {
  it("serializes deliberate presses while a browser restore waits for RPC", async () => {
    setup();
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "files", id: "files" } });
    useClosedViewStore.getState().remember({ kind: "browser", threadRef: ref, snapshot });
    let finish!: (value: ReturnType<typeof AsyncResult.success>) => void;
    state.openPreview.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await using _view = await installShortcut();
    await act(() => {
      press();
      press();
    });
    expect(state.openPreview).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
    await act(() => {
      finish(AsyncResult.success({ tabId: "new-tab" }));
    });
    expect(state.navigate).toHaveBeenCalledTimes(2);
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("does not create a second browser when navigation fails after restoring it", async () => {
    setup();
    const store = useClosedViewStore.getState();
    const older = store.remember({
      kind: "panel-tab",
      threadRef: ref,
      surface: { kind: "diff", id: "diff" },
    });
    store.remember({ kind: "browser", threadRef: ref, snapshot });
    state.openPreview.mockResolvedValue(AsyncResult.success({ tabId: "new-tab" }));
    state.navigate.mockRejectedValueOnce(new Error("navigation failed"));
    await using _view = await installShortcut();
    await act(() => {
      press();
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("browser:new-tab");
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not reopen view" }),
    );
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([older]);
    await act(() => {
      menuAction("view.reopenClosed");
    });
    expect(state.openPreview).toHaveBeenCalledOnce();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("reopens from a focused widget that consumes the chord itself", async () => {
    setup();
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    await using view = await installShortcut();
    // Stands in for the terminal surface, which encodes Ctrl+Shift+T and stops propagation.
    const terminalInput = view.append(document.createElement("textarea"));
    const terminalReceived = vi.fn();
    terminalInput.addEventListener("keydown", (event) => {
      terminalReceived();
      event.stopPropagation();
    });
    terminalInput.focus();
    await act(() => {
      press(terminalInput);
    });
    expect(terminalReceived).not.toHaveBeenCalled();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it.each(["files", "file", "browser"] as const)(
    "keeps a failed %s restore retryable without blocking older history",
    async (kind) => {
      setup();
      const store = useClosedViewStore.getState();
      const older = store.remember({
        kind: "panel-tab",
        threadRef: ref,
        surface: { kind: "diff", id: "diff" },
      });
      const failed = store.remember(
        kind === "browser"
          ? { kind: "browser", threadRef: ref, snapshot }
          : {
              kind: "panel-tab",
              threadRef: ref,
              surface:
                kind === "files"
                  ? { kind: "files", id: "files" }
                  : {
                      kind: "file",
                      id: "file:src/app.ts",
                      relativePath: "src/app.ts",
                      revealLine: null,
                      revealRequestId: 0,
                    },
            },
      );
      state.workspaceAvailable = false;
      state.openPreview.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
      await using _view = await installShortcut();
      await act(() => {
        press();
      });
      expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([
        older,
        failed,
      ]);
      expect(state.navigate).not.toHaveBeenCalled();
      await act(() => {
        menuAction("view.reopenClosed");
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
      ).toBe("diff");
      expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([failed]);
      state.workspaceAvailable = true;
      state.openPreview.mockResolvedValue(AsyncResult.success({ ...snapshot, tabId: "new-tab" }));
      await act(() => {
        press();
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
      ).toBe(
        kind === "browser" ? "browser:new-tab" : kind === "file" ? "file:src/app.ts" : "files",
      );
      expect(useClosedViewStore.getState().entries).toEqual([]);
    },
  );
});
