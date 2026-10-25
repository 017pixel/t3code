import type { DocumentThumbnail, DocumentThumbnailKind } from "./documentThumbnailProtocol";
import { DOCUMENT_THUMBNAIL_MAX_BYTES } from "./documentThumbnailProtocol";
import { readBoundedDocument } from "./readBoundedDocument";

const cache = new Map<string, DocumentThumbnail | null>();
type ThumbnailJob = {
  promise: Promise<DocumentThumbnail | null>;
  controller: AbortController;
  subscribers: number;
  finished: boolean;
  start: () => void;
  resolve: (result: DocumentThumbnail | null) => void;
};
const pending = new Map<string, ThumbnailJob>();
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
  signal?: AbortSignal,
): Promise<DocumentThumbnail | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const existing = pending.get(key);
  if (existing) return subscribe(key, existing, signal);
  if (queue.length >= 48) return Promise.resolve(null);
  let resolve!: (result: DocumentThumbnail | null) => void;
  const promise = new Promise<DocumentThumbnail | null>((complete) => {
    resolve = complete;
  });
  const job: ThumbnailJob = {
    promise,
    resolve,
    controller: new AbortController(),
    subscribers: 0,
    finished: false,
    start: () => {
      running++;
      void render(input, job.controller)
        .catch(() => null)
        .then((result) => {
          if (!job.controller.signal.aborted) {
            cache.set(key, result);
            cachedBytes += result?.blob.size ?? 0;
            while (cache.size > 48 || cachedBytes > 8 * 1024 * 1024) {
              const oldest = cache.keys().next().value!;
              cachedBytes -= cache.get(oldest)?.blob.size ?? 0;
              cache.delete(oldest);
            }
          }
          job.finished = true;
          if (pending.get(key) === job) pending.delete(key);
          resolve(result);
        })
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    },
  };
  pending.set(key, job);
  const subscribed = subscribe(key, job, signal);
  if (running < 2) job.start();
  else queue.push(job.start);
  return subscribed;
}

function subscribe(key: string, job: ThumbnailJob, signal?: AbortSignal) {
  job.subscribers++;
  return new Promise<DocumentThumbnail | null>((resolve) => {
    let released = false;
    const finish = (result: DocumentThumbnail | null) => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", abort);
      if (--job.subscribers === 0 && !job.finished) {
        job.controller.abort();
        const queued = queue.indexOf(job.start);
        if (queued !== -1) queue.splice(queued, 1);
        if (pending.get(key) === job) pending.delete(key);
        job.resolve(null);
      }
      resolve(result);
    };
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    void job.promise.then(finish);
  });
}

async function render(
  input: Parameters<typeof loadDocumentThumbnail>[1],
  controller: AbortController,
): Promise<DocumentThumbnail> {
  if ((input.file?.size ?? 0) > DOCUMENT_THUMBNAIL_MAX_BYTES)
    throw new Error("Thumbnail input too large.");
  const worker = new Worker(new URL("./documentThumbnail.worker.ts", import.meta.url), {
    type: "module",
  });
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let rejectCancellation!: (cause: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = () => {
    worker.terminate();
    rejectCancellation(new Error("Thumbnail cancelled."));
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    const result = new Promise<DocumentThumbnail>((resolve, reject) => {
      worker.addEventListener("error", () => reject(new Error("Thumbnail unavailable.")));
      worker.addEventListener(
        "message",
        (event: MessageEvent<DocumentThumbnail | { type: "error"; message: string }>) => {
          const data = event.data;
          if ("blob" in data) resolve(data);
          else if (data.type === "error") reject(new Error(data.message));
        },
      );
    });
    // Attach a rejection handler before IO, which can fail before the worker replies.
    void result.catch(() => undefined);
    const inputBytes = input.file
      ? input.file.arrayBuffer()
      : input.source().then((url) => {
          controller.signal.throwIfAborted();
          return readBoundedDocument(url ?? "", controller.signal, DOCUMENT_THUMBNAIL_MAX_BYTES);
        });
    const bytes = await Promise.race([inputBytes, cancelled]);
    if (bytes.byteLength > DOCUMENT_THUMBNAIL_MAX_BYTES)
      throw new Error("Thumbnail input too large.");
    controller.signal.throwIfAborted();
    worker.postMessage({ type: "open", bytes, kind: input.kind, ratio: input.ratio }, [bytes]);
    return await Promise.race([result, cancelled]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}
