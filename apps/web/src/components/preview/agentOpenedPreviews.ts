import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  DeviceServiceState,
  EnvironmentId,
  PreviewSessionSnapshot,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { getClientSettings } from "../../hooks/useSettings";
import {
  browserMiniPlayerSource,
  type PreviewMiniPlayerSource,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import {
  onPreviewSessionsChanged,
  onServerTabsRevealed,
  type ThreadPreviewState,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { deviceEnvironment } from "../../state/device";
import { readEnvironmentSupportsServerBrowser } from "../../state/entities";
import { environmentSummaries } from "../../state/presentation";

/**
 * Shows browsers an agent or another client revealed for a thread: floating
 * over chat, or focusing an existing panel tab when the reveal is forced.
 */
export function revealServerTabs(
  threadRef: ScopedThreadRef,
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  options: { readonly autoShowFloatingPreview: boolean },
): void {
  if (!readEnvironmentSupportsServerBrowser(threadRef.environmentId)) return;
  for (const session of sessions) {
    const force = session.revealRequest?.force === true;
    if (!options.autoShowFloatingPreview && !force) continue;
    const surface = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
    if (surface && force) {
      useRightPanelStore.getState().activateSurface(threadRef, surface.id);
    } else if (!surface) {
      usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(session.tabId));
    }
  }
}

/**
 * Keeps a thread's browser panel tabs and floating browser in step with its
 * preview sessions. Server-hosted sessions are only complete once the first
 * list has loaded; before that, a missing session is not a closed one.
 */
export function followPreviewSessions(threadRef: ScopedThreadRef, state: ThreadPreviewState): void {
  if (readEnvironmentSupportsServerBrowser(threadRef.environmentId) && !state.listLoaded) return;
  const sessions = Object.values(state.sessions);
  useRightPanelStore.getState().reconcileBrowserSurfaces(
    threadRef,
    sessions.map((session) => session.tabId),
    new Set(
      sessions
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    ),
  );
  const miniPlayer = usePreviewMiniPlayerStore.getState();
  const source = miniPlayer.byThreadKey[scopedThreadKey(threadRef)]?.source;
  if (source?.kind === "browser" && !state.sessions[source.tabId]) miniPlayer.close(threadRef);
}

type DeviceSource = Extract<PreviewMiniPlayerSource, { kind: "device" }>;

const deviceStateAtom = (environmentId: EnvironmentId) =>
  deviceEnvironment.state({ environmentId, input: {} });

const sessionKey = (session: {
  readonly threadId: string;
  readonly hostId: string;
  readonly deviceId: string;
}) => `${session.threadId}:${session.hostId}:${session.deviceId}`;

/**
 * Per environment: the device sessions seen in the last snapshot. The first
 * snapshot is a baseline, so persisted tabs restore themselves and existing
 * sessions never resurrect tabs the user closed. Baselines outlive a
 * disconnect, so a device an agent opened during the gap still shows.
 */
const deviceSessionBaselines = new Map<EnvironmentId, ReadonlySet<string>>();

function hasLiveSession(
  state: DeviceServiceState,
  threadId: ThreadId,
  target: { readonly hostId: string; readonly deviceId: string },
): boolean {
  return state.sessions.some(
    (session) =>
      session.threadId === threadId &&
      session.hostId === target.hostId &&
      session.deviceId === target.deviceId,
  );
}

/**
 * A device the agent opens floats over its thread's chat, or becomes a panel tab
 * when floating previews are off; sheet layouts get neither. A session without a
 * device summary yet stays out of the baseline so a later snapshot opens it.
 * Floating devices whose session ended close here.
 */
export function applyDeviceSnapshot(
  environmentId: EnvironmentId,
  state: DeviceServiceState,
  options: { readonly sheetLayout: boolean; readonly autoShowFloatingPreview: boolean },
): void {
  const deviceFor = (session: DeviceServiceState["sessions"][number]) =>
    state.devices.find((entry) => entry.hostId === session.hostId && entry.id === session.deviceId);

  const miniPlayer = usePreviewMiniPlayerStore.getState();
  for (const [threadKey, entry] of Object.entries(miniPlayer.byThreadKey)) {
    if (entry.source.kind !== "device") continue;
    const ref = parseScopedThreadKey(threadKey);
    if (ref?.environmentId === environmentId && !hasLiveSession(state, ref.threadId, entry.source))
      miniPlayer.close(ref);
  }

  const previous = deviceSessionBaselines.get(environmentId);
  deviceSessionBaselines.set(
    environmentId,
    new Set(state.sessions.filter((session) => deviceFor(session) !== undefined).map(sessionKey)),
  );
  if (!previous || options.sheetLayout) return;
  for (const session of state.sessions) {
    if (previous.has(sessionKey(session))) continue;
    const device = deviceFor(session);
    if (!device) continue;
    const threadRef = scopeThreadRef(environmentId, session.threadId);
    const target = {
      hostId: session.hostId,
      deviceId: session.deviceId,
      platform: device.platform,
      name: device.name,
    };
    if (options.autoShowFloatingPreview) {
      usePreviewMiniPlayerStore.getState().open(threadRef, { kind: "device", ...target });
      continue;
    }
    const existing = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.some(
        (surface) =>
          surface.kind === "device" &&
          surface.target?.hostId === session.hostId &&
          surface.target.deviceId === session.deviceId,
      );
    if (existing) continue;
    useRightPanelStore.getState().openDevice(threadRef, target, true);
  }
}

/**
 * Floats a device panel tab over chat. A tab whose device session already
 * ended has nothing to stream, so it only closes the panel.
 */
export function floatDeviceSurface(threadRef: ScopedThreadRef, source: DeviceSource): void {
  const state = Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(deviceStateAtom(threadRef.environmentId))),
  );
  if (state !== null && !hasLiveSession(state, threadRef.threadId, source)) return;
  usePreviewMiniPlayerStore.getState().open(threadRef, source);
}

export function resetDeviceSessionBaselinesForTests(): void {
  deviceSessionBaselines.clear();
}

function watchEnvironmentDevices(environmentId: EnvironmentId): () => void {
  return appAtomRegistry.subscribe(
    deviceStateAtom(environmentId),
    (result) => {
      const state = Option.getOrNull(AsyncResult.value(result));
      if (state === null) return;
      applyDeviceSnapshot(environmentId, state, {
        sheetLayout: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
        autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
      });
    },
    { immediate: true },
  );
}

const watchedEnvironments = new Map<EnvironmentId, () => void>();

// Every connected environment is watched, not just the visible thread's: an
// agent in a background thread can open a device too. The device state stream
// only pushes when hosts, devices, or sessions change.
function watchConnectedEnvironments(environmentIds: ReadonlyArray<EnvironmentId>): void {
  for (const [environmentId, stop] of watchedEnvironments) {
    if (environmentIds.includes(environmentId)) continue;
    stop();
    watchedEnvironments.delete(environmentId);
  }
  for (const environmentId of environmentIds) {
    if (!watchedEnvironments.has(environmentId)) {
      watchedEnvironments.set(environmentId, watchEnvironmentDevices(environmentId));
    }
  }
}

let started = false;

/**
 * Shows previews agents and other clients open, for the life of the page:
 * browser reveals as preview snapshots land, and device sessions on every
 * connected environment.
 */
export function startAgentOpenedPreviews(): void {
  if (started) return;
  started = true;
  onPreviewSessionsChanged(followPreviewSessions);
  onServerTabsRevealed((threadRef, sessions) =>
    revealServerTabs(threadRef, sessions, {
      autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
    }),
  );
  appAtomRegistry.subscribe(
    environmentSummaries.connectedEnvironmentIdsAtom,
    watchConnectedEnvironments,
    { immediate: true },
  );
}
