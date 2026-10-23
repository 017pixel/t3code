import type { VideoPlayer } from "expo-video";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { AppStateStatus } from "react-native";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  focused: true,
  appState: "active" as AppStateStatus,
  appStateListeners: new Set<(state: AppStateStatus) => void>(),
  releaseVideoAudioSession: vi.fn(async () => {}),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => mocks.focused }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("expo", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    requireOptionalNativeModule: () => ({
      releaseVideoAudioSession: mocks.releaseVideoAudioSession,
    }),
    useEvent: (player: ReturnType<typeof createPlayer>) => ({
      isPlaying: useSyncExternalStore(player.subscribe, () => player.playing),
    }),
  };
});

import { useMediaVideoPlayback } from "./useMediaVideoPlayback";
import { fullscreenVideoClosed, fullscreenVideoOpened } from "./videoAudioSession";

function createPlayer() {
  let playing = false;
  const listeners = new Set<() => void>();
  const setPlaying = (next: boolean) => {
    playing = next;
    for (const listener of listeners) listener();
  };
  return {
    get playing() {
      return playing;
    },
    play: vi.fn(() => setPlaying(true)),
    pause: vi.fn(() => setPlaying(false)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.focused = true;
  mocks.appState = "active";
  mocks.appStateListeners.clear();
  mocks.releaseVideoAudioSession.mockClear();
  const player = createPlayer();
  const root = createRoot(document.createElement("div"));
  let playback: ReturnType<typeof useMediaVideoPlayback>;
  function Probe(props: { readonly visible: boolean; readonly paused: boolean }) {
    const result = useMediaVideoPlayback(player as unknown as VideoPlayer, props);
    useLayoutEffect(() => {
      playback = result;
    });
    return null;
  }
  return {
    player,
    render(visible = true, paused = false) {
      act(() => root.render(<Probe visible={visible} paused={paused} />));
    },
    playIfActive() {
      act(() => playback.playIfActive());
    },
    fullscreen(value: boolean) {
      if (value) playback.onFullscreenEnter();
      else playback.onFullscreenExit();
    },
    appState(state: AppStateStatus) {
      mocks.appState = state;
      act(() => {
        for (const listener of mocks.appStateListeners) listener(state);
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("pauses a hidden video, releases its audio hold, and requires deliberate resume", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  using screen = setup();
  screen.render();
  screen.playIfActive();
  expect(screen.player.playing).toBe(true);
  screen.render(false);
  expect(screen.player.playing).toBe(false);
  act(() => vi.advanceTimersByTime(1_000));
  expect(mocks.releaseVideoAudioSession).toHaveBeenCalledTimes(1);
  screen.render(true);
  expect(screen.player.play).toHaveBeenCalledTimes(1);
  expect(screen.player.playing).toBe(false);
  screen.playIfActive();
  expect(screen.player.playing).toBe(true);
});

it("blocks late load completion while hidden, including an initially hidden video", () => {
  using screen = setup();
  screen.render(false);
  screen.playIfActive();
  expect(screen.player.play).not.toHaveBeenCalled();
  screen.render(true);
  screen.render(false);
  screen.playIfActive();
  expect(screen.player.play).not.toHaveBeenCalled();
});

it("still pauses for blur, explicit pause, sharing or another fullscreen preview", () => {
  using screen = setup();
  screen.render();
  screen.playIfActive();
  mocks.focused = false;
  screen.render();
  expect(screen.player.playing).toBe(false);
  screen.playIfActive();
  expect(screen.player.play).toHaveBeenCalledTimes(1);
  mocks.focused = true;
  screen.render();
  screen.playIfActive();
  screen.render(true, true);
  expect(screen.player.playing).toBe(false);
  screen.playIfActive();
  expect(screen.player.play).toHaveBeenCalledTimes(2);
  screen.render();
  screen.playIfActive();
  act(() => fullscreenVideoOpened());
  using _fullscreen = { [Symbol.dispose]: () => act(() => fullscreenVideoClosed()) };
  expect(screen.player.playing).toBe(false);
  screen.playIfActive();
  expect(screen.player.play).toHaveBeenCalledTimes(3);
});

it.each(["inactive", "background"] as const)("pauses on %s without auto-resuming", (state) => {
  using screen = setup();
  screen.render();
  screen.playIfActive();
  screen.appState(state);
  expect(screen.player.playing).toBe(false);
  screen.playIfActive();
  expect(screen.player.play).toHaveBeenCalledTimes(1);
  screen.appState("active");
  expect(screen.player.playing).toBe(false);
});

it("keeps Android native fullscreen playing across its background transition but pauses when hidden", () => {
  using screen = setup();
  screen.render();
  screen.playIfActive();
  screen.fullscreen(true);
  screen.appState("background");
  expect(screen.player.playing).toBe(true);
  screen.render(false);
  expect(screen.player.playing).toBe(false);
  screen.playIfActive();
  expect(screen.player.play).toHaveBeenCalledTimes(1);
});
