/* oxlint-disable react/no-array-index-key -- Spreadsheet rows and columns retain their source positions. */
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";

import { FileSurfaceAction, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { OFFICE_PREVIEW_MAX_BYTES, type OfficeWorkerResult } from "./officePreviewProtocol";

type Workbook = Extract<OfficeWorkerResult, { type: "xlsx" }>;
type Slide = Extract<OfficeWorkerResult, { type: "slide" }>;

const OFFICE_PAGE_PADDING = 20;
const OFFICE_PAGE_BACKGROUND = { light: "#f4f4f5", dark: "#141414" };

async function readOfficeFile(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("The file could not be loaded. Close it and try again.");
  if (Number(response.headers.get("content-length")) > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The file is unavailable.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > OFFICE_PREVIEW_MAX_BYTES) throw new Error("Preview limited to files under 50 MB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}

async function renderWord(bytes: ArrayBuffer) {
  const [{ renderAsync }, { default: JSZip }, { default: DOMPurify }] = await Promise.all([
    import("docx-preview"),
    import("jszip"),
    import("dompurify"),
  ]);
  const archive = await JSZip.loadAsync(bytes);
  // Even detached images can initiate requests. Remove external relationships
  // before the renderer creates DOM, then restrict its output again in the frame.
  for (const entry of Object.values(archive.files)) {
    if (!entry.name.endsWith(".rels")) continue;
    const xml = new DOMParser().parseFromString(await entry.async("string"), "application/xml");
    if (xml.querySelector("parsererror") || xml.doctype)
      throw new Error("This document contains invalid XML.");
    for (const rel of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
      const target = rel.getAttribute("Target") ?? "";
      if (
        rel.getAttribute("TargetMode")?.toLowerCase() === "external" ||
        /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)
      )
        rel.remove();
    }
    archive.file(entry.name, new XMLSerializer().serializeToString(xml));
  }
  const doc = document.implementation.createHTMLDocument();
  const body = doc.createElement("div");
  const styles = doc.createElement("div");
  await renderAsync(await archive.generateAsync({ type: "arraybuffer" }), body, styles, {
    ignoreFonts: true,
    useBase64URL: true,
    renderAltChunks: false,
  });
  const markup = DOMPurify.sanitize(body.innerHTML, {
    FORBID_TAGS: ["style", "a", "form", "input", "button", "video", "audio", "svg", "math"],
    FORBID_ATTR: ["srcset"],
  });
  const clean = new DOMParser().parseFromString(markup, "text/html");
  for (const image of clean.images) {
    if (!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(image.src)) image.remove();
  }
  const css = [...styles.querySelectorAll("style")]
    .map((style) => style.textContent)
    .join("\n")
    .replaceAll(/<\/style/gi, "");
  return { html: clean.body.innerHTML, css };
}

function WordFrame(props: {
  readonly content: { html: string; css: string };
  readonly name: string;
}) {
  const { resolvedTheme } = useTheme();
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>${props.content.css}</style><style>html{background:${OFFICE_PAGE_BACKGROUND[resolvedTheme]}}body{margin:0}.docx-wrapper{background:transparent;padding:${OFFICE_PAGE_PADDING}px;box-sizing:border-box}.docx-wrapper section.docx{max-width:100%;box-sizing:border-box;padding:32px!important;min-height:0!important}img{max-width:100%;height:auto}.docx-wrapper section.docx div{max-width:100%}img{height:auto!important}*{scrollbar-width:thin}</style></head><body>${props.content.html}</body></html>`;
  return (
    <iframe title={props.name} srcDoc={srcDoc} sandbox="" className="min-h-0 flex-1 border-0" />
  );
}

function SlideCanvas(props: {
  readonly slide: Slide;
  readonly onError: (message: string) => void;
}) {
  const { slide, onError } = props;
  const { resolvedTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const images: ImageBitmap[] = [];
    void (async () => {
      const { paintSlide } = await import("@betteroffice/pptx");
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot render slides.");
      const frame = slide.frame;
      const scale = Math.min(2, 1920 / frame.width, 1080 / frame.height);
      canvas.width = Math.ceil(frame.width * scale);
      canvas.height = Math.ceil(frame.height * scale);
      const decoded = new Map<string, ImageBitmap>();
      for (const image of slide.images) {
        // createImageBitmap decodes raster data without document markup or URLs.
        const bitmap = await createImageBitmap(new Blob([image.bytes])).catch(() => null);
        if (bitmap) {
          images.push(bitmap);
          decoded.set(image.id, bitmap);
        }
      }
      if (!cancelled)
        await paintSlide(context, frame, 1, scale, {
          resolveImage: (id) => decoded.get(id) ?? null,
          maxShadowPixels: canvas.width * canvas.height * 4,
        });
    })()
      .catch((cause: unknown) => {
        if (!cancelled)
          onError(cause instanceof Error ? cause.message : "Could not render this slide.");
      })
      .finally(() => {
        for (const image of images) image.close();
      });
    return () => {
      cancelled = true;
    };
  }, [slide, onError]);
  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      style={{ background: OFFICE_PAGE_BACKGROUND[resolvedTheme], padding: OFFICE_PAGE_PADDING }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={props.slide.text || `Slide ${props.slide.index + 1}`}
        className="block h-auto w-full shadow-sm"
      />
    </div>
  );
}

export default function OfficeViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: OfficePreviewKind;
  readonly sizeBytes?: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [word, setWord] = useState<Awaited<ReturnType<typeof renderWord>> | null>(null);
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [slide, setSlide] = useState<Slide | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let loadedFont: FontFace | null = null;
    if ((props.sizeBytes ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
      // oxlint-disable-next-line react/set-state-in-effect -- The file metadata can reject the preview before loading bytes or engines.
      setError("Preview limited to files under 50 MB.");
      return;
    }
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const fail = (message: string) => {
      if (!controller.signal.aborted) setError(message);
      controller.abort();
      worker.terminate();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    timerRef.current = setTimeout(
      () => fail("This document took too long to preview. Open it in another app."),
      30_000,
    );
    worker.addEventListener("error", () =>
      fail("Could not load the Office viewer. Close the file and try again."),
    );
    worker.addEventListener("message", (event: MessageEvent<OfficeWorkerResult>) => {
      if (controller.signal.aborted) return;
      const result = event.data;
      if (result.type === "error") fail(result.message);
      else if (result.type === "docx") {
        void renderWord(result.bytes)
          .then((content) => {
            if (!controller.signal.aborted) {
              if (timerRef.current) clearTimeout(timerRef.current);
              setWord(content);
            }
          })
          .catch(() => fail("This Word document could not be parsed."));
      } else if (result.type === "xlsx") {
        if (timerRef.current) clearTimeout(timerRef.current);
        setWorkbook(result);
        setCount(result.sheets.length);
      } else if (result.type === "pptx") {
        void new FontFace("Carlito", result.font)
          .load()
          .then((font) => {
            if (controller.signal.aborted) return;
            loadedFont = font;
            document.fonts.add(font);
            setCount(result.count);
            worker.postMessage({ type: "slide", index: 0 }, []);
          })
          .catch(() => fail("Could not load the presentation font."));
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        setSlide(result);
      }
    });
    void readOfficeFile(props.src, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted)
          worker.postMessage({ type: "open", kind: props.kind, bytes }, [bytes]);
      })
      .catch((cause: unknown) =>
        fail(cause instanceof Error ? cause.message : "Could not read this file."),
      );
    return () => {
      controller.abort();
      if (loadedFont) document.fonts.delete(loadedFont);
      worker.terminate();
      workerRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [props.src, props.kind, props.sizeBytes]);
  const selectPage = (index: number) => {
    setPage(index);
    if (props.kind !== "pptx") return;
    setSlide(null);
    workerRef.current?.postMessage({ type: "slide", index }, []);
    timerRef.current = setTimeout(() => {
      setError("This slide took too long to preview.");
      workerRef.current?.terminate();
    }, 30_000);
  };
  if (error)
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p className="text-sm font-medium">No preview for this file</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {error} Save it or open it in another app.
        </p>
      </div>
    );
  if (word) return <WordFrame content={word} name={props.name} />;
  const sheet = workbook?.sheets[page];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {count > 0 ? (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs">
          <FileSurfaceAction
            label={workbook ? "Previous sheet" : "Previous slide"}
            disabled={page === 0 || (props.kind === "pptx" && slide === null)}
            onPress={() => selectPage(page - 1)}
          >
            <ChevronLeftIcon className="size-3.5" />
          </FileSurfaceAction>
          {workbook ? (
            <select
              aria-label="Sheet"
              value={page}
              onChange={(event) => selectPage(Number(event.target.value))}
              className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-foreground"
            >
              {workbook.sheets.map((item, index) => (
                <option key={index} value={index}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="flex-1 text-center tabular-nums" aria-live="polite">
              Slide {page + 1} of {count}
            </span>
          )}
          <FileSurfaceAction
            label={workbook ? "Next sheet" : "Next slide"}
            disabled={page + 1 === count || (props.kind === "pptx" && slide === null)}
            onPress={() => selectPage(page + 1)}
          >
            <ChevronRightIcon className="size-3.5" />
          </FileSurfaceAction>
        </div>
      ) : null}
      {sheet ? (
        <>
          <FileSurfaceNotice>
            Cell values only. Charts, images, and formatting are not shown.
            {sheet.truncated ? " Limited to 500 rows and 50 columns." : ""}
          </FileSurfaceNotice>
          <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
            <table
              aria-label={`${props.name}: ${sheet.name}`}
              className="min-w-full border-separate border-spacing-0 text-xs"
            >
              <tbody>
                {sheet.rows.map((row, index) => (
                  <tr key={index} className="even:bg-muted/30">
                    <th
                      scope="row"
                      className="sticky left-0 border-b border-border/60 bg-muted px-2 py-1.5 text-right font-normal text-muted-foreground tabular-nums"
                    >
                      {index + 1}
                    </th>
                    {row.map((cell, column) => (
                      <td
                        key={column}
                        className="max-w-80 min-w-24 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {sheet.rows.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">This sheet is empty.</p>
            ) : null}
          </div>
        </>
      ) : slide ? (
        <SlideCanvas slide={slide} onError={setError} />
      ) : (
        <FileSurfaceLoading />
      )}
    </div>
  );
}
