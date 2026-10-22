import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

// Ten VP8 frames at 10 fps, with no audio.
const FRAME_STEP_VIDEO =
  "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKkEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggEiTbuMU6uEHFO7a1OsggKO7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiECPQAAAAAAAFlSua9euAQAAAAAAAE7XgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgkLCBELqBEJqBAlWwhFW5gQFV7oEA7AEAAAAAAAACAAASVMNn0HNzzWPAi2PFiAAAAAAAAAABZ8iYRaOHRU5DT0RFUkSHi0xhdmMgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMS4wMDAwMDAwMDAAH0O2dUER54EAo72BAACA8AIAnQEqEAAQAABHCIWFiIWEiAICAnWqA/gD+gINTRgA/v1u8//jmTcwxP+Obf/xYTwOKMj/8VEAo5WBAGQAsQEABRCsABgAGFgv9AAIAACjlYEAyACxAQAFEKwAGAAYWC/0AAgAAKOVgQEsALEBAAUQrAAYABhYL/QACAAAo5WBAZAAsQEABRCsABgAGFgv9AAIAACjlYEB9ACxAQAFEKwAGAAYWC/0AAgAAKOVgQJYALEBAAUQrAAYABhYL/QACAAAo5WBArwAsQEABRAQFGAAYWC/0AAgAACjlYEDIACxAQAFEKwAGAAYWC/0AAgAAKOVgQOEALEBAAUQrAAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBd/CBAw==";

// The observer never reports the video as visible, so it keeps preload="none" and never
// requests these fake URLs; the test fires the media events itself.
class HiddenIntersectionObserver {
  observe() {}
  disconnect() {}
}

function expectVideoSrc(screen: Screen, src: string) {
  return expect.element(screen.getByLabelText("clip")).toHaveAttribute("src", src);
}

async function loadMetadata(screen: Screen) {
  await act(() => {
    screen.getByLabelText("clip").element().dispatchEvent(new Event("loadedmetadata"));
  });
}

describe("MediaVideoPlayer", () => {
  it("keeps a loaded paused video when only its URL is re-signed", async () => {
    using _observer = stubGlobal("IntersectionObserver", HiddenIntersectionObserver);
    await using screen = await render(
      <MediaVideoPlayer src="/asset/first/clip.mp4" label="clip" revision="file-1" />,
    );
    await loadMetadata(screen);

    await screen.rerender(
      <MediaVideoPlayer src="/asset/renewed/clip.mp4" label="clip" revision="file-1" />,
    );
    await expectVideoSrc(screen, "/asset/first/clip.mp4");

    await screen.rerender(
      <MediaVideoPlayer src="/asset/changed/clip.mp4" label="clip" revision="file-2" />,
    );
    await expectVideoSrc(screen, "/asset/changed/clip.mp4");

    // A second re-sign while the changed file is still loading must not restart that load.
    await screen.rerender(
      <MediaVideoPlayer src="/asset/changed-renewed/clip.mp4" label="clip" revision="file-2" />,
    );
    await expectVideoSrc(screen, "/asset/changed/clip.mp4");
  });

  it("keeps a loaded paused video while its URL is briefly unavailable", async () => {
    using _observer = stubGlobal("IntersectionObserver", HiddenIntersectionObserver);
    await using screen = await render(
      <MediaVideoPlayer src="/asset/first/clip.mp4" label="clip" revision="file-1" />,
    );
    await loadMetadata(screen);

    await screen.rerender(<MediaVideoPlayer src={null} label="clip" revision="mutation-2" />);
    await expectVideoSrc(screen, "/asset/first/clip.mp4");
  });

  it("pauses playback and steps exactly one frame in either direction", async () => {
    await using screen = await render(
      <MediaVideoPlayer src={FRAME_STEP_VIDEO} label="clip" preload="metadata" />,
    );
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    await vi.waitFor(() => expect(video.readyState).toBeGreaterThanOrEqual(2));
    video.muted = true;
    await video.play();
    video.currentTime = 0.25;
    video.dispatchEvent(new KeyboardEvent("keydown", { key: ".", bubbles: true }));
    expect(video.paused).toBe(true);
    await vi.waitFor(() => expect(video.currentTime).toBeCloseTo(0.35));
    video.dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true }));
    await vi.waitFor(() => expect(video.currentTime).toBeCloseTo(0.25));
  });

  it("handles rapid steps from the dialog's initial focus without affecting text inputs", async () => {
    await using screen = await render(
      <div role="dialog" aria-label="Video preview">
        <button type="button">Close</button>
        <input aria-label="Notes" />
        <MediaVideoPlayer src={FRAME_STEP_VIDEO} label="clip" preload="metadata" />
      </div>,
    );
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    await vi.waitFor(() => expect(video.readyState).toBeGreaterThanOrEqual(2));
    video.currentTime = 0.25;
    const close = screen.getByRole("button", { name: "Close" }).element();
    for (const key of [".", ".", ".", ","]) {
      close.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
    await vi.waitFor(() => expect(video.currentTime).toBeCloseTo(0.45));
    const input = screen.getByRole("textbox", { name: "Notes" }).element();
    const typing = new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true });
    input.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
    const modified = new KeyboardEvent("keydown", {
      key: ".",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    close.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(video.currentTime).toBeCloseTo(0.45);
  });

  it("leaves other inline videos and unrelated keyboard events alone", async () => {
    await using screen = await render(
      <>
        <button type="button">Outside</button>
        <MediaVideoPlayer src={FRAME_STEP_VIDEO} label="clip" preload="metadata" />
        <MediaVideoPlayer src={FRAME_STEP_VIDEO} label="other" preload="metadata" />
      </>,
    );
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    const other = screen.getByLabelText("other").element() as HTMLVideoElement;
    await vi.waitFor(() => {
      expect(video.readyState).toBeGreaterThanOrEqual(2);
      expect(other.readyState).toBeGreaterThanOrEqual(2);
    });
    video.currentTime = 0.25;
    other.currentTime = 0.25;
    const outside = screen.getByRole("button", { name: "Outside" }).element();
    const unrelated = new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true });
    outside.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
    video.dispatchEvent(new KeyboardEvent("keydown", { key: ".", bubbles: true }));
    await vi.waitFor(() => expect(video.currentTime).toBeCloseTo(0.35));
    expect(other.currentTime).toBeCloseTo(0.25);
  });
});
