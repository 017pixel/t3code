import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { boundedZip } from "./boundedZip";
import type { PresentationHandle, SlidePrimitive } from "@betteroffice/pptx";

import {
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_ROWS,
  type OfficeWorkerRequest,
  type OfficeWorkerResult,
} from "./officePreviewProtocol";

import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";

let workbook: string[][][] = [];

let presentation: PresentationHandle | null = null;

function reply(result: OfficeWorkerResult) {
  self.postMessage(result, { transfer: [] });
}

async function boundedArchive(input: Extract<OfficeWorkerRequest, { type: "open" }>) {
  const { bytes } = input;
  const spreadsheet = input.kind === "xlsx";
  const word = input.kind === "docx";
  const files = await boundedZip(bytes, spreadsheet ? 128 * 1024 * 1024 : undefined, {
    totalLimit: word ? 2 * 1024 * 1024 : spreadsheet ? 128 * 1024 * 1024 : 50 * 1024 * 1024,
    xmlLimit: spreadsheet ? 64 * 1024 * 1024 : 8 * 1024 * 1024,
    ratioFloor: 8 * 1024 * 1024,
    ...(word ? { markupLimit: 50_000 } : {}),
  }).catch((error: unknown) => {
    if (
      word &&
      error instanceof Error &&
      error.message === "The expanded archive exceeds the preview size or compression ratio limit."
    )
      throw new Error(
        "Preview limited: this Word document has too much expanded content or markup.",
      );
    if (error instanceof Error && error.message === "This is not a readable ZIP archive.")
      throw new Error("This file is damaged, encrypted, or not a valid Office document.");
    throw error;
  });
  const archive = new JSZip();
  for (const [name, file] of files) {
    if (!file.directory) archive.file(name, file.bytes);
  }
  return archive;
}

async function handle(input: OfficeWorkerRequest) {
  if (input.type === "sheet-page") {
    const rows = workbook[input.sheet];
    if (!rows) throw new Error("This sheet is unavailable.");
    reply({
      type: "sheet-page",
      sheet: input.sheet,
      index: input.index,
      rows: rows.slice(input.index * PREVIEW_PAGE_ROWS, (input.index + 1) * PREVIEW_PAGE_ROWS),
    });
    return;
  }
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
  const archive = await boundedArchive(input);
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
    const sheetIds = new Set<string>();
    const targets = new Map<string, string>();
    const scan = (xml: string, visit: (name: string, attrs: Record<string, string>) => void) => {
      if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) throw new Error("Workbook DTDs are not supported.");
      new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        parseAttributeValue: false,
        updateTag(name, _path, attrs) {
          visit(name.split(":").at(-1)!, attrs);
          return name;
        },
      }).parse(xml);
    };
    scan(await archive.file("xl/workbook.xml")!.async("string"), (name, attrs) => {
      if (name === "sheet" && attrs["r:id"]) sheetIds.add(attrs["r:id"]);
    });
    const relationships = archive.file("xl/_rels/workbook.xml.rels");
    if (!relationships) throw new Error("This workbook has no worksheet relationships.");
    scan(await relationships.async("string"), (name, attrs) => {
      if (
        name === "Relationship" &&
        (attrs.Type ===
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ||
          attrs.Type === "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet")
      ) {
        // Match read-excel-file's absolute/relative target handling exactly.
        const target = attrs.Target;
        if (!target) throw new Error("This workbook has an invalid worksheet relationship.");
        targets.set(attrs.Id!, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
      }
    });
    if (sheetIds.size === 0 || sheetIds.size > 100)
      throw new Error("This workbook has no readable sheets or too many sheets to preview.");
    let cells = 0;
    for (const id of sheetIds) {
      const target = targets.get(id);
      const entry = target ? archive.file(target) : null;
      if (!entry) throw new Error("This workbook has a missing worksheet.");
      let maxRow = 0;
      let maxColumn = 0;
      scan(await entry.async("string"), (name, attrs) => {
        if (name === "row") maxRow = Math.max(maxRow + 1, Number(attrs.r ?? 0));
        if (name === "c") {
          cells++;
          const address = /^([A-Z]+)(\d+)$/.exec(attrs.r ?? "");
          if (!address) throw new Error("This workbook has an invalid cell address.");
          maxRow = Math.max(maxRow, Number(address[2]));
          let column = 0;
          for (const letter of address[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
          maxColumn = Math.max(maxColumn, column);
        }
        if (
          !Number.isFinite(maxRow) ||
          maxRow > OFFICE_PREVIEW_MAX_ROWS ||
          maxColumn > OFFICE_PREVIEW_MAX_COLUMNS ||
          maxRow * maxColumn > 8_000_000 ||
          cells > 2_000_000
        )
          throw new Error(
            "This workbook exceeds the preview limit: 250,000 rows, 1,024 columns, 2 million cells or 8 million grid positions.",
          );
      });
    }
    const sheets = await readXlsxFile(bytes);
    if (sheets.length === 0 || sheets.length > 100)
      throw new Error("This workbook has no readable sheets or too many sheets to preview.");
    workbook = sheets.map(({ data }) =>
      data.slice(0, OFFICE_PREVIEW_MAX_ROWS).map((row) => {
        let end = Math.min(row.length, OFFICE_PREVIEW_MAX_COLUMNS);
        while (end > 0 && row[end - 1] === null) end--;
        return row
          .slice(0, end)
          .map((cell) =>
            cell === null ? "" : cell instanceof Date ? cell.toLocaleDateString() : String(cell),
          );
      }),
    );
    reply({
      type: "xlsx",
      sheets: sheets.map(({ sheet, data }, index) => ({
        name: sheet,
        rows: workbook[index]!.slice(0, PREVIEW_PAGE_ROWS),
        rowCount: workbook[index]!.length,
        columns: workbook[index]!.reduce((columns, row) => Math.max(columns, row.length), 1),
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
