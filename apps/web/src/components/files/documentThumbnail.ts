import type { DocumentThumbnail, DocumentThumbnailKind } from "./documentThumbnailProtocol";
import { DOCUMENT_THUMBNAIL_MAX_BYTES } from "./documentThumbnailProtocol";
import { readBoundedDocument } from "./readBoundedDocument";
import type { OfficeWorkerResult } from "./officePreviewProtocol";

const cache = new Map<string, DocumentThumbnail | null>();
const pending = new Map<string, Promise<DocumentThumbnail | null>>();
const queue: (() => void)[] = [];
let running = 0;
let cachedBytes = 0;

export function loadDocumentThumbnail(
  key: string,
  input: {
    kind: DocumentThumbnailKind;
    file?: Blob | null;
    source: () => Promise<string | null>;
    ratio: number;
  },
): Promise<DocumentThumbnail | null> {
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const existing = pending.get(key);
  if (existing) return existing;
  if (queue.length >= 48) return Promise.resolve(null);
  const promise = new Promise<DocumentThumbnail | null>((resolve) => {
    const start = () => {
      running++;
      void render(input)
        .catch(() => null)
        .then((result) => {
          cache.set(key, result);
          cachedBytes += result?.blob.size ?? 0;
          while (cache.size > 48 || cachedBytes > 8 * 1024 * 1024) {
            const oldest = cache.keys().next().value!;
            cachedBytes -= cache.get(oldest)?.blob.size ?? 0;
            cache.delete(oldest);
          }
          pending.delete(key);
          resolve(result);
        })
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < 2) start();
    else queue.push(start);
  });
  pending.set(key, promise);
  return promise;
}

async function render(
  input: Parameters<typeof loadDocumentThumbnail>[1],
): Promise<DocumentThumbnail> {
  if ((input.file?.size ?? 0) > DOCUMENT_THUMBNAIL_MAX_BYTES)
    throw new Error("Thumbnail input too large.");
  const controller = new AbortController();
  const worker =
    input.kind === "pptx"
      ? new Worker(new URL("./officePreview.worker.ts", import.meta.url), { type: "module" })
      : new Worker(new URL("./documentThumbnail.worker.ts", import.meta.url), { type: "module" });
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const result = new Promise<DocumentThumbnail>((resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Thumbnail timed out.")), {
        once: true,
      });
      worker.addEventListener("error", () => reject(new Error("Thumbnail unavailable.")));
      worker.addEventListener(
        "message",
        (event: MessageEvent<DocumentThumbnail | OfficeWorkerResult>) => {
          const data = event.data;
          if ("blob" in data) resolve(data);
          else if (data.type === "error") reject(new Error(data.message));
          else if (data.type === "pptx")
            worker.postMessage({ type: "slide", index: 0, thumbnailRatio: input.ratio }, []);
        },
      );
    });
    // Attach a rejection handler before IO, which can fail before the worker replies.
    void result.catch(() => undefined);
    const bytes = input.file
      ? await input.file.arrayBuffer()
      : await readBoundedDocument(
          (await input.source()) ?? "",
          controller.signal,
          DOCUMENT_THUMBNAIL_MAX_BYTES,
        );
    if (bytes.byteLength > DOCUMENT_THUMBNAIL_MAX_BYTES)
      throw new Error("Thumbnail input too large.");
    controller.signal.throwIfAborted();
    worker.postMessage({ type: "open", bytes, kind: input.kind, ratio: input.ratio }, [bytes]);
    return await result;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    worker.terminate();
  }
}
