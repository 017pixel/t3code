import { useEffect, useState } from "react";

import { isContextMenuOpen } from "../contextMenuFallback";
import { isEditableFocused } from "../lib/editableFocus";
import { adjacentVideoFrameTime, readVideoFrameTimestamps } from "../lib/videoFrameStepping";

export function useVideoFrameStepping(video: HTMLVideoElement | null, src: string | null) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!video || !src) return;
    const controller = new AbortController();
    let timestamps: Promise<Float64Array> | undefined;
    let pending = Promise.resolve();
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "," && event.key !== ".") ||
        isEditableFocused(event.target) ||
        isContextMenuOpen()
      )
        return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[role="menu"], [role="listbox"]')) return;
      const dialog = video.closest('[role="dialog"]');
      if (dialog ? target.closest('[role="dialog"]') !== dialog : !video.contains(target)) return;
      if (video.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(video.duration))
        return;

      event.preventDefault();
      event.stopPropagation();
      video.pause();
      const direction = event.key === "," ? -1 : 1;
      // Keep rapid key presses in order while the first metadata read is in flight.
      pending = pending.then(async () => {
        if (controller.signal.aborted) return;
        try {
          const frames = await (timestamps ??= readVideoFrameTimestamps(src, controller.signal));
          if (controller.signal.aborted || !video.paused) return;
          video.currentTime = adjacentVideoFrameTime(
            frames,
            video.currentTime,
            video.duration,
            direction,
          );
          setFailedSrc(null);
        } catch {
          if (!controller.signal.aborted) setFailedSrc(src);
          timestamps = undefined;
        }
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      controller.abort();
    };
  }, [video, src]);

  return src !== null && failedSrc === src;
}
