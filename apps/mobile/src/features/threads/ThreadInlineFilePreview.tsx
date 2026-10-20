import { useIsFocused } from "@react-navigation/native";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { filePreviewKey } from "../../lib/filePreviewGallery";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "../../lib/videoAudioSession";
import { useRefreshAssetUrl } from "../../state/assets";
import { ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";

type PreviewProps = {
  readonly source: FilePreviewSource;
  readonly sizeBytes?: number;
  readonly onOpen: () => void;
  readonly onLongPress?: () => void;
};

function FileCardHeader(props: PreviewProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.source.name}`}
      onPress={props.onOpen}
      onLongPress={props.onLongPress}
      className="h-[72px] flex-row items-center gap-3 p-3 active:bg-subtle"
    >
      <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
        <PierreEntryIcon path={props.source.name ?? "file"} kind="file" size={26} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {props.source.name}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          Audio
          {props.sizeBytes !== undefined ? ` · ${formatAttachmentSize(props.sizeBytes)}` : ""}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function InlineAudio(props: PreviewProps & { readonly resolveUri: () => Promise<string | null> }) {
  // An empty source keeps native buffering off until the user explicitly plays.
  const player = useAudioPlayer(null, { updateInterval: 500, downloadFirst: false });
  const status = useAudioPlayerStatus(player);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(true);
  const opening = useRef(false);
  const playRequested = useRef(false);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const requestPlayback = useCallback((requested: boolean) => {
    playRequested.current = requested;
    setPlaybackRequested(requested);
    if (!requested) setLoading(false);
  }, []);
  useMediaAudioSessionHold(status.playing);
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  useEffect(() => {
    if (fullscreenVideoOpen || status.didJustFinish || status.error) {
      // oxlint-disable-next-line react/set-state-in-effect -- Native completion and fullscreen takeover invalidate the pending playback request.
      requestPlayback(false);
    }
    if (fullscreenVideoOpen) player.pause();
  }, [fullscreenVideoOpen, status.didJustFinish, status.error, player, requestPlayback]);
  useEffect(() => {
    active.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        requestPlayback(false);
        player.pause();
      }
    });
    return () => {
      active.current = false;
      playRequested.current = false;
      subscription.remove();
    };
  }, [player, requestPlayback]);
  const toggle = () => {
    if (status.playing || playRequested.current) {
      requestPlayback(false);
      return player.pause();
    }
    if (opening.current) return;
    requestPlayback(true);
    opening.current = true;
    setLoading(true);
    setError(false);
    void Promise.resolve()
      .then(async () => {
        if (!playRequested.current) return;
        if (!status.isLoaded || status.error) {
          const uri = await props.resolveUri();
          if (!active.current || !playRequested.current || AppState.currentState !== "active")
            return;
          if (!uri) {
            requestPlayback(false);
            setError(true);
            return;
          }
          player.replace({ uri });
        } else if (status.didJustFinish || status.currentTime >= status.duration) {
          await player.seekTo(0);
        }
        if (active.current && playRequested.current && AppState.currentState === "active")
          player.play();
      })
      .catch(() => {
        if (active.current && playRequested.current) {
          requestPlayback(false);
          setError(true);
        }
      })
      .finally(() => {
        opening.current = false;
        if (active.current) setLoading(false);
      });
  };
  const progress =
    status.duration > 0 ? Math.min(1, Math.max(0, status.currentTime / status.duration)) : 0;
  const playing = playbackRequested || status.playing;
  const busy = loading || (playbackRequested && status.isBuffering);
  return (
    <>
      <FileCardHeader
        {...props}
        onOpen={() => {
          requestPlayback(false);
          player.pause();
          props.onOpen();
        }}
      />
      <View className="h-14 flex-row items-center gap-3 px-3 pb-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            playing ? "Pause audio" : error || status.error ? "Retry audio" : "Play audio"
          }
          accessibilityState={{ busy }}
          onPress={toggle}
          className="h-11 w-11 items-center justify-center rounded-lg bg-subtle"
        >
          <SymbolView
            name={playing ? "pause" : "play"}
            size={18}
            tintColorClassName="accent-foreground"
          />
        </Pressable>
        <View className="min-w-0 flex-1 gap-2">
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: status.duration || 0, now: status.currentTime }}
            className="h-1 overflow-hidden rounded-full bg-subtle"
          >
            <View className="h-1 bg-foreground-muted" style={{ width: `${progress * 100}%` }} />
          </View>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {error || status.error
              ? "Unavailable · tap play to retry"
              : busy
                ? "Loading…"
                : `${timestamp(status.currentTime)} / ${status.isLoaded ? timestamp(status.duration) : "--:--"}`}
          </Text>
        </View>
      </View>
    </>
  );
}

function VisibleFilePreview(props: PreviewProps) {
  // Each mounted preview owns its source; feed streaming must not restart a fetch or player.
  const [source] = useState(props.source);
  const refresh = useRefreshAssetUrl(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const resolveUri = useCallback(
    () => ("uri" in source ? Promise.resolve(source.uri) : refresh()),
    [source, refresh],
  );
  return <InlineAudio {...props} resolveUri={resolveUri} />;
}

export function ThreadInlineFilePreview(props: PreviewProps) {
  const visible = useContext(ThreadMediaVisibleContext);
  const focused = useIsFocused();
  return (
    <View
      className="my-1 overflow-hidden rounded-xl border border-border bg-card"
      style={{ width: 280, maxWidth: "100%" }}
    >
      {visible && focused ? (
        <VisibleFilePreview key={filePreviewKey(props.source)} {...props} />
      ) : (
        <>
          <FileCardHeader {...props} />
          <View className="h-14" />
        </>
      )}
    </View>
  );
}
