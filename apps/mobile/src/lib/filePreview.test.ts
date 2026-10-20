import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { inlineFilePreviewKind, isPdfFile } from "./filePreview";
import { ThreadInlineFilePreview } from "../features/threads/ThreadInlineFilePreview";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

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
}));
vi.mock("expo-audio", () => ({
  useAudioPlayer: () => audio.player,
  useAudioPlayerStatus: () => audio.status,
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
