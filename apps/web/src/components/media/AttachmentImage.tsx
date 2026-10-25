import { useRef, useState, type ComponentProps, type SyntheticEvent } from "react";
import {
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  prepareImageForAttachment,
} from "../../lib/imageCompression";

type AttachmentImageProps = ComponentProps<"img"> & { name: string; mimeType?: string | undefined };

export function AttachmentImage({ name, mimeType, ...props }: AttachmentImageProps) {
  return isHeicImageFile({ name, type: mimeType ?? "" }) ? (
    <HeicImage key={props.src} {...props} name={name} />
  ) : (
    <img {...props} />
  );
}

/** Resolves to a blob URL the caller owns, or null when the image cannot be decoded. */
async function decodeHeicPreview(
  src: string,
  name: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(src, { signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (signal.aborted) return null;
    const result = await prepareImageForAttachment(
      new File([blob], name, { type: "image/heic" }),
      MAX_COMPRESSIBLE_SOURCE_BYTES,
    );
    return result.ok && !signal.aborted ? URL.createObjectURL(result.file) : null;
  } catch {
    return null;
  }
}

type DecodeAttempt = { readonly controller: AbortController; objectUrl?: string };

function HeicImage({ name, src, onError, ...props }: Omit<AttachmentImageProps, "mimeType">) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  // One decode per mount; the parent keys this component by src.
  const decodeRef = useRef<DecodeAttempt | null>(null);

  // The browser cannot show HEIC itself, so its load error starts the decode.
  const decode = (event: SyntheticEvent<HTMLImageElement>) => {
    if (decodeRef.current !== null || !src) return onError?.(event);
    const attempt: DecodeAttempt = { controller: new AbortController() };
    decodeRef.current = attempt;
    void decodeHeicPreview(src, name, attempt.controller.signal).then((url) => {
      if (attempt.controller.signal.aborted) return;
      if (url === null) return onError?.(event);
      attempt.objectUrl = url;
      setPreviewUrl(url);
    });
  };

  const releaseDecode = () => () => {
    const attempt = decodeRef.current;
    if (attempt === null) return;
    attempt.controller.abort();
    if (attempt.objectUrl) URL.revokeObjectURL(attempt.objectUrl);
  };

  return <img {...props} ref={releaseDecode} src={previewUrl ?? src} onError={decode} />;
}
