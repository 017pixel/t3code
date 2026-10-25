import { useNavigation } from "@react-navigation/native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { AppActivityIndicator } from "./ui/AppActivityIndicator";
import { AppText } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";
import { VideoThumbnailImage } from "./VideoThumbnailImage";
import { useMediaActions } from "../state/mediaActions";
import { type MediaActionsSource } from "../lib/mediaActionsSource";
import { isAppActive } from "../lib/appState";
import {
  isFullscreenVideoOpen,
  MediaShareScope,
  useMediaAudioSessionHold,
} from "../lib/videoAudioSession";
import { MediaActionsMenu } from "./MediaActionsMenu";

function LoadedMediaVideo(props: {
  readonly uri: string;
  readonly resolvePlaybackUri?: () => Promise<string | null>;
  readonly playRequested: boolean;
  readonly shareScope: MediaShareScope;
}) {
  const navigation = useNavigation();
  const fullscreen = useRef(false);
  const loading = useRef<AbortController | null>(null);
  // The player loads once when it mounts; a renewed signature is used on Retry,
  // not as a reason to reset the native player.
  const [initialSource] = useState(() => props);
  // Expo's Android player also reports completed playback as idle.
  const [loadState, setLoadState] = useState<"pending" | "complete" | "error">("pending");
  const player = useVideoPlayer(null, (player) => {
    player.staysActiveInBackground = false;
    player.bufferOptions = { preferredForwardBufferDuration: 5 };
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  useMediaAudioSessionHold(isPlaying, () => player.pause(), props.shareScope);

  const load = (source: typeof props) => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    setLoadState("pending");
    void (async () => {
      const uri = source.resolvePlaybackUri ? await source.resolvePlaybackUri() : source.uri;
      if (controller.signal.aborted) return;
      if (uri === null) throw new Error("Video unavailable");
      player.pause();
      await player.replaceAsync({ uri, contentType: "progressive" });
      if (controller.signal.aborted) return;
      const canPlay =
        navigation.isFocused() &&
        isAppActive() &&
        !isFullscreenVideoOpen() &&
        !source.shareScope.sharing;
      if (source.playRequested && canPlay) player.play();
    })().then(
      () => {
        if (!controller.signal.aborted) setLoadState("complete");
      },
      () => {
        if (!controller.signal.aborted) setLoadState("error");
      },
    );
  };

  const attachVideoView = (view: VideoView | null) => {
    if (view === null) return;
    load(initialSource);
    const offBlur = navigation.addListener("blur", () => player.pause());
    // RN reports both leaving the app and Android fullscreen as background; native handling distinguishes them.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "inactive" || (state === "background" && !fullscreen.current)) player.pause();
    });
    return () => {
      loading.current?.abort();
      offBlur();
      appState.remove();
    };
  };

  return (
    <View collapsable={false} style={{ flex: 1 }}>
      <VideoView
        ref={attachVideoView}
        player={player}
        style={{ width: "100%", height: "100%" }}
        surfaceType="textureView"
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        onFullscreenEnter={() => {
          fullscreen.current = true;
        }}
        onFullscreenExit={() => {
          fullscreen.current = false;
        }}
        allowsPictureInPicture={false}
      />
      {loadState === "error" || (loadState === "complete" && status === "error") ? (
        <View className="absolute inset-0 items-center justify-center gap-2 bg-black px-4">
          <AppText className="text-center text-sm text-white/80">Video unavailable</AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry video"
            onPress={() => load(props)}
            className="min-h-11 justify-center px-4"
          >
            <AppText className="text-sm text-white">Retry</AppText>
          </Pressable>
        </View>
      ) : loadState === "pending" || status === "loading" ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator color="#ffffff" accessibilityLabel="Loading video" />
        </View>
      ) : null}
    </View>
  );
}

interface MediaVideoPlayerProps {
  readonly uri: string | null;
  readonly resolvePlaybackUri?: () => Promise<string | null>;
  readonly name: string;
  readonly thumbnailKey: string;
  readonly thumbnailVisible?: boolean;
  readonly unavailable?: boolean;
  readonly expanded?: boolean;
  readonly autoPlay?: boolean;
  readonly actionsSource?: MediaActionsSource;
  /** Set when the share offered for this player lives outside it, as in a preview modal. */
  readonly shareScope?: MediaShareScope;
}

function MediaVideoPlayerContent(props: MediaVideoPlayerProps) {
  const [ownShareScope] = useState(() => new MediaShareScope());
  const shareScope = props.shareScope ?? ownShareScope;
  const mediaActions = useMediaActions(props.actionsSource, undefined, shareScope);
  const [playbackUri, setPlaybackUri] = useState<string | null>(props.expanded ? props.uri : null);
  // Keep an opened player mounted while signing or reconnecting temporarily has no usable URL.
  if (playbackUri === null && props.expanded && props.uri !== null) setPlaybackUri(props.uri);

  return (
    <View
      collapsable={false}
      className="overflow-hidden rounded-[10px] bg-black"
      style={props.expanded ? { flex: 1 } : { width: "100%", maxWidth: 480, aspectRatio: 16 / 9 }}
    >
      {playbackUri ? (
        <LoadedMediaVideo
          uri={props.uri ?? playbackUri}
          resolvePlaybackUri={props.resolvePlaybackUri}
          playRequested={!props.expanded || props.autoPlay === true}
          shareScope={shareScope}
        />
      ) : (
        <MediaActionsMenu media={mediaActions} inModal={props.expanded} style={{ flex: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Play ${props.name}`}
            accessibilityHint={
              mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
            }
            accessibilityState={{ disabled: props.uri === null || props.unavailable === true }}
            // Stays pressable so the long-press menu still opens on a failed or unsigned tile.
            onPress={() => {
              if (props.uri !== null && !props.unavailable) setPlaybackUri(props.uri);
            }}
            className="flex-1 items-center justify-center px-4"
          >
            {!props.unavailable ? (
              <VideoThumbnailImage
                cacheKey={props.thumbnailKey}
                source={props.thumbnailVisible === false ? null : props.uri}
                contentFit="contain"
              />
            ) : null}
            {props.unavailable ? (
              <AppText className="text-sm text-white/80">Video unavailable</AppText>
            ) : props.uri === null ? (
              <AppActivityIndicator color="#ffffff" accessibilityLabel="Loading video" />
            ) : (
              <View className="size-12 items-center justify-center rounded-full bg-black/60">
                <SymbolView name="play" size={28} tintColor="#ffffff" type="monochrome" />
              </View>
            )}
            {props.uri !== null && !props.unavailable ? (
              <AppText
                className="absolute right-2 bottom-2 max-w-[75%] rounded bg-black/60 px-2 py-1 text-right text-xs text-white"
                numberOfLines={1}
              >
                {props.name}
              </AppText>
            ) : null}
          </Pressable>
        </MediaActionsMenu>
      )}
    </View>
  );
}

export function MediaVideoPlayer(props: MediaVideoPlayerProps) {
  return <MediaVideoPlayerContent key={props.thumbnailKey} {...props} />;
}
