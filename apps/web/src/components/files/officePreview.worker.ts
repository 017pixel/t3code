import JSZip from "jszip";
import { boundedZip } from "./boundedZip";
import type { PresentationHandle, SlidePrimitive } from "@betteroffice/pptx";

import {
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_ROWS,
  type OfficeWorkerRequest,
  type OfficeWorkerResult,
} from "./officePreviewProtocol";

let presentation: PresentationHandle | null = null;

function reply(result: OfficeWorkerResult) {
  self.postMessage(result, { transfer: [] });
}

async function boundedArchive(bytes: ArrayBuffer) {
  const files = await boundedZip(bytes);
  const archive = new JSZip();
  for (const [name, file] of files) {
    if (!file.directory) archive.file(name, file.bytes);
  }
  return archive;
}

async function handle(input: OfficeWorkerRequest) {
  if (input.type === "slide") {
    if (!presentation) throw new Error("The presentation is unavailable.");
    const frame = presentation.layoutSlide(input.index);
    if (!(frame.width > 0 && frame.height > 0) || frame.width > 16384 || frame.height > 16384)
      throw new Error("This slide is too large to preview.");
    const ids = new Set<string>();
    const collect = (primitives: SlidePrimitive[]) => {
      for (const primitive of primitives) {
        if (primitive.kind === "image" && primitive.assetId) ids.add(primitive.assetId);
        if (primitive.kind === "chart" || primitive.kind === "table") collect(primitive.primitives);
      }
    };
    collect(frame.primitives);
    const images = [...ids].map((id) => ({
      id,
      bytes: new Uint8Array(presentation!.mediaBytes(id)),
    }));
    const slide = presentation.snapshot().slides[input.index];
    const text =
      slide?.shapes
        .flatMap((shape) =>
          shape.textStories.flatMap((story) =>
            story.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join("")),
          ),
        )
        .join("\n") ?? "";
    reply({ type: "slide", index: input.index, frame, images, text });
    return;
  }
  const archive = await boundedArchive(input.bytes);
  const root =
    input.kind === "docx"
      ? "word/document.xml"
      : input.kind === "xlsx"
        ? "xl/workbook.xml"
        : "ppt/presentation.xml";
  if (!archive.file(root))
    throw new Error("This is not a valid Office Open XML file. Encrypted files are not supported.");
  const bytes = await archive.generateAsync({ type: "arraybuffer", compression: "STORE" });
  if (input.kind === "docx") {
    reply({ type: "docx", bytes });
  } else if (input.kind === "xlsx") {
    const { default: readXlsxFile } = await import("read-excel-file/universal");
    const sheets = await readXlsxFile(bytes);
    if (sheets.length === 0 || sheets.length > 100)
      throw new Error("This workbook has no readable sheets or too many sheets to preview.");
    reply({
      type: "xlsx",
      sheets: sheets.map(({ sheet, data }) => ({
        name: sheet,
        rows: data
          .slice(0, OFFICE_PREVIEW_MAX_ROWS)
          .map((row) =>
            row
              .slice(0, OFFICE_PREVIEW_MAX_COLUMNS)
              .map((cell) =>
                cell === null
                  ? ""
                  : cell instanceof Date
                    ? cell.toLocaleDateString()
                    : String(cell),
              ),
          ),
        truncated:
          data.length > OFFICE_PREVIEW_MAX_ROWS ||
          data.some((row) => row.length > OFFICE_PREVIEW_MAX_COLUMNS),
      })),
    });
  } else {
    const [{ initWasm, openPresentation }, fontUrl] = await Promise.all([
      import("@betteroffice/pptx"),
      import("../../../node_modules/@betteroffice/fonts/assets/Carlito-Regular.ttf?url"),
    ]);
    const response = await fetch(fontUrl.default);
    if (!response.ok) throw new Error("Could not load the presentation font.");
    const font = await response.arrayBuffer();
    await initWasm();
    presentation = openPresentation(new Uint8Array(bytes), {
      fonts: [{ family: "Carlito", bytes: new Uint8Array(font) }],
      fallbackFonts: [{ family: "Carlito", bytes: new Uint8Array(font) }],
    });
    const count = presentation.snapshot().slides.length;
    if (count === 0 || count > 500)
      throw new Error("This presentation has no slides or too many slides to preview.");
    reply({ type: "pptx", count, font });
  }
}

self.addEventListener("message", (event: MessageEvent<OfficeWorkerRequest>) => {
  void handle(event.data).catch((cause: unknown) =>
    reply({
      type: "error",
      message: cause instanceof Error ? cause.message : "Could not parse this file.",
    }),
  );
});
