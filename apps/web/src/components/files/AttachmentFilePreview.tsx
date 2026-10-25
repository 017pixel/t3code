import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { useAtomValue } from "@effect/atom-react";
import type { AssetResource, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";
import {
  decodeFilePreviewText,
  filePreviewKind,
  FILE_TEXT_PREVIEW_MAX_BYTES,
} from "@t3tools/shared/filePreview";
import { ChevronRightIcon, DownloadIcon, Trash2Icon, WrapTextIcon, XIcon } from "lucide-react";
import { Check, Code2, Copy, Eye, Table2 } from "lucide";
import { lazy, Suspense, useState } from "react";

import {
  resolveAssetUrl,
  revisionedAssetUrl,
  useAssetUrlRefresh,
  useAssetUrlState,
} from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePreparedConnection } from "~/state/session";

import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";

type PreviewText = Awaited<ReturnType<typeof readFilePreviewResponse>>;

class AttachmentPreviewError extends Schema.TaggedError<AttachmentPreviewError>()(
  "AttachmentPreviewError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

const readPreviewText = (read: (signal: AbortSignal) => Promise<PreviewText>) =>
  Effect.tryPromise({
    try: read,
    catch: (cause) =>
      new AttachmentPreviewError({
        reason: cause instanceof Error ? cause.message : "Could not load this file.",
        cause,
      }),
  });

// The atom owns the object URL, so it is revoked once nothing shows the Blob.
const localFileUrlAtom = Atom.family((file: Blob) =>
  Atom.make((get) => {
    const url = URL.createObjectURL(file);
    get.addFinalizer(() => URL.revokeObjectURL(url));
    return url;
  }),
);

const localFileTextAtom = Atom.family((file: Blob) =>
  Atom.make(
    readPreviewText((signal) => readFilePreviewResponse({ ok: true, body: file.stream() }, signal)),
  ),
);

// Reads a bounded prefix and stops the body there, even when the host ignores
// the requested range.
const readRemotePreviewText = Effect.fn("AttachmentFilePreview.readRemoteText")(
  function* (url: string, options: { readonly ranged: boolean; readonly reload: boolean }) {
    const response = yield* HttpClient.get(
      url,
      options.ranged ? { headers: { Range: `bytes=0-${FILE_TEXT_PREVIEW_MAX_BYTES}` } } : {},
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.provideService(FetchHttpClient.RequestInit, {
        cache: options.reload ? "reload" : "default",
      }),
    );
    const limit = FILE_TEXT_PREVIEW_MAX_BYTES + 1;
    const chunks: Uint8Array[] = [];
    let length = 0;
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        const kept = chunk.subarray(0, limit - length);
        chunks.push(kept);
        length += kept.length;
        return length < limit;
      }),
    );
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return yield* Effect.try({
      try: () => decodeFilePreviewText(bytes),
      catch: (cause) =>
        new AttachmentPreviewError({
          reason: cause instanceof Error ? cause.message : "Could not load this file.",
          cause,
        }),
    });
  },
  Effect.catchTags({
    HttpClientError: (cause) =>
      Effect.fail(
        new AttachmentPreviewError({
          reason: "The file could not be loaded. Reconnect and try again.",
          cause,
        }),
      ),
  }),
  Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  Effect.provide(FetchHttpClient.layer),
);

const remoteFileTextAtom = Atom.family((key: string) => {
  const [environmentId, resource, revision, httpBaseUrl, sizeBytes, pinnedUrl] = JSON.parse(
    key,
  ) as [EnvironmentId, AssetResource, number, string, number, string];
  return Atom.make(
    Effect.fn("AttachmentFilePreview.remoteFileText")(function* (get: Atom.AtomContext) {
      // Read once: the asset layer re-mints the URL on a timer, and the same bytes
      // need no refetch. The current URL covers a fetch made after the pinned media
      // URL expired (toggling HTML source); the pinned one covers a failed re-mint.
      const minted = get.once(
        revisionedAssetUrl({ environmentId, input: { resource }, revision: String(revision) }),
      );
      const url =
        (minted._tag === "Success"
          ? resolveAssetUrl(httpBaseUrl, minted.value.relativeUrl)
          : null) ?? pinnedUrl;
      return yield* readRemotePreviewText(url, { ranged: sizeBytes > 0, reload: revision !== 0 });
    }),
  );
});

const EMPTY_LOCAL_URL_ATOM = Atom.make<string | null>(null);
const EMPTY_TEXT_ATOM = Atom.make<AsyncResult.AsyncResult<PreviewText, unknown>>(
  AsyncResult.initial(),
);

const SourcePreview = lazy(() => import("./ReadOnlySourcePreview"));

export function ReadOnlySourcePreview(props: { name: string; text: string }) {
  return (
    <Suspense fallback={<FileSurfaceLoading className="p-4" />}>
      <SourcePreview {...props} />
    </Suspense>
  );
}

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

export function AttachmentFilePreview(props: {
  name: string;
  mimeType: string;
  sizeBytes: number;
  file?: Blob | null;
  asset?: { environmentId: EnvironmentId; attachmentId: string };
  htmlRender?: boolean;
  threadRef?: ScopedThreadRef;
  origin?: string;
  onRemove?: () => void;
  onClose?: () => void;
}) {
  const kind = filePreviewKind(props);
  const delimiter = filePreviewDelimiter(props);
  const renderedMode =
    kind === "markdown" ? "markdown" : kind === "html" ? "html" : delimiter ? "table" : null;
  const attachmentId = props.asset?.attachmentId;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: props.name });
  const resource = attachmentId
    ? {
        _tag: "attachment" as const,
        attachmentId,
        fileName: props.name,
        mimeType: props.mimeType,
        disposition: "inline" as const,
      }
    : null;
  const downloadResource = resource ? { ...resource, disposition: "attachment" as const } : null;
  const prepareDownload = useAssetUrlRefresh(props.asset?.environmentId ?? null, downloadResource);
  const [saving, setSaving] = useState(false);
  const [rendered, setRendered] = useState(true);
  // Retry bumps the revision, which mints a fresh URL for the attachment.
  const [revision, setRevision] = useState(0);
  const remote = useAssetUrlState(
    props.file ? null : (props.asset?.environmentId ?? null),
    props.file ? null : resource,
    String(revision),
  );
  const [mediaError, setMediaError] = useState<string | null>(null);
  const localUrl = useAtomValue(props.file ? localFileUrlAtom(props.file) : EMPTY_LOCAL_URL_ATOM);
  const preparedConnection = usePreparedConnection(props.asset?.environmentId ?? null);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  // The asset layer re-mints the URL on a timer. A new URL is the same bytes, so
  // the first settled URL of each revision stays the media src until Retry;
  // swapping it would restart playback.
  const settledRemoteUrl = remote._tag === "Success" && !remote.waiting ? remote.url : null;
  const pinKey = JSON.stringify([props.asset?.environmentId, resource, revision]);
  const [pinnedRemote, setPinnedRemote] = useState<{ key: string; url: string } | null>(null);
  if (settledRemoteUrl !== null && pinnedRemote?.key !== pinKey) {
    setPinnedRemote({ key: pinKey, url: settledRemoteUrl });
  }
  const remoteUrl = pinnedRemote?.key === pinKey ? pinnedRemote.url : null;
  const url = props.file ? localUrl : remoteUrl;
  const error =
    mediaError ??
    (!props.file && remoteUrl === null && remote._tag === "Failure" && !remote.waiting
      ? "The attachment is unavailable."
      : null);
  const needsText = kind === "text" || kind === "markdown" || (kind === "html" && !rendered);
  // Waits for the pinned URL so a failed mint shows the media error, not a text one.
  const textResult = useAtomValue(
    !needsText || !url
      ? EMPTY_TEXT_ATOM
      : props.file
        ? localFileTextAtom(props.file)
        : props.asset && resource && httpBaseUrl
          ? remoteFileTextAtom(
              JSON.stringify([
                props.asset.environmentId,
                resource,
                revision,
                httpBaseUrl,
                props.sizeBytes,
                url,
              ]),
            )
          : EMPTY_TEXT_ATOM,
  );
  const content = textResult._tag === "Success" ? textResult.value : null;
  const contentError =
    textResult._tag === "Failure"
      ? (() => {
          const cause = Cause.squash(textResult.cause);
          return cause instanceof Error ? cause.message : "Could not load this file.";
        })()
      : null;
  const failure = error ?? (needsText ? contentError : null);
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const showsRawText =
    failure === null &&
    needsText &&
    content !== null &&
    !(delimiter && rendered) &&
    !(kind === "markdown" && rendered);

  const save = () => {
    setSaving(true);
    void settlePromise(async () => {
      let file = props.file;
      if (!file) {
        const target = await prepareDownload();
        if (!target) throw new Error("Reconnect to the environment and try again.");
        const response = await fetch(target);
        if (!response.ok) throw new Error("The file could not be loaded. Try again.");
        file = await response.blob();
      }
      // Blob downloads keep desktop's custom app scheme from navigating to an external browser.
      const downloadUrl = URL.createObjectURL(file);
      // Scheduled before the click so the URL is revoked even if the click throws.
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = props.name;
      anchor.click();
    }).then((result) => {
      if (!AsyncResult.isSuccess(result)) {
        const cause = Cause.squash(result.cause);
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: cause instanceof Error ? cause.message : "Please try again.",
        });
      }
      setSaving(false);
    });
  };

  const body = failure ? (
    <FileSurfaceFailure
      message={failure}
      onRetry={() => {
        setMediaError(null);
        // A remote retry reads under a new revision; a local Blob is read again.
        if (props.file) appAtomRegistry.refresh(localFileTextAtom(props.file));
        setRevision((value) => value + 1);
      }}
    />
  ) : !url || (needsText && !content) ? (
    <FileSurfaceLoading />
  ) : needsText && content ? (
    delimiter && rendered ? (
      <DelimitedTablePreview name={props.name} text={content.text} delimiter={delimiter} />
    ) : kind === "markdown" && rendered ? (
      <ScrollArea className="min-h-0 flex-1">
        <ChatMarkdown text={content.text} cwd={undefined} className="mx-auto max-w-4xl px-6 py-5" />
      </ScrollArea>
    ) : (
      <ReadOnlySourcePreview name={props.name} text={content.text} />
    )
  ) : kind === "pdf" || kind === "html" ? (
    <BrowserDocumentFrame
      src={url}
      title={props.name}
      pdf={kind === "pdf"}
      htmlRender={props.htmlRender === true}
      threadRef={props.threadRef}
    />
  ) : kind === "audio" ? (
    <AudioPreview
      src={url}
      name={props.name}
      onError={() => setMediaError("Unable to load audio.")}
    />
  ) : kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        controls
        playsInline
        src={url}
        aria-label={props.name}
        className="max-h-full max-w-full"
        onError={() => setMediaError("Unable to load video.")}
      />
    </div>
  ) : kind === "image" ? (
    // oxlint-disable-next-line t3code/require-centered-scroll-gutter -- The image is capped at max-h-full max-w-full, so this never scrolls.
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={props.name}
        className="max-h-full max-w-full object-contain"
        onError={() => setMediaError("Unable to load image.")}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium">No preview for this file</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Save it to open in an app that supports {props.name.split(".").at(-1) || "this format"}{" "}
        files.
      </p>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className={cn(FILE_SURFACE_SUBHEADER_CLASS)} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center text-xs">
          <span className="shrink-0 px-0.5 text-muted-foreground">
            {props.origin ?? "Attachment"}
          </span>
          <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
          <span aria-current="page" className="min-w-0 truncate px-0.5 font-medium text-foreground">
            {props.name}
          </span>
          {props.sizeBytes > 0 ? (
            <span className="ml-2 shrink-0 text-muted-foreground">
              {formatAttachmentSize(props.sizeBytes)}
            </span>
          ) : null}
        </div>
        {renderedMode ? (
          <FileSurfaceAction
            label={renderedToggleLabel(renderedMode, rendered)}
            pressed={rendered}
            onPress={() => setRendered((value) => !value)}
          >
            <MorphIcon
              className="size-3.5"
              icon={rendered ? Code2 : renderedMode === "table" ? Table2 : Eye}
            />
          </FileSurfaceAction>
        ) : null}
        {showsRawText ? (
          <FileSurfaceAction
            label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
            pressed={wordWrap}
            onPress={() => updateClientSettings({ wordWrap: !wordWrap })}
          >
            <WrapTextIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {content ? (
          <FileSurfaceAction
            label={isCopied ? "Copied" : content.truncated ? "Copy preview" : "Copy contents"}
            onPress={() => copyToClipboard(content.text, undefined)}
          >
            <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
          </FileSurfaceAction>
        ) : null}
        {url ? (
          <FileSurfaceAction
            label={saving ? "Preparing file…" : "Save file"}
            disabled={saving}
            onPress={save}
          >
            <DownloadIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onRemove ? (
          <FileSurfaceAction label="Remove from draft" onPress={props.onRemove}>
            <Trash2Icon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
        {props.onClose ? (
          <FileSurfaceAction label="Close" onPress={props.onClose}>
            <XIcon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
      </div>
      {content?.truncated ? (
        <FileSurfaceNotice>
          Preview limited to the first 1 MB
          {props.sizeBytes > 0 ? ` of a ${props.sizeBytes.toLocaleString()} byte file` : ""}. Save
          the file to read it in full.
        </FileSurfaceNotice>
      ) : null}
      {body}
    </div>
  );
}
