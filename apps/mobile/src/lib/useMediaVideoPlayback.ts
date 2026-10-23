import { useIsFocused } from "@react-navigation/native";
import { useEvent } from "expo";
import type { VideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "./videoAudioSession";

export function useMediaVideoPlayback(
  player: VideoPlayer,
  options: { readonly paused: boolean; readonly visible?: boolean },
) {
  const focused = useIsFocused();
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  const paused = options.paused || fullscreenVideoOpen || options.visible === false;
  const active = useRef(focused && !paused && AppState.currentState === "active");
  const fullscreen = useRef(false);
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  useMediaAudioSessionHold(isPlaying);

  useEffect(() => {
    active.current = focused && !paused && AppState.currentState === "active";
    if (!focused || paused || (!active.current && !fullscreen.current)) player.pause();
    // Native background handling distinguishes Android's fullscreen activity
    // from leaving the app; React Native reports both as background.
    const subscription = AppState.addEventListener("change", (state) => {
      active.current = focused && !paused && state === "active";
      if (state === "inactive" || (state === "background" && !fullscreen.current)) player.pause();
    });
    return () => subscription.remove();
  }, [focused, player, paused]);

  const playIfActive = useCallback(() => {
    if (active.current) player.play();
  }, [player]);

  const onFullscreenEnter = useCallback(() => {
    fullscreen.current = true;
  }, []);
  const onFullscreenExit = useCallback(() => {
    fullscreen.current = false;
  }, []);

  return { playIfActive, onFullscreenEnter, onFullscreenExit };
}
