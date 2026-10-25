import * as Dialog from "./ui/Dialog";
import { requireNativeModule } from "expo";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useId } from "react";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { usePreviewPresentation, videoPreviewKey } from "../lib/previewPresentation";
import { fullscreenVideoClosed, fullscreenVideoOpened } from "../lib/videoAudioSession";
import { mediaVideoPreviewUri, type VideoPreviewSource } from "../lib/videoPreviewSource";
import { refreshAssetUrl } from "../state/assets";
import { usePreparedConnection } from "../state/session";

export type { VideoPreviewSource } from "../lib/videoPreviewSource";

const NativeControls = requireNativeModule<{
  presentVideo(
    uri: string,
    title: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  dismissVideo(identifier: string): Promise<void>;
}>("T3NativeControls");

function NativeVideoPreview(props: {
  readonly source: VideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const localAttachment = source.type === "local" ? source.attachment : null;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const environmentId =
    source.type === "media" && "environmentId" in source ? source.environmentId : null;
  const preparedConnection = usePreparedConnection(environmentId);
  const name = source.type === "media" ? source.name : source.attachment.name;
  // Mints a fresh URL for each presentation: AVKit retains the URL and offers no retry,
  // so a cached link that expired while the app was suspended would fail to play.
  const resolvePlaybackUrl = useEffectEvent(async (): Promise<string> => {
    if (source.type !== "media") throw new Error("Could not load this video.");
    if (!("resource" in source)) return source.uri;
    const url = await refreshAssetUrl(source.environmentId, source.resource);
    if (url !== null) return mediaVideoPreviewUri(source, url)!;
    throw new Error(
      preparedConnection._tag === "None"
        ? "Reconnect to this environment and open the video again."
        : "Could not load this video. Check the connection and try again.",
    );
  });
  const reauthorize = useEffectEvent(() => {
    if (source.type === "media" && "resource" in source) {
      void refreshAssetUrl(source.environmentId, source.resource);
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    let ready = false;
    fullscreenVideoOpened();
    void (async () => {
      const file =
        localAttachment !== null
          ? await loadLocalAttachmentPreview(localAttachment, controller.signal)
          : null;
      if (localAttachment !== null && !file) return;
      const uri = file?.uri ?? (await resolvePlaybackUrl());
      if (controller.signal.aborted) {
        file?.dispose();
        return;
      }
      ready = true;
      const presented = await settlePromise(() =>
        NativeControls.presentVideo(uri, name, source.sourceIdentifier ?? "", identifier),
      );
      // Native completion follows dismissal, so local playback keeps its file lease.
      file?.dispose();
      if (AsyncResult.isFailure(presented)) throw squashAtomCommandFailure(presented);
      if (!controller.signal.aborted) onRequestClose();
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      // AVKit gives no retry, so re-mint now; the minted URL may already be unusable.
      if (ready) reauthorize();
      Dialog.alert(
        "Could not open video",
        ready
          ? "This video couldn't be loaded or played. Check the connection, or touch and hold the video to save or share the original."
          : error instanceof Error
            ? error.message
            : "Could not load this video.",
      );
      onRequestClose();
    });
    return () => {
      controller.abort();
      fullscreenVideoClosed();
      void NativeControls.dismissVideo(identifier).catch(() => undefined);
    };
  }, [localAttachment, name, source.sourceIdentifier, identifier]);

  return null;
}

export function VideoPreviewModal(props: {
  readonly source: VideoPreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  usePreviewPresentation(
    props.source === null ? null : videoPreviewKey(props.source),
    props.onRequestClose,
  );
  if (!props.source) return null;
  return <NativeVideoPreview source={props.source} onRequestClose={props.onRequestClose} />;
}
