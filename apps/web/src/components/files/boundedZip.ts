import JSZip from "jszip";

import {
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
  BINARY_PREVIEW_MAX_BYTES,
} from "./binaryPreviewProtocol";

export async function boundedZip(bytes: ArrayBuffer, entryLimit = BINARY_PREVIEW_MAX_BYTES) {
  if (bytes.byteLength > BINARY_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  // Reject oversized directories before JSZip allocates objects for their entries.
  const view = new DataView(bytes);
  let directoryFound = false;
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 65557);
    offset--
  ) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    if (offset + 22 + view.getUint16(offset + 20, true) !== bytes.byteLength) continue;
    if (view.getUint16(offset + 10, true) > ARCHIVE_MAX_ENTRIES)
      throw new Error("This archive contains more than 2,048 entries.");
    directoryFound = true;
    break;
  }
  if (!directoryFound) throw new Error("This is not a readable ZIP archive.");
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > ARCHIVE_MAX_ENTRIES)
    throw new Error("This archive contains more than 2,048 entries.");
  const files = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; date: Date; directory: boolean }
  >();
  let total = 0;
  for (const entry of entries) {
    if (entry.name.length > 1024) throw new Error("An archive path is too long to preview.");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (
        entry as JSZip.JSZipObject & {
          internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array<ArrayBuffer>>;
        }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          total += chunk.length;
          length += chunk.length;
          if (
            total > BINARY_PREVIEW_MAX_BYTES ||
            total > Math.max(1, bytes.byteLength) * ARCHIVE_MAX_RATIO ||
            length > entryLimit ||
            (entry.name.endsWith(".xml") && length > 8 * 1024 * 1024)
          ) {
            stream.pause();
            reject(
              new Error(
                "The expanded archive exceeds the preview size or compression ratio limit.",
              ),
            );
          } else chunks.push(chunk);
        })
        .on("error", reject)
        .on("end", resolve)
        .resume();
    });
    const content = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    files.set(entry.name, { bytes: content, date: entry.date, directory: entry.dir });
  }
  return files;
}
