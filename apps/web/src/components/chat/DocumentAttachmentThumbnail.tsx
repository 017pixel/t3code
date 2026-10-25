import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { FileTextIcon } from "lucide-react";
import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { SNAP_SHOT_ATTACHMENT_FRAME_CLASS } from "./SnapShotAttachmentDetails";
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

export function DocumentAttachmentThumbnail(props: {
  readonly file: ThumbnailFile;
  readonly environmentId: EnvironmentId;
  readonly attachmentId?: string | undefined;
  readonly onOpen: () => void;
  readonly fallback: ReactNode;
  readonly children?: ReactNode;
  readonly detailClassName?: string | undefined;
  readonly fallbackClassName?: string | undefined;
}) {
  const { file } = props;
  const kind = documentThumbnailKind(file);
  const target = useRef<HTMLDivElement>(null);
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
    let cancelled = false;
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
    void import("../files/documentThumbnail")
      .then(({ loadDocumentThumbnail }) =>
        loadDocumentThumbnail(key, {
          kind,
          file: file.file ?? null,
          source: () => source(),
          ratio,
        }),
      )
      .then((result) => {
        if (cancelled || !result) return;
        objectUrl = URL.createObjectURL(result.blob);
        setThumbnail({ src: objectUrl, label: result.label, identity, file: file.file });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
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
  return (
    <div
      ref={target}
      className={
        thumbnail
          ? cn(
              SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
              "group/attachment shrink-0 snap-start bg-background",
            )
          : cn("min-w-0 max-w-full shrink-0", props.fallbackClassName)
      }
    >
      {thumbnail ? (
        <>
          <button
            type="button"
            aria-label={`Preview ${file.name}`}
            onClick={props.onOpen}
            className="block h-full w-full cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
          >
            <img
              src={thumbnail.src}
              alt=""
              className="block h-full w-full object-cover object-top"
            />
            <span
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 bg-linear-to-t from-black/85 via-black/55 to-transparent px-2.5 pb-2 pt-6 text-left",
                props.detailClassName,
              )}
            >
              <FileTextIcon className="size-5 shrink-0 text-white" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-2xs font-medium leading-3.5 text-white">
                  {file.name}
                </span>
                <span className="block truncate text-3xs leading-3.5 text-white/70">
                  {thumbnail.label}
                </span>
              </span>
            </span>
          </button>
          {props.children}
        </>
      ) : (
        props.fallback
      )}
    </div>
  );
}
