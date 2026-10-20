import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { inlineFilePreviewKind, isPdfFile } from "./filePreview";
import { ThreadInlineFilePreview } from "../features/threads/ThreadInlineFilePreview";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";

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
  player: { play: vi.fn(), pause: vi.fn(), replace: vi.fn(), seekTo: vi.fn(async () => {}) },
  refresh: vi.fn<() => Promise<string | null>>(),
  setAudioMode: vi.fn(async (_mode: unknown) => {}),
  setActive: vi.fn(async (_active: boolean) => {}),
}));
vi.mock("expo-audio", () => ({
  useAudioPlayer: () => audio.player,
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
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.clearAllMocks();
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

  it.each(["play", "cancel", "unmount", "mode failure", "activation failure"])(
    "reactivates audio after voice release and honors %s during activation",
    async (intent) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      // Voice release clears recording mode and deactivates Expo's global audio gate.
      await setAudioModeAsync({ allowsRecording: false });
      await setIsAudioActiveAsync(false);
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
        expect(audio.setActive).toHaveBeenCalledTimes(intent === "mode failure" ? 1 : 2);
        return;
      }
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
      expect(audio.setAudioMode.mock.invocationCallOrder[1]).toBeLessThan(
        audio.setActive.mock.invocationCallOrder[1]!,
      );
      if (intent === "cancel") await act(async () => button.click());
      else if (intent === "unmount") {
        act(() => root!.unmount());
        root = undefined;
      }
      await act(async () => activate());
      if (intent === "play") {
        expect(audio.player.play).toHaveBeenCalledOnce();
        expect(button.getAttribute("aria-label")).toBe("Pause audio");
      } else {
        expect(audio.player.play).not.toHaveBeenCalled();
        if (intent === "cancel") expect(button.getAttribute("aria-label")).toBe("Play audio");
      }
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
      expect(audio.player.pause).toHaveBeenCalledOnce();
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
