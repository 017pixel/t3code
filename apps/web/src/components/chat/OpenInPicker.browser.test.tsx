import { AuthOrchestrationOperateScope, EnvironmentId, type EditorId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRemoteCapableEditors, type RemoteOpenState } from "../../remoteOpen";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  remote: { mode: "local-exec" } as RemoteOpenState,
  clientEditors: ["vscode"] as readonly EditorId[],
  run: vi.fn(),
  openUrl: vi.fn(),
  setPreferred: vi.fn(),
  markHintSeen: vi.fn(),
  listeners: new Set<() => void>(),
}));

vi.mock(import("../../state/session"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId);
  return {
    ...(await importOriginal()),
    readEnvironmentScope: readEnvironmentScope as never,
    useEnvironmentScope: ((environmentId: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(environmentId, scope),
      )) as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({ label: "Test host" })) as never,
}));
vi.mock(import("../../editorPreferences"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    usePreferredEditor: (available: readonly EditorId[]) => {
      const [preferred, setPreferred] = actual.usePreferredEditor(available);
      const recordPreferred: typeof setPreferred = (editor) => {
        state.setPreferred(editor);
        setPreferred(editor);
      };
      return [preferred, recordPreferred] as const;
    },
  };
});
vi.mock(import("../../remoteOpen"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRemoteOpenState: () => state.remote,
  useRemoteCapableEditors: vi.fn(() => state.clientEditors),
  useRemoteOpenHint: () => [false, state.markHintSeen] as const,
  openRemoteEditorUrl: state.openUrl,
}));

import { OpenInPicker } from "./OpenInPicker";
import { useOpenFavoriteEditorShortcut } from "./OpenInPickerShortcut";

const primary = EnvironmentId.make("primary");
const selected = EnvironmentId.make("selected");
const editors: readonly EditorId[] = ["vscode"];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  state.allowed.clear();
  state.remote = { mode: "local-exec" };
  state.clientEditors = editors;
  vi.mocked(useRemoteCapableEditors).mockImplementation(() => state.clientEditors);
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openUrl.mockReset().mockResolvedValue(true);
  state.setPreferred.mockReset();
  state.markHintSeen.mockReset();
  state.listeners.clear();
  window.localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderPicker(
  availableEditors: readonly EditorId[] = editors,
  panel = false,
  { openInCwd = "/work/project", revealFileManager = false } = {},
) {
  await act(async () => {
    for (const listener of state.listeners) listener();
    const node = (
      <OpenInPicker
        environmentId={selected}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        availableEditors={availableEditors}
        openInCwd={openInCwd}
        revealFileManager={revealFileManager}
        displayMode={panel ? "panel" : "toolbar"}
        compact={!panel}
      />
    );
    root.render(node);
  });
}

function ChatEditorShortcut({ panelMounted }: { panelMounted: boolean }) {
  const props = {
    environmentId: selected,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    availableEditors: editors,
    openInCwd: "/work/project",
  };
  useOpenFavoriteEditorShortcut({ ...props, enabled: true });
  return panelMounted ? (
    <OpenInPicker {...props} displayMode="panel" enableShortcut={false} />
  ) : null;
}

function byLabel(label: string) {
  const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
}

const primaryButton = () => byLabel("Open file in preferred editor");
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function pressOpenFavorite() {
  const event = new KeyboardEvent("keydown", {
    key: "o",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => document.body.dispatchEvent(event));
  return event;
}

it.each(["local-exec", "remote-links"] as const)(
  "selects the preferred editor without launching a %s workspace",
  async (mode) => {
    state.allowed.add(selected);
    state.clientEditors = ["cursor", "vscode"];
    state.remote =
      mode === "local-exec" ? { mode } : { mode, host: { kind: "ssh-alias", host: "test-host" } };
    await renderPicker(["cursor", "vscode"], true);
    byLabel("Open in Cursor");
    await click(byLabel("Choose editor"));
    await click(menuItems().find((item) => item.textContent?.includes("VS Code"))!);
    expect(window.localStorage.getItem("t3code:last-editor")).toBe('"vscode"');
    const openButton = byLabel("Open in VS Code");
    expect(state.run).not.toHaveBeenCalled();
    expect(state.openUrl).not.toHaveBeenCalled();

    await click(openButton);
    if (mode === "local-exec") {
      expect(state.run).toHaveBeenCalledExactlyOnceWith({
        environmentId: selected,
        input: { cwd: "/work/project", editor: "vscode" },
      });
    } else {
      expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
        "vscode://vscode-remote/ssh-remote+test-host/work/project",
      );
    }
  },
);

describe("host editor access", () => {
  it("rechecks the selected grant for the global shortcut while the panel is hidden", async () => {
    state.allowed.add(selected);
    await act(async () => root.render(<ChatEditorShortcut panelMounted={false} />));
    state.allowed.delete(selected);
    state.allowed.add(primary);
    await pressOpenFavorite();
    expect.soft(state.run).not.toHaveBeenCalled();

    state.run.mockClear();
    state.allowed.add(selected);
    await pressOpenFavorite();
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: { cwd: "/work/project", editor: "vscode" },
    });
    expect(state.openUrl).not.toHaveBeenCalled();
  });

  it("uses the selected grant for both the button and a retained shortcut", async () => {
    state.allowed.add(selected);
    await renderPicker();
    // Revoke without rerendering: the mounted button and shortcut must re-check the grant.
    state.allowed.delete(selected);
    state.allowed.add(primary);
    await click(primaryButton());
    const event = await pressOpenFavorite();
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    await renderPicker();
    expect(primaryButton().disabled).toBe(true);
    expect(byLabel("Choose editor").disabled).toBe(true);
    expect((await pressOpenFavorite()).defaultPrevented).toBe(false);
  });

  it("closes an open picker on revocation and launches only after a fresh grant", async () => {
    state.allowed.add(selected);
    await renderPicker();
    await click(byLabel("Choose editor"));
    expect(menuItems().length).toBeGreaterThan(0);
    state.allowed.delete(selected);
    await renderPicker();
    // The menu unmounts after its exit animation, so wait for it rather than asserting at once.
    await vi.waitFor(() => expect(menuItems()).toHaveLength(0));
    state.allowed.add(selected);
    await renderPicker();
    expect(menuItems()).toHaveLength(0);
    await click(primaryButton());
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: { cwd: "/work/project", editor: "vscode" },
    });
  });
});

it("reveals a file in the file manager instead of opening it", async () => {
  state.allowed.add(selected);
  await renderPicker(["file-manager"], false, {
    openInCwd: "/work/project/README.md",
    revealFileManager: true,
  });
  await click(primaryButton());
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: selected,
    input: { cwd: "/work/project/README.md", editor: "file-manager", reveal: true },
  });
});

describe("client editor links", () => {
  it.each([true, false])(
    "remembers a browser editor and opens it once through the chat shortcut (panel mounted: %s)",
    async (panelMounted) => {
      const actual = await vi.importActual<typeof import("../../remoteOpen")>("../../remoteOpen");
      vi.mocked(useRemoteCapableEditors).mockImplementation(actual.useRemoteCapableEditors);
      state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
      await renderPicker();
      expect(primaryButton().disabled).toBe(false);
      await click(primaryButton());
      expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
        "vscode://vscode-remote/ssh-remote+test-host/work/project",
      );
      expect(state.run).not.toHaveBeenCalled();
      expect(state.markHintSeen).toHaveBeenCalledOnce();
      expect(state.setPreferred).toHaveBeenCalledExactlyOnceWith("vscode");

      await click(byLabel("Choose editor"));
      const labels = menuItems().map((item) => item.textContent);
      expect(labels).toEqual(
        expect.arrayContaining(["IntelliJ IDEA", "VSCodium", "Cursor", "Zed"]),
      );
      await click(menuItems().find((item) => item.textContent === "VSCodium")!);
      expect(state.openUrl).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem("t3code:last-editor")).toBe('"vscodium"');

      await act(async () => root.unmount());
      root = createRoot(container);
      state.allowed.add(selected);
      state.openUrl.mockClear();
      await act(async () => root.render(<ChatEditorShortcut panelMounted={panelMounted} />));
      await pressOpenFavorite();
      expect
        .soft(state.openUrl)
        .toHaveBeenCalledExactlyOnceWith(
          "vscodium://vscode-remote/ssh-remote+test-host/work/project",
        );
      expect.soft(state.run).not.toHaveBeenCalled();
    },
  );

  it("does not change preferences when the client rejects the SSH URL", async () => {
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "test-host" } };
    state.openUrl.mockResolvedValue(false);
    await renderPicker();
    const event = await pressOpenFavorite();
    expect(state.openUrl).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();
    expect(state.markHintSeen).not.toHaveBeenCalled();
  });
});
