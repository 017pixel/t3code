import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { decodeFilePreviewText, filePreviewKind } from "@t3tools/shared/filePreview";

export function inlineFilePreviewKind(file: { readonly name: string; readonly mimeType?: string }) {
  if (filePreviewDelimiter(file)) return "table" as const;
  const kind = filePreviewKind(file);
  return kind === "audio" || kind === "pdf" ? kind : null;
}

export const INLINE_TABLE_MAX_BYTES = 32 * 1024;

export async function readInlineTable(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
  delimiter: "," | "\t",
) {
  if (!response.ok || signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Table unavailable. Open the file to try again.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming file previews are unavailable.");
  const bytes = new Uint8Array(INLINE_TABLE_MAX_BYTES);
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (length < bytes.length) {
      if (signal.aborted) throw new Error("Preview cancelled.");
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, bytes.length - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
  }
  if (signal.aborted) throw new Error("Preview cancelled.");
  const content = decodeFilePreviewText(bytes.subarray(0, length), length === bytes.length);
  return parseDelimitedPreview(content.text, delimiter)
    .rows.slice(0, 5)
    .map((row) => row.slice(0, 3));
}

export function isPdfFile(file: { readonly name: string; readonly mimeType?: string }): boolean {
  const mimeType = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType && mimeType !== "application/octet-stream") return mimeType === "application/pdf";
  return /\.pdf$/i.test(file.name.split(/[?#]/, 1)[0] ?? "");
}
