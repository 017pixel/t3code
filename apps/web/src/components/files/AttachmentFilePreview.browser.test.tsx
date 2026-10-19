import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, memo, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
vi.mock(import("./ReadOnlySourcePreview"), async (original) => ({
  ...(await original()),
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

import { AttachmentFilePreview } from "./AttachmentFilePreview";

// Keep the real panel, store, virtualizer and editable Pierre surface. Only host
// services and unrelated panel bodies are replaced.
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }),
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  usePreviewAvailable: () => false,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: (_environmentId, _cwd, relativePath) => {
    const contents =
      relativePath === "short.ts"
        ? "export const short = 1;"
        : relativePath === "second.ts"
          ? source.split("\n").slice(0, 300).join("\n")
          : source;
    return {
      data: {
        relativePath: relativePath ?? "",
        contents,
        byteLength: contents.length,
        truncated: false,
      },
      error: null,
      readError: null,
      isNotFile: false,
      isPending: false,
      refresh: () => undefined,
    };
  },
}));
vi.mock(import("./useFileSaveCoordinator"), () => ({
  useFileSaveCoordinator: () => ({ change: () => undefined }),
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("../DiffPanel"), () => ({ default: () => <div>Changes</div> }));
vi.mock(import("../PersistentThreadTerminals"), () => ({
  PersistentThreadTerminalPanel: memo(() => <></>),
}));
vi.mock(import("../pullRequest/PullRequestDetailPanel"), () => ({
  PullRequestDetailPanel: () => <></>,
}));
vi.mock(import("../pullRequest/ThreadPullRequestsPanel"), () => ({
  ThreadPullRequestsPanel: () => <></>,
}));

import { RightPanelSurfaceContent } from "../chat/RightPanelSurfaceContent";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { useClosedViewStore } from "../../closedViewStore";
import { reopenClosedView } from "../../reopenClosedView";
import "../../index.css";

const source = Array.from(
  { length: 800 },
  (_, index) => `export const line${index + 1} = ${index + 1};`,
).join("\n");

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";
  let now = 0;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openRemote = () =>
    act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
        />,
      ),
    );

  const toggleMode = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = () => container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    await openRemote();
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode("Show HTML source");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    await vi.waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );

    await toggleMode("Show rendered page");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode("Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(alert()?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode("Show rendered page");
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={file.size}
          file={file}
        />,
      ),
    );
    await toggleMode("Show HTML source");
    await vi.waitFor(() => expect(alert()?.textContent).toContain("not UTF-8"));

    await toggleMode("Show rendered page");
    expect(alert()).toBeNull();
    expect(container.querySelector("iframe")?.title).toBe("document.html");
  });
});

describe("file editor scroll across panel navigation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let thread: ScopedThreadRef;
  const panels = useRightPanelStore.getState();
  const noop = () => undefined;
  const keybindings = [] as const;
  let caseId = 0;
  const activeSurface = (ref = thread) =>
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("t3code.fileExplorerOpen", "false");
    thread = {
      environmentId: EnvironmentId.make(`file-scroll-${++caseId}`),
      threadId: ThreadId.make("thread-a"),
    };
    useRightPanelStore.setState({ byThreadKey: {} });
    useClosedViewStore.setState({ entries: [] });
    container = document.createElement("div");
    container.style.cssText = "display:flex;width:800px;height:500px";
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem("t3code.fileExplorerOpen");
    useRightPanelStore.setState({ byThreadKey: {} });
    useClosedViewStore.setState({ entries: [] });
    vi.unstubAllGlobals();
  });

  const show = (ref = thread, cwd = "/repo") =>
    act(async () => {
      const surface = activeSurface(ref);
      root.render(
        <StrictMode>
          <RightPanelSurfaceContent
            surface={surface}
            activeSurfaceId={surface?.id ?? null}
            threadRef={ref}
            environmentId={ref.environmentId}
            visible
            composerDraftTarget={ref}
            keybindings={keybindings}
            configuredPreviewUrls={[]}
            workspaceMutationId={null}
            getShortcutContext={() => ({
              terminalFocus: false,
              terminalOpen: false,
              previewFocus: false,
              previewOpen: false,
              isWeb: true,
              isDesktop: false,
            })}
            onSendAnnotation={noop}
            onCloseSurface={noop}
            terminal={{
              launchContext: null,
              focusRequestId: 0,
              keybindings,
              onAddTerminalContext: noop,
              onSplitTerminal: noop,
              onSplitTerminalVertical: noop,
              onNewTerminal: noop,
              onActiveTerminalChange: noop,
              onCloseTerminal: noop,
            }}
            pullRequest={{
              capabilityKnown: false,
              supported: false,
              projectId: null,
              pullRequests: [],
              linkedPullRequest: null,
              branchPullRequest: null,
              onBack: undefined,
            }}
            files={{
              projectName: "repo",
              workspaceRoot: cwd,
              availableEditors: [],
              pendingSurfaceIds: new Set(),
              onOpenFile: noop,
              onPendingChange: noop,
            }}
          />
        </StrictMode>,
      );
    });

  const scroller = () => {
    const element = container.querySelector<HTMLElement>(".file-preview-virtualizer");
    expect(element).not.toBeNull();
    return element!;
  };
  const editorReady = (minScrollHeight = 10_000) =>
    vi.waitFor(
      () => {
        expect(scroller().scrollHeight).toBeGreaterThan(minScrollHeight);
        expect(
          container
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelector('[contenteditable="true"]'),
        ).toBeInstanceOf(HTMLElement);
      },
      { timeout: 5_000 },
    );
  const scrollTo = async (top: number) => {
    await act(async () => {
      // User input ends an outstanding reveal guard before scrolling the real viewport.
      scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
      if (scroller().scrollTop === top) return;
      scroller().scrollTop = top;
      await new Promise<void>((resolve) =>
        scroller().addEventListener("scroll", () => resolve(), { once: true }),
      );
    });
    expect(scroller().scrollTop).toBeCloseTo(top, 0);
  };
  const expectPosition = (top: number) =>
    vi.waitFor(() => expect(scroller().scrollTop).toBeCloseTo(top, 0));
  const expectLineVisible = (line: number, reason: string) =>
    vi.waitFor(() => {
      const row = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector(`[data-line="${line}"]`);
      expect(row, reason).not.toBeNull();
      const bounds = row!.getBoundingClientRect();
      const viewport = scroller().getBoundingClientRect();
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
    });

  it("restores each file after file and diff tab switches without replaying an old reveal", async () => {
    panels.openFile(thread, "first.ts", 120);
    await show();
    await editorReady();
    await expectLineVisible(120, "initial reveal");
    await scrollTo(8_000);

    panels.openFile(thread, "short.ts");
    await show();
    await editorReady(0);
    expect(scroller().scrollHeight).toBe(scroller().clientHeight);
    panels.activateSurface(thread, "file:first.ts");
    await show();
    await editorReady();
    await expectPosition(8_000);

    await act(async () => {
      scroller().scrollTop = 7_000;
      panels.openFile(thread, "second.ts");
      // Commit the switch before the browser delivers the queued scroll event.
      await show();
    });
    await editorReady(4_000);
    await scrollTo(3_000);
    panels.activateSurface(thread, "file:first.ts");
    await show();
    await editorReady();
    await expectPosition(7_000);

    await act(async () => {
      scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
      scroller().scrollTop = 6_000;
      panels.open(thread, "diff");
      await show();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Changes"));
    panels.activateSurface(thread, "file:first.ts");
    await show();
    await editorReady();
    await expectPosition(6_000);
    panels.activateSurface(thread, "file:second.ts");
    await show();
    await editorReady(4_000);
    await expectPosition(3_000);

    await act(async () => {
      scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      scroller().scrollTop = 0;
      panels.activateSurface(thread, "file:first.ts");
      await show();
    });
    await editorReady();
    await expectPosition(6_000);
    panels.activateSurface(thread, "file:second.ts");
    await show();
    await editorReady(4_000);
    await expectPosition(0);
  });

  it("keeps the same file independent across threads, environments and workspace roots", async () => {
    const otherThread = { ...thread, threadId: ThreadId.make("thread-b") };
    const otherEnvironment = {
      ...thread,
      environmentId: EnvironmentId.make(`file-scroll-${++caseId}`),
    };
    panels.openFile(thread, "shared.ts");
    await show();
    await editorReady();
    await scrollTo(8_000);

    panels.openFile(otherThread, "shared.ts");
    await show(otherThread);
    await editorReady();
    await expectPosition(0);
    await scrollTo(3_000);

    panels.openFile(otherEnvironment, "shared.ts");
    await show(otherEnvironment);
    await editorReady();
    await expectPosition(0);
    await scrollTo(5_000);

    await show(thread, "/other-repo");
    await editorReady();
    await expectPosition(0);
    await scrollTo(1_000);
    await show(thread);
    await editorReady();
    await expectPosition(8_000);
    await show(otherThread);
    await editorReady();
    await expectPosition(3_000);
    await show(otherEnvironment);
    await editorReady();
    await expectPosition(5_000);
  });

  it("honors a new reveal when closing and reopening reuses the numeric request ID", async () => {
    panels.openFile(thread, "target.ts", 120);
    const original = activeSurface();
    await show();
    await editorReady();
    await expectLineVisible(120, "initial reveal");
    await scrollTo(8_000);

    panels.openFile(thread, "other.ts");
    panels.closeSurface(thread, "file:target.ts");
    await show();
    await editorReady();
    const closed = useClosedViewStore.getState().entries[0]!;
    await reopenClosedView(closed, { workspaceAvailable: true, openPreview: vi.fn() });
    expect(activeSurface()).toMatchObject({ revealRequestId: 1 });
    expect(original).toMatchObject({ revealRequestId: 1 });
    await show();
    await editorReady();
    await expectLineVisible(120, "reopen closed tab must reveal again");

    await scrollTo(8_000);
    panels.closeSurface(thread, "file:target.ts");
    await show();
    await editorReady();
    panels.openFile(thread, "target.ts", 250);
    await show();
    await editorReady();
    await expectLineVisible(250, "new explicit line must win over saved scroll");
  });
});
