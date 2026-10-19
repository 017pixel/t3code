import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type DesktopPreviewTabState,
} from "@t3tools/contracts";
import "~/index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
  onStateChange: vi.fn<DesktopPreviewBridge["onStateChange"]>(),
  captureReady: vi.fn<NonNullable<DesktopPreviewBridge["captureReady"]>>(),
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

vi.mock(import("./desktopTabLifetime"), { spy: true });

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
    onStateChange: mocks.onStateChange,
    captureReady: mocks.captureReady,
  } as unknown as DesktopPreviewBridge,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { acquireBrowserSurfaceActivity, useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

let root: Root | undefined;
let container: HTMLDivElement;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  mocks.getClientSettings.mockReset();
  mocks.onStateChange.mockReset().mockReturnValue(() => undefined);
  mocks.captureReady.mockReset().mockResolvedValue(undefined);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  vi.useFakeTimers();
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostedBrowserWebview settings hydration", () => {
  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.mocked(desktopTabLifetime.acquireDesktopTab);
    // Chromium treats <webview> as an unknown element; give it the one Electron method the
    // host calls once the guest attaches.
    const createElement = document.createElement.bind(document);
    const createGuest = vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      const element = createElement(tagName, options);
      return tagName === "webview"
        ? Object.assign(element, { getWebContentsId: () => 41 })
        : element;
    }) as typeof document.createElement);
    const guests = () => createGuest.mock.calls.filter(([tagName]) => tagName === "webview");
    const guest = () => container.querySelector("webview");
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    root = createRoot(container);
    await act(async () =>
      root!.render(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1.25}
        />,
      ),
    );

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(guest()).toBeNull();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(guest()).toBeNull();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(guest()).toBeNull();
    expect(mocks.createTab).not.toHaveBeenCalled();

    await act(async () => {
      retryRead.resolve({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultZoomFactor: 1.25,
        browserDefaultAppearance: "dark",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
        browserDefaultProfileId: "work",
      });
      await retry;
    });

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId, undefined);
    expect(mocks.getPreviewConfig).toHaveBeenCalledExactlyOnceWith(threadRef.environmentId, "work");
    expect(guests()).toHaveLength(1);
    expect(guest()?.getAttribute("partition")).toBe("persist:t3-preview-work");
    expect(guest()?.getAttribute("src")).toBe("https://example.com");
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.25,
      colorScheme: "dark",
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();

    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 41);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

describe("HostedBrowserWebview agent capture", () => {
  it("makes an inactive guest paintable before acknowledging capture and releases only its activity", async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      const element = createElement(tagName, options);
      return tagName === "webview"
        ? Object.assign(element, { getWebContentsId: () => 41 })
        : element;
    }) as typeof document.createElement);
    const runtimeTabId = "inactive-capture";
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <HostedBrowserWebview
          threadRef={{
            environmentId: EnvironmentId.make("capture"),
            threadId: ThreadId.make("capture"),
          }}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="about:blank"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId={undefined}
          zoomFactor={1}
        />,
      ),
    );
    const wrapper = container.querySelector<HTMLDivElement>("[data-preview-viewport]")!;
    expect(wrapper.getBoundingClientRect().right).toBeLessThan(0);
    const notify = (tabId: string, state: DesktopPreviewTabState) => {
      for (const [listener] of mocks.onStateChange.mock.calls) listener(tabId, state);
    };
    const state: DesktopPreviewTabState = {
      tabId: runtimeTabId,
      webContentsId: 41,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      updatedAt: new Date().toISOString(),
    };
    const readyBounds: DOMRect[] = [];
    mocks.captureReady.mockImplementation(async () => {
      readyBounds.push(wrapper.getBoundingClientRect());
    });
    // The acknowledgement observes committed layout, before the main process can copy.
    notify(runtimeTabId, { ...state, captureRequestIds: ["first", "second"] });
    expect(wrapper.getBoundingClientRect().left).toBe(0);
    expect(readyBounds).toHaveLength(2);
    for (const bounds of readyBounds) {
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.width).toBeGreaterThan(0);
    }
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible ?? false).toBe(false);
    notify(runtimeTabId, { ...state, captureRequestIds: ["second"] });
    expect(wrapper.getBoundingClientRect().left).toBe(0);
    expect(mocks.captureReady).toHaveBeenCalledTimes(2);
    let releaseRecording!: () => void;
    await act(() => {
      releaseRecording = acquireBrowserSurfaceActivity(runtimeTabId);
    });
    notify(runtimeTabId, state);
    expect(wrapper.getBoundingClientRect().left).toBe(0);
    await act(() => releaseRecording());
    expect(wrapper.getBoundingClientRect().right).toBeLessThan(0);

    notify(runtimeTabId, { ...state, captureRequestIds: ["unmounted"] });
    expect(wrapper.getBoundingClientRect().left).toBe(0);
    await act(() => root!.unmount());
    root = undefined;
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  });
});
