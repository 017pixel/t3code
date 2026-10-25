import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DeviceServiceState,
  type EnvironmentId,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { __testing as previewStateTesting } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  applyDeviceSnapshot,
  followPreviewSessions,
  resetDeviceSessionBaselinesForTests,
  revealServerTabs,
} from "./agentOpenedPreviews";

vi.mock("../../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
}));

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(ref);

const device = {
  hostId: "local",
  id: "pixel",
  platform: "android",
  name: "Pixel 8",
  version: "15",
  booted: true,
  physical: false,
} as const;

const session = {
  threadId: ref.threadId,
  hostId: "local",
  deviceId: "pixel",
  platform: "android",
  openedAt: "2026-01-01T00:00:00.000Z",
} as const;

const deviceState = (input: {
  readonly sessions?: ReadonlyArray<typeof session>;
  readonly devices?: ReadonlyArray<typeof device>;
}) =>
  ({
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: input.devices ?? [device],
    sessions: input.sessions ?? [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 0,
  }) as unknown as DeviceServiceState;

const floating = { sheetLayout: false, autoShowFloatingPreview: true };

function setup() {
  resetDeviceSessionBaselinesForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
}

const miniPlayerSource = () => usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;

describe("applyDeviceSnapshot", () => {
  it("treats the first snapshot as a baseline and floats sessions that start later", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [] }), floating);
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });
  });

  it("opens a session once its device summary arrives", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({}), floating);
    applyDeviceSnapshot(
      ref.environmentId,
      deviceState({ sessions: [session], devices: [] }),
      floating,
    );
    expect(miniPlayerSource()).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", name: "Pixel 8" });
  });

  it("opens a panel tab once when floating previews are off, and nothing in sheet layouts", () => {
    setup();
    const panel = { sheetLayout: false, autoShowFloatingPreview: false };
    applyDeviceSnapshot(ref.environmentId, deviceState({}), { ...panel, sheetLayout: true });
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), {
      ...panel,
      sheetLayout: true,
    });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({}), panel);
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), panel);
    applyDeviceSnapshot(ref.environmentId, deviceState({}), panel);
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), panel);
    const devices = useRightPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "device");
    expect(devices).toHaveLength(1);
    expect(miniPlayerSource()).toBeUndefined();
  });

  it("closes a floating device when its session ends, even before a baseline", () => {
    setup();
    usePreviewMiniPlayerStore.getState().open(ref, {
      kind: "device",
      hostId: "local",
      deviceId: "pixel",
      platform: "android",
      name: "Pixel 8",
    });
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device" });

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [] }), floating);
    expect(miniPlayerSource()).toBeUndefined();
  });

  it("opens a device for a thread that had no sessions when the baseline was taken", () => {
    setup();
    const otherRef = scopeThreadRef(ref.environmentId, ThreadId.make("thread-2"));
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    applyDeviceSnapshot(
      ref.environmentId,
      deviceState({ sessions: [session, { ...session, threadId: otherRef.threadId }] }),
      floating,
    );
    expect(miniPlayerSource()).toBeUndefined();
    expect(
      usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(otherRef)]?.source,
    ).toMatchObject({ kind: "device", deviceId: "pixel" });
  });
});

describe("revealServerTabs", () => {
  const tab = (tabId: string, force?: boolean): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal: true,
    ...(force === undefined ? {} : { revealRequest: { id: "r1", force } }),
  });
  const floatingTabId = () => {
    const source = miniPlayerSource();
    return source?.kind === "browser" ? source.tabId : null;
  };

  it("floats revealed tabs, and only forced ones when floating previews are off", () => {
    setup();
    revealServerTabs(ref, [tab("tab_plain")], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBeNull();
    revealServerTabs(ref, [tab("tab_forced", true)], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBe("tab_forced");
  });

  it("focuses a tab already in the panel instead of floating it when forced", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_a");
    const browserSurfaceId = useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId;
    useRightPanelStore.getState().open(ref, "diff");

    revealServerTabs(ref, [tab("tab_a", false)], { autoShowFloatingPreview: true });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).not.toBe(
      browserSurfaceId,
    );
    revealServerTabs(ref, [tab("tab_a", true)], { autoShowFloatingPreview: true });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).toBe(
      browserSurfaceId,
    );
    expect(floatingTabId()).toBeNull();
  });
});

describe("followPreviewSessions", () => {
  const snapshot = (tabId: string, reveal = true): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal,
  });
  const previewState = (sessions: ReadonlyArray<PreviewSessionSnapshot>, listLoaded = true) => ({
    ...previewStateTesting.EMPTY_THREAD_PREVIEW_STATE,
    listLoaded,
    sessions: Object.fromEntries(sessions.map((entry) => [entry.tabId, entry])),
  });
  const browserTabs = () =>
    useRightPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "preview")
      .map((surface) => surface.id);

  it("adds visible sessions as tabs and drops tabs whose session ended", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_gone");
    followPreviewSessions(ref, previewState([snapshot("tab_a"), snapshot("tab_hidden", false)]));
    expect(browserTabs()).toEqual(["browser:tab_a"]);
  });

  it("waits for the first server list before treating missing sessions as closed", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_a");
    usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab_a"));
    followPreviewSessions(ref, previewState([], false));
    expect(browserTabs()).toEqual(["browser:tab_a"]);
    expect(miniPlayerSource()).toMatchObject({ kind: "browser", tabId: "tab_a" });

    followPreviewSessions(ref, previewState([]));
    expect(browserTabs()).toEqual([]);
    expect(miniPlayerSource()).toBeUndefined();
  });
});
