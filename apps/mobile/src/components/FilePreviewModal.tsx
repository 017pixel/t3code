import * as Dialog from "./ui/Dialog";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { usePreviewPresentation } from "../lib/previewPresentation";
import { refreshAssetUrl } from "../state/assets";
import { filePreviewGallery, filePreviewKey, filePreviewName } from "../lib/filePreviewGallery";
import { FilePreviewGallery } from "./FilePreviewGallery";
import { FilePreview } from "./FilePreview";
import type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

class PreviewResolutionError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly fallbackMessage: string,
  ) {
    super(fallbackMessage, { cause });
  }
}

interface ResolvedPreviewItem {
  readonly source: ResolvedFilePreviewSource;
  readonly dispose?: () => void;
}

async function resolvePreviewItem(
  item: FilePreviewItem,
  signal: AbortSignal,
): Promise<ResolvedPreviewItem | null> {
  const name = filePreviewName(item);
  if ("attachment" in item) {
    const file = await loadLocalAttachmentPreview(item.attachment, signal).catch(
      (error: unknown) => {
        throw new PreviewResolutionError(error, "Attach the file again and retry.");
      },
    );
    return file && { source: { ...item, name, uri: file.uri }, dispose: file.dispose };
  }
  if (!("environmentId" in item)) return { source: { ...item, name } };
  // Refresh expired URLs before handing them to Quick Look or ACTION_VIEW, which retain them.
  const url = await refreshAssetUrl(item.environmentId, item.resource)
    .then((value) => {
      if (!value) throw new Error("Reconnect to this environment and try again.");
      return value;
    })
    .catch((error: unknown) => {
      throw new PreviewResolutionError(
        error,
        "Reconnect to this environment and try again. The file may have been moved or deleted.",
      );
    });
  return { source: { ...item, name, uri: url + (item.srcFragment ?? "") } };
}

function ResolvedFilePreview(props: {
  readonly source: FilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  // Freeze the group at opening; streaming messages and URL refreshes must not reopen the viewer.
  const [items] = useState(() => filePreviewGallery(props.source, []));
  const selectedKey = filePreviewKey(props.source);
  const [gallery, setGallery] = useState<readonly ResolvedFilePreviewSource[] | null>(() =>
    items.every((item) => "uri" in item)
      ? items.map((item) => ({ ...item, name: filePreviewName(item) }))
      : null,
  );
  const onResolutionError = useEffectEvent((error: PreviewResolutionError) => {
    if (props.onOpenError) props.onOpenError(error.cause);
    else Dialog.alert("Could not open preview", error.fallbackMessage);
    props.onRequestClose();
  });
  // Resolves once per presentation and holds local file leases until it closes.
  useEffect(() => {
    if (items.every((item) => "uri" in item)) return;
    const controller = new AbortController();
    const resolving = Promise.allSettled(
      items.map((item) => resolvePreviewItem(item, controller.signal)),
    );
    void resolving.then((settled) => {
      if (controller.signal.aborted) return;
      const failure = settled.find((item) => item.status === "rejected");
      if (failure) {
        onResolutionError(
          failure.reason instanceof PreviewResolutionError
            ? failure.reason
            : new PreviewResolutionError(failure.reason, "Try again."),
        );
        return;
      }
      const sources = settled.flatMap((item) =>
        item.status === "fulfilled" && item.value ? [item.value.source] : [],
      );
      if (sources.length === items.length) setGallery(sources);
    });
    return () => {
      controller.abort();
      void resolving.then((settled) => {
        for (const item of settled) if (item.status === "fulfilled") item.value?.dispose?.();
      });
    };
  }, [items]);
  const selected = gallery?.[items.findIndex((item) => filePreviewKey(item) === selectedKey)];
  if (!gallery || !selected) return null;
  return (
    <FilePreview
      source={{ ...selected, gallery }}
      onRequestClose={props.onRequestClose}
      onOpenError={props.onOpenError}
    />
  );
}

export function FilePreviewModal(props: {
  readonly source: FilePreviewSource | null;
  readonly onRequestClose: () => void;

  readonly onOpenError?: (error: unknown) => void;
}) {
  const group = useContext(FilePreviewGallery);
  const source =
    props.source === null
      ? null
      : { ...props.source, gallery: filePreviewGallery(props.source, group) };
  usePreviewPresentation(source && filePreviewKey(source), props.onRequestClose);

  if (!source) return null;
  return (
    <ResolvedFilePreview
      key={filePreviewKey(source)}
      source={source}
      onRequestClose={props.onRequestClose}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}
