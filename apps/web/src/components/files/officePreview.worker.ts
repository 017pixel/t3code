import JSZip from "jszip";
import { SaxesParser } from "saxes";
import type { PresentationHandle, SlidePrimitive } from "@betteroffice/pptx";

import {
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_ROWS,
  type OfficeWorkerRequest,
  type OfficeWorkerResult,
} from "./officePreviewProtocol";

let presentation: PresentationHandle | null = null;

function reply(result: OfficeWorkerResult) {
  self.postMessage(result, { transfer: [] });
}

function xmlParser() {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new Error("This document contains unsupported XML declarations.");
  });
  return parser;
}

// Keep whole body elements so every prefix and render batch is valid Word XML.
// Individual tables/paragraphs are bounded too: one giant element must not
// bypass the budget between yields on the main thread.
function wordDocuments(xml: string, incomplete: boolean) {
  const parser = xmlParser();
  const names: string[] = [];
  const documents: string[] = [];
  let prefix = "";
  let suffix = "";
  let boundary = 0;
  let batchStart = 0;
  let tags = 0;
  let elementTags = 0;
  let batchTags = 0;
  let elements = 0;
  let truncated = incomplete;
  const limit = Symbol("Word preview limit");
  parser.on("opentag", (tag) => {
    names.push(tag.name);
    if (names.length === 2 && tag.local === "body") {
      prefix = xml.slice(0, parser.position);
      suffix = `</${tag.name}></${names[0]}>`;
      boundary = batchStart = parser.position;
    } else if (prefix && names.length > 2) {
      if (names.length === 3 && ++elements > 5_000) throw limit;
      tags++;
      elementTags++;
      batchTags++;
      if (tags > 100_000 || elementTags > 2_000 || parser.position - boundary > 128 * 1024)
        throw limit;
    }
    if (names.length > 64) throw limit;
  });
  parser.on("closetag", () => {
    if (prefix && names.length === 3) {
      if (parser.position - prefix.length > 3 * 1024 * 1024) throw limit;
      boundary = parser.position;
      elementTags = 0;
      if (batchTags >= 500) {
        documents.push(prefix + xml.slice(batchStart, boundary) + suffix);
        batchStart = boundary;
        batchTags = 0;
      }
    }
    names.pop();
  });
  try {
    for (let offset = 0; offset < xml.length; offset += 16 * 1024) {
      parser.write(xml.slice(offset, offset + 16 * 1024));
      if (prefix && parser.position - boundary > 128 * 1024) throw limit;
    }
    if (!incomplete) parser.close();
  } catch (cause) {
    if (cause !== limit) throw cause;
    truncated = true;
  }
  if (!prefix) throw new Error("This Word document has no readable body.");
  if (boundary > batchStart || documents.length === 0)
    documents.push(prefix + xml.slice(batchStart, boundary) + suffix);
  return { documents, truncated };
}

function boundedWorksheet(xml: string) {
  const parser = xmlParser();
  const rows = new Map<number, Map<number, string>>();
  let depth = 0;
  let row = 0;
  let explicitRow = false;
  let column = 0;
  let cells = new Map<number, string>();
  let cell: { start: number; opening: string; selfClosing: boolean } | null = null;
  let truncated = false;
  const coordinate = (ref: string) => {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
    if (!match) throw new Error("This workbook contains invalid cell coordinates.");
    let col = 0;
    for (const letter of match[1]!) col = col * 26 + letter.charCodeAt(0) - 64;
    const line = Number(match[2]);
    if (col > 16384 || line > 1048576)
      throw new Error("This workbook contains invalid worksheet dimensions.");
    return { col, line };
  };
  parser.on("opentag", (tag) => {
    depth++;
    if (depth > 64) throw new Error("This workbook contains excessive XML nesting.");
    if (
      (tag.local === "row" && depth !== 3) ||
      (tag.local === "c" && depth !== 4) ||
      ((tag.local === "dimension" || tag.local === "sheetData") && depth !== 2)
    )
      throw new Error("This workbook contains invalid worksheet structure.");
    const attribute = (name: string) => tag.attributes[name]?.value;
    if (depth === 2 && tag.local === "dimension") {
      for (const ref of (attribute("ref") ?? "").split(":")) {
        const { col, line } = coordinate(ref);
        if (col > OFFICE_PREVIEW_MAX_COLUMNS || line > OFFICE_PREVIEW_MAX_ROWS) truncated = true;
      }
    } else if (depth === 3 && tag.local === "row") {
      explicitRow = attribute("r") !== undefined;
      row = attribute("r") === undefined ? row + 1 : Number(attribute("r"));
      if (!Number.isInteger(row) || row < 1 || row > 1048576)
        throw new Error("This workbook contains invalid row coordinates.");
      column = 0;
      cells = rows.get(row) ?? new Map<number, string>();
      if (row > OFFICE_PREVIEW_MAX_ROWS) truncated = true;
    } else if (depth === 4 && tag.local === "c") {
      const ref = attribute("r");
      const position = ref ? coordinate(ref) : { col: column + 1, line: row };
      if (!explicitRow && column === 0) row = position.line;
      column = position.col;
      if (row < 1 || position.line !== row)
        throw new Error("This workbook contains inconsistent cell rows.");
      if (row > OFFICE_PREVIEW_MAX_ROWS || column > OFFICE_PREVIEW_MAX_COLUMNS) {
        truncated = true;
        return;
      }
      // Explicit coordinates also bound sheets whose rows/cells omit r.
      const letters =
        column <= 26 ? String.fromCharCode(64 + column) : `A${String.fromCharCode(38 + column)}`;
      const style = attribute("s");
      const type = attribute("t");
      if ((style && !/^\d{1,6}$/.test(style)) || (type && !/^[a-zA-Z]+$/.test(type)))
        throw new Error("This workbook contains invalid cell metadata.");
      cell = {
        start: parser.position,
        opening: `<c r="${letters}${row}"${style ? ` s="${style}"` : ""}${type ? ` t="${type}"` : ""}>`,
        selfClosing: tag.isSelfClosing,
      };
    }
  });
  parser.on("closetag", (tag) => {
    if (depth === 4 && tag.local === "c" && cell) {
      const end = cell.selfClosing ? cell.start : xml.lastIndexOf("<", parser.position - 1);
      cells.set(column, cell.opening + xml.slice(cell.start, end) + "</c>");
      cell = null;
    } else if (depth === 3 && tag.local === "row" && row <= OFFICE_PREVIEW_MAX_ROWS) {
      rows.set(row, cells);
    }
    depth--;
  });
  parser.write(xml).close();
  return {
    xml: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[
      ...rows,
    ]
      .sort(([a], [b]) => a - b)
      .map(
        ([line, values]) =>
          `<row r="${line}">${[...values]
            .sort(([a], [b]) => a - b)
            .map(([, value]) => value)
            .join("")}</row>`,
      )
      .join("")}</sheetData></worksheet>`,
    truncated,
  };
}

async function boundWorkbook(archive: JSZip) {
  const paths = new Map<string, string>();
  const relationships = xmlParser();
  relationships.on("opentag", (tag) => {
    if (tag.local !== "Relationship" || !tag.attributes.Type?.value.endsWith("/worksheet")) return;
    const target = tag.attributes.Target?.value ?? "";
    paths.set(
      tag.attributes.Id?.value ?? "",
      target.startsWith("/") ? target.slice(1) : `xl/${target}`,
    );
  });
  relationships
    .write((await archive.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "")
    .close();
  const sheetPaths: string[] = [];
  const workbook = xmlParser();
  workbook.on("opentag", (tag) => {
    if (tag.local !== "sheet") return;
    const id = Object.values(tag.attributes).find((attribute) => attribute.local === "id")?.value;
    const path = paths.get(id ?? "");
    if (!path || sheetPaths.length === 100)
      throw new Error("This workbook has invalid or too many sheets.");
    sheetPaths.push(path);
  });
  workbook.write((await archive.file("xl/workbook.xml")?.async("string")) ?? "").close();
  const limited = new Map<string, boolean>();
  for (const path of new Set(sheetPaths)) {
    const file = archive.file(path);
    if (!file) throw new Error("This workbook has a missing worksheet.");
    const sheet = boundedWorksheet(await file.async("string"));
    archive.file(path, sheet.xml);
    limited.set(path, sheet.truncated);
  }
  return sheetPaths.map((path) => limited.get(path) ?? false);
}

// Stream each entry before handing it to an engine. A tiny compressed archive
// must not turn into an unbounded allocation on the UI thread.
async function boundedArchive(input: Extract<OfficeWorkerRequest, { type: "open" }>) {
  const { bytes } = input;
  if (bytes.byteLength > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  const source = await JSZip.loadAsync(bytes).catch(() => {
    throw new Error("This file is damaged, encrypted, or not a valid Office document.");
  });
  const entries = Object.values(source.files).filter((entry) => !entry.dir);
  if (entries.length > 2048)
    throw new Error("This file contains too many archive entries to preview.");
  const archive = new JSZip();
  let total = 0;
  let wordAuxiliaryMarkup = 0;
  let wordInputTruncated = false;
  let word: ReturnType<typeof wordDocuments> | null = null;
  for (const entry of entries) {
    const document = input.kind === "docx" && entry.name === "word/document.xml";
    const media = input.kind === "docx" && entry.name.startsWith("word/media/");
    const chunks: Uint8Array[] = [];
    let length = 0;
    await new Promise<void>((resolve, reject) => {
      // JSZip exposes this streaming API at runtime but omits it from its types.
      const stream = (
        entry as JSZip.JSZipObject & {
          internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
        }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk: Uint8Array) => {
          total += chunk.length;
          length += chunk.length;
          if (document && length > 4 * 1024 * 1024) {
            chunks.push(chunk.subarray(0, chunk.length - (length - 4 * 1024 * 1024)));
            length = 4 * 1024 * 1024;
            wordInputTruncated = true;
            stream.pause();
            resolve();
            return;
          }
          // Media is bounded independently. Even renamed auxiliary XML must
          // stay small before docx-preview's synchronous parsers see it.
          if (input.kind === "docx" && !document && !media) {
            for (const byte of chunk) if (byte === 0x3c) wordAuxiliaryMarkup++;
            if (length > 1024 * 1024 || wordAuxiliaryMarkup > 50_000) {
              stream.pause();
              reject(
                new Error("Preview limited: this Word document has too much auxiliary markup."),
              );
              return;
            }
          }
          if (
            total > OFFICE_PREVIEW_MAX_BYTES ||
            (!document &&
              (input.kind === "xlsx" || media || entry.name.endsWith(".xml")) &&
              length > 8 * 1024 * 1024)
          ) {
            stream.pause();
            reject(new Error("The expanded document is too large to preview safely."));
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
    if (document) {
      word = wordDocuments(new TextDecoder().decode(content), wordInputTruncated);
      archive.file(entry.name, word.documents[0]!);
    } else {
      archive.file(entry.name, content);
    }
  }
  const truncatedSheets = input.kind === "xlsx" ? await boundWorkbook(archive) : [];
  return { archive, word, truncatedSheets };
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
  const { archive, word, truncatedSheets } = await boundedArchive(input);
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
    if (!word) throw new Error("This Word document has no readable body.");
    reply({ type: "docx", bytes, ...word });
  } else if (input.kind === "xlsx") {
    const { default: readXlsxFile } = await import("read-excel-file/universal");
    const sheets = await readXlsxFile(bytes);
    if (sheets.length === 0 || sheets.length > 100)
      throw new Error("This workbook has no readable sheets or too many sheets to preview.");
    reply({
      type: "xlsx",
      sheets: sheets.map(({ sheet, data }, index) => ({
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
                    ? cell.toLocaleDateString(undefined, { timeZone: "UTC" })
                    : String(cell),
              ),
          ),
        truncated:
          truncatedSheets[index] === true ||
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
