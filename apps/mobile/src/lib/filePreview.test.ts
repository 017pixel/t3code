import { act, createElement, useEffect, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { inlineFilePreviewKind, isPdfFile } from "./filePreview";
import { ThreadInlineFilePreview } from "../features/threads/ThreadInlineFilePreview";
import { AudioFilePreview } from "../features/files/AudioFilePreview";
import { MediaVideoPlayer } from "../components/MediaVideoPlayer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { acquireAudioSession, activateAudioSession, releaseAudioSession } from "./audioSession";

const audio = vi.hoisted(() => ({
  status: {
    playing: false,
    isLoaded: false,
    error: null,
    didJustFinish: false,
    currentTime: 0,
    duration: 10,
    isBuffering: false,
  },
  player: {
    play: vi.fn(),
    pause: vi.fn(),
    release: vi.fn(),
    replace: vi.fn(),
    seekTo: vi.fn(async () => {}),
  },
  refresh: vi.fn<() => Promise<string | null>>(),
  setAudioMode: vi.fn(async (_mode: unknown) => {}),
  setActive: vi.fn(async (_active: boolean) => {}),
  enabled: true,
  played: vi.fn(),
  video: {
    playing: false,
    status: "readyToPlay",
    play: vi.fn(),
    pause: vi.fn(),
    replaceAsync: vi.fn(async (_source: unknown) => {}),
    addListener: vi.fn(),
  },
  videoListeners: new Set<(event: { isPlaying: boolean }) => void>(),
}));
vi.mock("expo-audio", () => ({
  useAudioPlayer: () => audio.player,
  createAudioPlayer: () => audio.player,
  useAudioPlayerStatus: () => audio.status,
  setAudioModeAsync: audio.setAudioMode,
  setIsAudioActiveAsync: audio.setActive,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Pressable: (props: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement(
      "button",
      { onClick: props.onPress, disabled: props.disabled, "aria-label": props.accessibilityLabel },
      props.children,
    ),
}));
vi.mock("../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/Button", () => ({
  Button: (props: { label: string; onPress(): void; disabled?: boolean }) =>
    createElement("button", { onClick: props.onPress, disabled: props.disabled }, props.label),
}));
vi.mock("expo", () => ({
  useEvent: (_player: unknown, _event: unknown, initial: unknown) => initial,
  useReleasingSharedObjectWithLifecycle: (
    lifecycle: {
      factory: () => typeof audio.player;
      release: (player: typeof audio.player) => void;
    },
    dependencies: ReadonlyArray<unknown>,
  ) => {
    const player = useMemo(lifecycle.factory, dependencies);
    useEffect(() => () => lifecycle.release(player), [player]);
    return player;
  },
}));
vi.mock("expo-video", () => ({
  useVideoPlayer: () => audio.video,
  VideoView: () => null,
}));
vi.mock("../components/VideoThumbnailImage", () => ({ VideoThumbnailImage: () => null }));
vi.mock("../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../components/MediaActionsMenu", () => ({ MediaActionsMenu: () => null }));
vi.mock("../state/mediaActions", () => ({
  useMediaActions: () => ({ sharing: false, actions: [] }),
}));
vi.mock("./videoAudioSession", () => ({
  useMediaAudioSessionHold() {},
  useFullscreenVideoOpen: () => false,
}));
vi.mock("../state/assets", () => ({ useRefreshAssetUrl: () => audio.refresh }));
vi.mock("../features/threads/ThreadMarkdownVideo", async () => {
  const { createContext } = await import("react");
  return { ThreadMediaVisibleContext: createContext(true) };
});

describe("ThreadInlineFilePreview playback", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  beforeEach(() => {
    audio.enabled = true;
    audio.setActive.mockImplementation(async (enabled) => {
      audio.enabled = enabled;
    });
    // Expo's play() silently does nothing while its global gate is disabled.
    audio.player.play.mockImplementation(() => {
      if (audio.enabled) audio.played();
    });
    audio.video.addListener.mockImplementation(
      (_event: string, listener: (event: { isPlaying: boolean }) => void) => {
        audio.videoListeners.add(listener);
        return { remove: () => audio.videoListeners.delete(listener) };
      },
    );
    audio.video.play.mockImplementation(() => {
      audio.video.playing = true;
      for (const listener of audio.videoListeners) listener({ isPlaying: true });
    });
    audio.video.pause.mockImplementation(() => {
      if (!audio.video.playing) return;
      audio.video.playing = false;
      for (const listener of audio.videoListeners) listener({ isPlaying: false });
    });
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    vi.clearAllMocks();
    audio.refresh.mockReset();
    audio.setAudioMode.mockReset();
    audio.setActive.mockReset();
    audio.status = {
      playing: false,
      isLoaded: false,
      error: null,
      didJustFinish: false,
      currentTime: 0,
      duration: 10,
      isBuffering: false,
    };
  });

  it("plays inline, opens the file viewer, and yields viewer playback to recording", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    audio.status = { ...audio.status, isLoaded: true };
    const container = document.createElement("div");
    root = createRoot(container);
    const openViewer = () =>
      root!.render(
        createElement(AudioFilePreview, { uri: "https://example.com/sound.mp3", onRetry() {} }),
      );
    await act(async () =>
      root!.render(
        createElement(ThreadInlineFilePreview, {
          source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
          onOpen: openViewer,
        }),
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!.click(),
    );
    expect(audio.played).toHaveBeenCalledOnce();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Open sound.mp3"]')!.click(),
    );
    expect(audio.enabled).toBe(true);
    const play = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Play",
    )!;
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(2);
    audio.player.pause.mockClear();
    const recording = acquireAudioSession("recording");
    expect(audio.player.pause).toHaveBeenCalledOnce();
    await activateAudioSession(recording);
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(2);
    await releaseAudioSession(recording);
    await act(async () => play.click());
    expect(audio.played).toHaveBeenCalledTimes(3);
    expect(audio.enabled).toBe(true);
  });

  it.each(["pause", "unmount", "recording"])(
    "does not restart the file viewer after %s during replay seeking",
    async (action) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      audio.status = { ...audio.status, isLoaded: true, didJustFinish: true, currentTime: 10 };
      const seek = Promise.withResolvers<void>();
      audio.player.seekTo.mockReturnValueOnce(seek.promise);
      const container = document.createElement("div");
      root = createRoot(container);
      await act(async () =>
        root!.render(
          createElement(AudioFilePreview, { uri: "https://example.com/sound.mp3", onRetry() {} }),
        ),
      );
      const play = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Play",
      )!;
      await act(async () => play.click());
      let recording: ReturnType<typeof acquireAudioSession> | undefined;
      if (action === "pause") await act(async () => play.click());
      else if (action === "recording") {
        recording = acquireAudioSession("recording");
        await activateAudioSession(recording);
      } else {
        await act(async () => root!.unmount());
        root = undefined;
      }
      await act(async () => seek.resolve());
      expect(audio.played).not.toHaveBeenCalled();
      if (recording) await releaseAudioSession(recording);
    },
  );

  it("keeps thread video playback and native controls working after audio releases", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const recording = acquireAudioSession("recording");
    await activateAudioSession(recording);
    await releaseAudioSession(recording);
    const modes = audio.setAudioMode.mock.calls.length;
    const activations = audio.setActive.mock.calls.length;
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(MediaVideoPlayer, {
          uri: "https://example.com/clip.mp4",
          name: "clip.mp4",
          thumbnailKey: "clip",
          expanded: true,
          autoPlay: true,
        }),
      ),
    );
    expect(audio.video.playing).toBe(true);
    expect(audio.setAudioMode).toHaveBeenCalledTimes(modes);
    expect(audio.setActive).toHaveBeenCalledTimes(activations);
    audio.video.pause();
    audio.video.play();
    expect(audio.video.playing).toBe(true);
    const takeover = acquireAudioSession("recording");
    expect(audio.video.playing).toBe(false);
    await activateAudioSession(takeover);
    audio.video.play();
    expect(audio.video.playing).toBe(false);
    await releaseAudioSession(takeover);
    audio.video.play();
    expect(audio.video.playing).toBe(true);
    await act(async () => root!.unmount());
    root = undefined;
    expect(audio.video.playing).toBe(false);
  });

  it.each(["play", "cancel", "unmount", "mode failure", "activation failure"])(
    "reactivates audio after voice release and honors %s during activation",
    async (intent) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const recording = acquireAudioSession("recording");
      await activateAudioSession(recording);
      await releaseAudioSession(recording);
      vi.clearAllMocks();
      let activate: () => void = () => {};
      if (intent === "mode failure") {
        audio.setAudioMode.mockRejectedValueOnce(new Error("Playback mode unavailable"));
      } else if (intent === "activation failure") {
        audio.setActive.mockRejectedValueOnce(new Error("Audio session unavailable"));
      } else {
        audio.setActive.mockImplementationOnce(
          () => new Promise((resolve) => (activate = resolve)),
        );
      }
      audio.status = { ...audio.status, isLoaded: true };
      const container = document.createElement("div");
      root = createRoot(container);
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
      });
      expect(audio.player.play).not.toHaveBeenCalled();
      if (intent.endsWith("failure")) {
        expect(container.textContent).toContain("Unavailable · tap play to retry");
        expect(button.getAttribute("aria-label")).toBe("Retry audio");
        expect(audio.setActive).not.toHaveBeenCalledWith(false);
        return;
      }
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
      expect(audio.setAudioMode.mock.invocationCallOrder[0]).toBeLessThan(
        audio.setActive.mock.invocationCallOrder[0]!,
      );
      if (intent === "cancel") await act(async () => button.click());
      else if (intent === "unmount") {
        act(() => root!.unmount());
        root = undefined;
        expect(audio.player.release).not.toHaveBeenCalled();
      }
      await act(async () => activate());
      if (intent === "play") {
        expect(audio.player.play).toHaveBeenCalledOnce();
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
      } else {
        expect(audio.player.play).not.toHaveBeenCalled();
        expect(audio.setActive).toHaveBeenLastCalledWith(true);
        expect(audio.player.pause).toHaveBeenCalled();
        if (intent === "unmount") {
          expect(audio.player.release).toHaveBeenCalledOnce();
          expect(audio.player.pause.mock.invocationCallOrder[0]).toBeLessThan(
            audio.player.release.mock.invocationCallOrder[0]!,
          );
        }
        if (intent === "cancel") expect(button.getAttribute("aria-label")).toBe("Play audio");
      }
    },
  );

  it.each(["playing", "URL pending", "mode pending", "activation pending"])(
    "yields to recording while %s and plays again after recording stops",
    async (phase) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const url = Promise.withResolvers<string>();
      const native = Promise.withResolvers<void>();
      audio.refresh.mockReturnValueOnce(url.promise);
      audio.status = { ...audio.status, isLoaded: phase !== "URL pending" };
      if (phase === "mode pending") audio.setAudioMode.mockReturnValueOnce(native.promise);
      if (phase === "activation pending") audio.setActive.mockReturnValueOnce(native.promise);
      const container = document.createElement("div");
      root = createRoot(container);
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: {
              kind: "document",
              name: "sound.mp3",
              environmentId: EnvironmentId.make("environment-1"),
              resource: {
                _tag: "workspace-file",
                threadId: ThreadId.make("thread-1"),
                path: "/repo/sound.mp3",
              },
            },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 1 : 0);
      expect(audio.refresh).toHaveBeenCalledTimes(phase === "URL pending" ? 1 : 0);
      let recording!: ReturnType<typeof acquireAudioSession>;
      await act(async () => {
        recording = acquireAudioSession("recording");
      });
      expect(audio.player.pause).toHaveBeenCalled();
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      native.resolve();
      await activateAudioSession(recording);
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: true,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      const modeCalls = audio.setAudioMode.mock.calls.length;
      const activationCalls = audio.setActive.mock.calls.length;
      await act(async () => url.resolve("https://example.com/sound.mp3"));
      await act(async () => button.click());
      expect(audio.setAudioMode).toHaveBeenCalledTimes(modeCalls);
      expect(audio.setActive).toHaveBeenCalledTimes(activationCalls);
      expect(audio.setActive).not.toHaveBeenCalledWith(false);
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 1 : 0);
      await releaseAudioSession(recording);
      audio.status = { ...audio.status, isLoaded: true };
      // Refresh the native status before the next tap.
      await act(async () =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: { kind: "document", name: "sound.mp3", uri: "https://example.com/sound.mp3" },
            onOpen() {},
          }),
        ),
      );
      const replay = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => replay.click());
      expect(audio.player.play).toHaveBeenCalledTimes(phase === "playing" ? 2 : 1);
      expect(audio.setAudioMode).toHaveBeenLastCalledWith({
        allowsRecording: false,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
    },
  );

  it.each(["cancel", "unmount", "replay, stale first", "replay, latest first"])(
    "honors the latest audio intent after %s during URL resolution",
    async (intent) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      root = createRoot(container);
      const resolutions: Array<(uri: string) => void> = [];
      audio.refresh.mockImplementation(() => new Promise((resolve) => resolutions.push(resolve)));
      act(() =>
        root!.render(
          createElement(ThreadInlineFilePreview, {
            source: {
              kind: "document",
              name: "sound.mp3",
              environmentId: EnvironmentId.make("environment-1"),
              resource: {
                _tag: "workspace-file",
                threadId: ThreadId.make("thread-1"),
                path: "/repo/sound.mp3",
              },
            },
            onOpen() {},
          }),
        ),
      );
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      if (intent !== "unmount") {
        await act(async () => button.click());
        expect(button.getAttribute("aria-label")).toBe("Play audio");
      }
      const replay = intent.startsWith("replay");
      if (replay) {
        await act(async () => button.click());
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
        expect(audio.refresh).toHaveBeenCalledTimes(2);
      } else if (intent === "unmount") {
        act(() => root!.unmount());
        root = undefined;
      }
      const latestFirst = intent === "replay, latest first";
      if (latestFirst) await act(async () => resolutions[1]!("https://example.com/latest.mp3"));
      await act(async () => resolutions[0]!("https://example.com/stale.mp3"));
      expect(audio.player.play).toHaveBeenCalledTimes(latestFirst ? 1 : 0);
      expect(audio.player.replace).toHaveBeenCalledTimes(latestFirst ? 1 : 0);
      if (replay) {
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
        if (!latestFirst) {
          expect(container.textContent).toContain("Loading…");
          await act(async () => resolutions[1]!("https://example.com/latest.mp3"));
        }
        expect(audio.player.replace).toHaveBeenCalledExactlyOnceWith({
          uri: "https://example.com/latest.mp3",
        });
        expect(audio.player.play).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    "cancels a second tap while buffering with isLoaded=%s",
    async (isLoaded) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      root = createRoot(container);
      audio.status = { ...audio.status, isLoaded, isBuffering: isLoaded };
      let resolve: (uri: string) => void = () => {};
      audio.refresh.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const preview = createElement(ThreadInlineFilePreview, {
        source: {
          kind: "document",
          name: "sound.mp3",
          environmentId: EnvironmentId.make("environment-1"),
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: "/repo/sound.mp3",
          },
        },
        onOpen() {},
      });
      act(() => root!.render(preview));
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!;
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 1 : 0);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Pause audio");
      await act(async () => button.click());
      expect(audio.player.pause).toHaveBeenCalled();
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      if (!isLoaded) await act(async () => resolve("https://example.com/sound.mp3"));
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 1 : 0);
      if (!isLoaded) {
        expect(audio.player.replace).not.toHaveBeenCalled();
        audio.refresh.mockResolvedValue("https://example.com/sound.mp3");
      }
      await act(async () => button.click());
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 2 : 1);
      audio.status = { ...audio.status, isLoaded: true, didJustFinish: true, currentTime: 10 };
      await act(async () =>
        root!.render(createElement(ThreadInlineFilePreview, { ...preview.props })),
      );
      expect(button.getAttribute("aria-label")).toBe("Play audio");
      await act(async () => button.click());
      expect(audio.player.seekTo).toHaveBeenCalledWith(0);
      expect(audio.player.play).toHaveBeenCalledTimes(isLoaded ? 3 : 2);
    },
  );
});

describe("PDF preview detection", () => {
  it.each([
    [{ name: "download", mimeType: "application/pdf" }, true],
    [{ name: "download", mimeType: "APPLICATION/PDF; charset=binary" }, true],
    [{ name: "Report.PDF", mimeType: "application/octet-stream" }, true],
    [{ name: "https://example.com/report.pdf?signature=abc#page=2" }, true],
    [{ name: "report.pdf", mimeType: "text/plain" }, false],
    [{ name: "report.pdf.exe" }, false],
    [{ name: "https://example.com/page?download=report.pdf" }, false],
  ])("classifies %j as %s", (file, expected) => {
    expect(isPdfFile(file)).toBe(expected);
  });
});

describe("inline file previews", () => {
  it.each([
    [{ name: "sound.MP3" }, "audio"],
    [{ name: "sound", mimeType: "audio/wav" }, "audio"],
    [{ name: "report.PDF", mimeType: "text/plain" }, null],
    [{ name: "report.csv" }, null],
    [{ name: "report.tsv" }, null],
    [{ name: "report", mimeType: "text/csv; charset=utf-8" }, null],
    [{ name: "report.csv", mimeType: "image/png" }, null],
    [{ name: "image.png" }, null],
    [{ name: "clip.mp4" }, null],
    [{ name: "file.zip" }, null],
    [{ name: "report.docx" }, null],
    [{ name: "report.xlsx" }, null],
    [{ name: "report.pptx" }, null],
    [{ name: "download", mimeType: "application/pdf" }, null],
    [{ name: "sound.mp3", mimeType: "application/pdf" }, null],
  ])("classifies %j as %s", (file, expected) => {
    expect(inlineFilePreviewKind(file)).toBe(expected);
  });
});
