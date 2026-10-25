import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { XMLParser } from "fast-xml-parser";
import { boundedZip } from "./boundedZip";
import {
  DOCUMENT_THUMBNAIL_MAX_BYTES,
  type DocumentThumbnailKind,
} from "./documentThumbnailProtocol";

async function render(bytes: ArrayBuffer, kind: DocumentThumbnailKind, ratio: number) {
  if (bytes.byteLength > DOCUMENT_THUMBNAIL_MAX_BYTES)
    throw new Error("Thumbnail input too large.");
  const canvas = new OffscreenCanvas(Math.ceil(208 * ratio), Math.ceil(112 * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable.");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  let label: string;
  if (kind === "pdf") {
    const { openPdf } = await import("./pdfDocument");
    const task = openPdf(bytes);
    try {
      const document = await task.promise;
      const page = await document.getPage(1);
      const viewport = page.getViewport({
        scale: canvas.width / page.getViewport({ scale: 1 }).width,
      });
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
        background: "white",
      }).promise;
      label = `PDF · ${document.numPages} ${document.numPages === 1 ? "page" : "pages"}`;
    } finally {
      await task.destroy();
    }
  } else if (kind === "csv") {
    // A prefix is sufficient for a thumbnail, even if its last row is incomplete.
    const { rows } = parseDelimitedPreview(
      new TextDecoder().decode(bytes.slice(0, 64 * 1024)),
      ",",
      { maxRows: 8, maxColumns: 5, maxCellLength: 60 },
    );
    if (!rows.length) throw new Error("Empty table.");
    context.scale(ratio, ratio);
    context.font = "8px sans-serif";
    const columns = Math.max(...rows.map((row) => row.length));
    const width = 208 / columns;
    rows.forEach((row, y) =>
      row.forEach((cell, x) => {
        context.fillStyle = y === 0 ? "#e5eaf0" : y % 2 ? "white" : "#f5f6f8";
        context.fillRect(x * width, y * 18, width - 1, 17);
        context.save();
        context.beginPath();
        context.rect(x * width + 3, y * 18, width - 6, 18);
        context.clip();
        context.fillStyle = "#243346";
        context.fillText(cell, x * width + 4, y * 18 + 12);
        context.restore();
      }),
    );
    label = "CSV · First rows";
  } else if (kind === "epub") {
    const files = await boundedZip(bytes, 8 * 1024 * 1024, { totalLimit: 24 * 1024 * 1024 });
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      processEntities: false,
    });
    const decode = (path: string) => new TextDecoder().decode(files.get(path)?.bytes);
    const container = parser.parse(decode("META-INF/container.xml"));
    const root = container.container?.rootfiles?.rootfile;
    const packagePath = (Array.isArray(root) ? root[0] : root)?.["full-path"];
    if (typeof packagePath !== "string") throw new Error("No EPUB package.");
    const metadata = parser.parse(decode(packagePath)).package;
    const items = [metadata.manifest.item].flat();
    const coverId = [metadata.metadata?.meta ?? []]
      .flat()
      .find((item) => item?.name === "cover")?.content;
    const cover =
      items.find((item) =>
        String(item.properties ?? "")
          .split(/\s+/)
          .includes("cover-image"),
      ) ?? items.find((item) => item.id === coverId);
    if (!cover || typeof cover.href !== "string") throw new Error("No EPUB cover.");
    const base = packagePath.slice(0, packagePath.lastIndexOf("/") + 1);
    const path = new URL(cover.href, `https://epub.invalid/${base}`).pathname.slice(1);
    const image = files.get(decodeURIComponent(path));
    if (!image || !/^image\/(png|jpeg|webp|gif)$/.test(cover["media-type"]))
      throw new Error("Unsupported cover.");
    const bitmap = await createImageBitmap(new Blob([image.bytes]), {
      resizeWidth: canvas.width,
      resizeQuality: "high",
    });
    try {
      context.drawImage(bitmap, 0, 0, canvas.width, bitmap.height);
    } finally {
      bitmap.close();
    }
    label = "EPUB · Cover";
  } else throw new Error("Unsupported thumbnail.");
  return { blob: await canvas.convertToBlob({ type: "image/webp", quality: 0.85 }), label };
}
self.addEventListener(
  "message",
  (event: MessageEvent<{ bytes: ArrayBuffer; kind: DocumentThumbnailKind; ratio: number }>) => {
    const { bytes, kind, ratio } = event.data;
    void render(bytes, kind, Math.max(1, Math.min(3, ratio)))
      .then((result) => self.postMessage(result, { transfer: [] }))
      .catch(() =>
        self.postMessage({ type: "error", message: "Thumbnail unavailable." }, { transfer: [] }),
      );
  },
);
