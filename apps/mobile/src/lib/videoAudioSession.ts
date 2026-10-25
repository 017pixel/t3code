import { requireOptionalNativeModule } from "expo";
import { useEffect, useEffectEvent } from "react";
import { Platform } from "react-native";

const nativeControls = requireOptionalNativeModule<{
  releaseVideoAudioSession(): Promise<void>;
}>("T3NativeControls");

// Keep the session through seeks, buffering, and brief gaps between players.
const RELEASE_DELAY_MS = 1_000;

let playingCount = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

export function mediaPlaybackStarted(): void {
  playingCount += 1;
}

/** expo-video never deactivates iOS playback, preventing interrupted apps from resuming. Include audio previews to avoid stopping them. */
export function mediaPlaybackStopped(): void {
  playingCount -= 1;
  if (playingCount > 0 || Platform.OS !== "ios") return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    if (playingCount > 0) return;
    void nativeControls?.releaseVideoAudioSession().catch(() => undefined);
  }, RELEASE_DELAY_MS);
}

let fullscreenCount = 0;
const playingMedia = new Set<() => void>();

/** A fullscreen AVKit player owns the audio session; inline players must not play under it. */
export function fullscreenVideoOpened(): void {
  fullscreenCount += 1;
  for (const pause of Array.from(playingMedia)) pause();
}

export function fullscreenVideoClosed(): void {
  fullscreenCount -= 1;
}

export function isFullscreenVideoOpen(): boolean {
  return fullscreenCount > 0;
}

/**
 * The players a share sheet covers: only the player that offered the share
 * pauses, and it must not start playing while that sheet is open.
 */
export class MediaShareScope {
  #playing = new Set<() => void>();
  #openShares = 0;

  get sharing(): boolean {
    return this.#openShares > 0;
  }

  shareStarted(): void {
    this.#openShares += 1;
    for (const pause of Array.from(this.#playing)) pause();
  }

  shareEnded(): void {
    this.#openShares -= 1;
  }

  register(pause: () => void): () => void {
    this.#playing.add(pause);
    return () => {
      this.#playing.delete(pause);
    };
  }
}

/**
 * Holds the shared audio session while `playing`, and registers `pause` so a
 * fullscreen video, or a share from `shareScope`, can stop this player.
 */
export function useMediaAudioSessionHold(
  playing: boolean,
  pause: () => void,
  shareScope?: MediaShareScope,
): void {
  const pauseNow = useEffectEvent(pause);
  // The native session refcount must be released when a playing player unmounts.
  useEffect(() => {
    if (!playing) return;
    const entry = () => pauseNow();
    mediaPlaybackStarted();
    playingMedia.add(entry);
    const unregister = shareScope?.register(entry);
    return () => {
      unregister?.();
      playingMedia.delete(entry);
      mediaPlaybackStopped();
    };
  }, [playing, shareScope]);
}
