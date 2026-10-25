import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useAssetUrlRefresh } from "~/assets/assetUrls";
import {
  documentThumbnailKind,
  DOCUMENT_THUMBNAIL_MAX_BYTES,
} from "../files/documentThumbnailProtocol";

type ThumbnailFile = {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly file?: Blob | null;
};

const thumbnailLoader = () => import("../files/documentThumbnail");

export function DocumentAttachmentThumbnail(props: {
  readonly file: ThumbnailFile;
  readonly environmentId: EnvironmentId;
  readonly attachmentId?: string | undefined;
  readonly fallback: ReactNode;
  readonly children: (preview: { icon: ReactNode; label: string | undefined }) => ReactNode;
}) {
  const { file } = props;
  const kind = documentThumbnailKind(file);
  const target = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setThumbnail] = useState<{
    src: string;
    label: string;
    identity: string;
    file: Blob | null | undefined;
  } | null>(null);
  const identity = JSON.stringify([
    props.environmentId,
    props.attachmentId ?? file.id,
    file.name,
    file.mimeType,
    file.sizeBytes,
  ]);
  const thumbnail = result?.identity === identity && result.file === file.file ? result : null;
  const refresh = useAssetUrlRefresh(
    props.environmentId,
    props.attachmentId
      ? {
          _tag: "attachment",
          attachmentId: props.attachmentId,
          fileName: file.name,
          mimeType: file.mimeType,
          disposition: "inline",
        }
      : null,
  );
  const source = useEffectEvent(refresh);
  useEffect(() => {
    const node = target.current;
    if (!node || !kind || file.sizeBytes > DOCUMENT_THUMBNAIL_MAX_BYTES) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [kind, file.sizeBytes]);
  useEffect(() => {
    if (!visible || !kind || file.sizeBytes > DOCUMENT_THUMBNAIL_MAX_BYTES) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const key = JSON.stringify([
      props.environmentId,
      props.attachmentId ?? file.id,
      file.name,
      file.sizeBytes,
      file.file instanceof File ? file.file.lastModified : 0,
      ratio,
    ]);
    void thumbnailLoader()
      .then(({ loadDocumentThumbnail }) =>
        loadDocumentThumbnail(
          key,
          {
            kind,
            file: file.file ?? null,
            source: () => source(),
            ratio,
          },
          controller.signal,
        ),
      )
      .then((result) => {
        if (controller.signal.aborted || !result) return;
        objectUrl = URL.createObjectURL(result.blob);
        setThumbnail({ src: objectUrl, label: result.label, identity, file: file.file });
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    visible,
    kind,
    file.file,
    file.id,
    file.name,
    file.sizeBytes,
    props.environmentId,
    props.attachmentId,
    identity,
  ]);
  const [failedSrc, setFailedSrc] = useState<string>();
  const available = thumbnail && thumbnail.src !== failedSrc ? thumbnail : null;
  return (
    <span ref={target} className="inline-flex max-w-full align-middle">
      {props.children({
        icon: (
          <span className="relative inline-flex size-[1.17em] shrink-0 items-center justify-center">
            {available ? (
              <img
                src={available.src}
                alt=""
                className="block rounded-xs border border-foreground/15 bg-white object-cover object-top"
                style={
                  kind === "pptx"
                    ? { width: "100%", height: "60%" }
                    : { width: "75%", height: "100%" }
                }
                onError={() => setFailedSrc(available.src)}
              />
            ) : (
              props.fallback
            )}
          </span>
        ),
        label: available?.label || undefined,
      })}
    </span>
  );
}
