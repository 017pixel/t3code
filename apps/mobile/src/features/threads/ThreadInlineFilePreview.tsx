/* oxlint-disable react/no-array-index-key -- Preview cells have stable positions and may contain identical values. */
import { useIsFocused } from "@react-navigation/native";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { fetch } from "expo/fetch";
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, View } from "react-native";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { filePreviewKey } from "../../lib/filePreviewGallery";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { INLINE_TABLE_MAX_BYTES, readInlineTable } from "../../lib/filePreview";
import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "../../lib/videoAudioSession";
import { useRefreshAssetUrl } from "../../state/assets";
import { ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";

type InlineKind = "audio" | "pdf" | "table";
type PreviewProps = {
  readonly kind: InlineKind;
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
          {props.kind === "table" ? "Table · first 5 rows" : props.kind === "pdf" ? "PDF" : "Audio"}
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
  useMediaAudioSessionHold(status.playing);
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  useEffect(() => {
    if (fullscreenVideoOpen) {
      playRequested.current = false;
      player.pause();
    }
  }, [fullscreenVideoOpen, player]);
  useEffect(() => {
    active.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        playRequested.current = false;
        player.pause();
      }
    });
    return () => {
      active.current = false;
      playRequested.current = false;
      subscription.remove();
    };
  }, [player]);
  const toggle = async () => {
    if (opening.current) return;
    if (status.playing) {
      playRequested.current = false;
      return player.pause();
    }
    playRequested.current = true;
    opening.current = true;
    setLoading(true);
    setError(false);
    try {
      if (!status.isLoaded || status.error) {
        const uri = await props.resolveUri();
        if (!active.current || AppState.currentState !== "active") return;
        if (!uri) throw new Error("Audio unavailable");
        player.replace({ uri });
      } else if (status.didJustFinish || status.currentTime >= status.duration) {
        await player.seekTo(0);
      }
      if (active.current && playRequested.current && AppState.currentState === "active")
        player.play();
    } catch {
      if (active.current) setError(true);
    } finally {
      opening.current = false;
      if (active.current) setLoading(false);
    }
  };
  const progress =
    status.duration > 0 ? Math.min(1, Math.max(0, status.currentTime / status.duration)) : 0;
  return (
    <>
      <FileCardHeader
        {...props}
        onOpen={() => {
          playRequested.current = false;
          player.pause();
          props.onOpen();
        }}
      />
      <View className="h-14 flex-row items-center gap-3 px-3 pb-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            status.playing ? "Pause audio" : error || status.error ? "Retry audio" : "Play audio"
          }
          accessibilityState={{ busy: loading || status.isBuffering, disabled: loading }}
          disabled={loading}
          onPress={() => void toggle()}
          className="h-11 w-11 items-center justify-center rounded-lg bg-subtle"
        >
          <SymbolView
            name={status.playing ? "pause" : "play"}
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
              : loading || status.isBuffering
                ? "Loading…"
                : `${timestamp(status.currentTime)} / ${status.isLoaded ? timestamp(status.duration) : "--:--"}`}
          </Text>
        </View>
      </View>
    </>
  );
}

function InlineTable(props: PreviewProps & { readonly resolveUri: () => Promise<string | null> }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState(false);
  const delimiter = filePreviewDelimiter({
    name: props.source.name ?? "",
    mimeType: props.source.mimeType,
  });
  const { resolveUri } = props;
  useEffect(() => {
    if (!delimiter) return;
    const controller = new AbortController();
    void (async () => {
      const uri = await resolveUri();
      if (controller.signal.aborted) return;
      if (!uri) throw new Error("Table unavailable");
      const response = await fetch(uri, {
        signal: controller.signal,
        headers: { Range: `bytes=0-${INLINE_TABLE_MAX_BYTES - 1}` },
      });
      const value = await readInlineTable(response, controller.signal, delimiter);
      if (!controller.signal.aborted) setRows(value);
    })().catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [resolveUri, delimiter]);
  return (
    <>
      <FileCardHeader {...props} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open table ${props.source.name}`}
        onPress={props.onOpen}
        onLongPress={props.onLongPress}
        className="h-[140px] overflow-hidden border-t border-border"
      >
        {rows?.length ? (
          rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              className={rowIndex === 0 ? "h-7 flex-row bg-subtle" : "h-7 flex-row"}
            >
              {row.map((cell, columnIndex) => (
                <View
                  key={columnIndex}
                  className="min-w-0 flex-1 justify-center border-r border-b border-border px-2"
                >
                  <Text
                    numberOfLines={1}
                    className={
                      rowIndex === 0
                        ? "text-xs font-t3-semibold text-foreground"
                        : "text-xs text-foreground"
                    }
                  >
                    {cell}
                  </Text>
                </View>
              ))}
            </View>
          ))
        ) : (
          <Text className="p-3 text-xs text-foreground-muted">
            {error ? "Table unavailable. Tap to open." : rows ? "Empty table" : "Loading table…"}
          </Text>
        )}
      </Pressable>
    </>
  );
}

function InlinePdf(props: PreviewProps & { readonly resolveUri: () => Promise<string | null> }) {
  const [sizeBytes, setSizeBytes] = useState<number>();
  const { resolveUri } = props;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const uri = await resolveUri();
      if (!uri || controller.signal.aborted) return;
      const response = await fetch(uri, { method: "HEAD", signal: controller.signal });
      const length = response.headers.get("Content-Length");
      const size = length ? Number(length) : NaN;
      if (response.ok && Number.isFinite(size) && size >= 0 && !controller.signal.aborted)
        setSizeBytes(size);
    })().catch(() => undefined);
    return () => controller.abort();
  }, [resolveUri]);
  return <FileCardHeader {...props} sizeBytes={sizeBytes} />;
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
  return props.kind === "pdf" ? (
    <InlinePdf {...props} resolveUri={resolveUri} />
  ) : props.kind === "audio" ? (
    <InlineAudio {...props} resolveUri={resolveUri} />
  ) : (
    <InlineTable {...props} resolveUri={resolveUri} />
  );
}

export function ThreadInlineFilePreview(props: PreviewProps) {
  const visible = useContext(ThreadMediaVisibleContext);
  const focused = useIsFocused();
  let body: ReactNode = (
    <>
      <FileCardHeader {...props} />
      <View style={{ height: props.kind === "audio" ? 56 : 140 }} />
    </>
  );
  if (props.kind === "pdf") body = <FileCardHeader {...props} />;
  if (visible && focused && (props.kind !== "pdf" || props.sizeBytes === undefined))
    body = <VisibleFilePreview key={filePreviewKey(props.source)} {...props} />;
  return (
    <View
      className="my-1 overflow-hidden rounded-xl border border-border bg-card"
      style={{ width: 280, maxWidth: "100%" }}
    >
      {body}
    </View>
  );
}
