import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

// PDF.js also runs inside our thumbnail worker, where there is no document.
class ThumbnailCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(target: { canvas: OffscreenCanvas }, width: number, height: number) {
    target.canvas.width = Math.ceil(width);
    target.canvas.height = Math.ceil(height);
  }
  destroy(target: {
    canvas: OffscreenCanvas | null;
    context: OffscreenCanvasRenderingContext2D | null;
  }) {
    if (target.canvas) target.canvas.width = target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}

const standardFonts = import.meta.glob<string>(
  "../../../node_modules/pdfjs-dist/standard_fonts/*",
  { query: "?url", import: "default", eager: true },
);
const cMaps = import.meta.glob<string>("../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
  query: "?url",
  import: "default",
  eager: true,
});
const wasm = import.meta.glob<string>("../../../node_modules/pdfjs-dist/wasm/*.{wasm,js}", {
  query: "?url",
  import: "default",
  eager: true,
});
class BinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const assets = kind === "cMapUrl" ? cMaps : kind === "wasmUrl" ? wasm : standardFonts;
    const directory = kind === "cMapUrl" ? "cmaps" : kind === "wasmUrl" ? "wasm" : "standard_fonts";
    const url = assets[`../../../node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!url) throw new Error("Unsupported PDF font.");
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF font unavailable.");
    return new Uint8Array(await response.arrayBuffer());
  }
}

export function openPdf(bytes: ArrayBuffer) {
  const inWorker = typeof document === "undefined";
  return getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: inWorker,
    useSystemFonts: !inWorker,
    useWorkerFetch: false,
    BinaryDataFactory,
    ...(inWorker ? { CanvasFactory: ThumbnailCanvasFactory } : {}),
    maxImageSize: 16 * 1024 * 1024,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    useWasm: true,
  });
}
