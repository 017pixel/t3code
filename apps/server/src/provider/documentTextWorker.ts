// @effect-diagnostics nodeBuiltinImport:off -- isolated CLI worker; no server runtime is loaded here.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { SaxesParser } from "saxes";
import * as Yauzl from "yauzl";

const MAX_INPUT = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_OUTPUT = 1_000_000;
const CELL_START = Symbol("cell-start");
const CELL_END = Symbol("cell-end");
type TextPart = string | typeof CELL_START | typeof CELL_END | { fallback: string };

const TRUNCATED = "\n\n[Extracted text truncated at 1,000,000 characters.]";

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
  spaceCount?: number;
}

function xml(source: string, odfSpaces = false): XmlNode {
  const root: XmlNode = { name: "root", attrs: {}, children: [] };
  const stack = [root];
  let nodes = 0;
  const parser = new SaxesParser();
  parser.on("opentag", (tag) => {
    if (++nodes > 200_000 || stack.length > 128) throw new Error("XML structure limit");
    const node: XmlNode = {
      name: tag.name.split(":").at(-1)!,
      attrs: Object.fromEntries(
        Object.entries(tag.attributes).flatMap(([key, value]) => [
          [key, String(value)],
          [key.split(":").at(-1)!, String(value)],
        ]),
      ),
      children: [],
    };
    if (odfSpaces && node.name === "s") node.spaceCount = Math.min(256, Number(node.attrs.c) || 1);
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const text = (value: string) => {
    stack.at(-1)!.children.push(value);
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(source).close();
  return root;
}

const children = (node: XmlNode) =>
  node.children.filter((child): child is XmlNode => typeof child !== "string");
function* all(node: XmlNode, name: string | readonly string[]): Generator<XmlNode, void> {
  for (const child of children(node)) {
    if (typeof name === "string" ? child.name === name : name.includes(child.name)) yield child;
    else yield* all(child, name);
  }
}
function* text(node: XmlNode): Generator<string, void> {
  if (["script", "style", "binary-data"].includes(node.name)) return;
  if (["tab", "cell"].includes(node.name)) yield "\t";
  else if (["br", "line-break"].includes(node.name)) yield "\n";
  else if (node.spaceCount !== undefined) yield " ".repeat(node.spaceCount);
  else
    for (const child of node.children) {
      if (typeof child === "string") yield child;
      else yield* text(child);
    }
}
function* paragraphs(node: XmlNode): Generator<TextPart, void> {
  if (["script", "style", "binary-data"].includes(node.name)) return;
  for (const child of node.children) {
    if (typeof child === "string") yield child;
    else if (["br", "line-break"].includes(child.name)) yield "\n";
    else if (["tbl", "table"].includes(child.name)) yield* table(child);
    else if (["p", "h"].includes(child.name) || /^h[1-6]$/.test(child.name)) {
      const style = all(child, "pStyle").next().value?.attrs.val ?? "";
      const level =
        child.name === "h"
          ? Number(child.attrs["outline-level"]) || 1
          : /^h[1-6]$/.test(child.name)
            ? Number(child.name[1])
            : Number(style.match(/^Heading([1-6])$/i)?.[1]) || 0;
      if (level) yield `${"#".repeat(Math.min(6, level))} `;
      yield* text(child);
      yield "\n";
    } else {
      yield* paragraphs(child);
      if (["li", "div", "section"].includes(child.name)) yield "\n";
    }
  }
}
function* inCell(parts: Iterable<TextPart>): Generator<TextPart, void> {
  yield CELL_START;
  yield* parts;
  yield CELL_END;
}
function hasCellText(cell: XmlNode): boolean {
  if (cell.attrs.value) return true;
  for (const part of text(cell)) if (part) return true;
  return false;
}
function* table(node: XmlNode): Generator<TextPart, void> {
  let rowCount = 0;
  for (const row of all(node, ["tr", "table-row"])) {
    const cells = children(row).filter((cell) =>
      ["tc", "table-cell", "covered-table-cell", "td", "th"].includes(cell.name),
    );
    // ODS writers pad sheets with repeated empty rows and trailing cells.
    while (cells.length && !hasCellText(cells.at(-1)!)) cells.pop();
    if (!cells.length) continue;
    const repeat = Math.min(10_000, Number(row.attrs["number-rows-repeated"]) || 1);
    rowCount += repeat;
    if (rowCount > 10_000) throw new Error("Row limit");
    for (let index = 0; index < repeat; index++) {
      let column = 0;
      for (const cell of cells) {
        const count = Math.min(512, Number(cell.attrs["number-columns-repeated"]) || 1);
        if (column + count > 512) throw new Error("Column limit");
        for (let i = 0; i < count; i++) {
          if (column++) yield "\t";
          yield CELL_START;
          yield* paragraphs(cell);
          if (cell.attrs.value) yield { fallback: cell.attrs.value };
          yield CELL_END;
        }
      }
      yield "\n";
    }
  }
}

async function archive(path: string): Promise<Map<string, string>> {
  const zip = await new Promise<Yauzl.ZipFile>((resolve, reject) =>
    Yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, result) => (error || !result ? reject(error) : resolve(result)),
    ),
  );
  const files = new Map<string, string>();
  let expanded = 0;
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Yauzl.Entry) => {
        if (
          ++count > 2048 ||
          zip.entryCount > 2048 ||
          entry.generalPurposeBitFlag & 1 ||
          entry.uncompressedSize > MAX_EXPANDED ||
          entry.uncompressedSize > Math.max(1024, entry.compressedSize * 200)
        ) {
          reject(new Error("Archive limit"));
          return;
        }
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED) {
          reject(new Error("Expanded byte limit"));
          return;
        }
        if (!/\.(xml|rels|xhtml|html|htm|opf)$/i.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }
          const buffers: Buffer[] = [];
          let size = 0;
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > MAX_EXPANDED) {
              stream.destroy(new Error("Entry byte limit"));
              return;
            }
            buffers.push(chunk);
          });
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(buffers).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return files;
}

function* notebook(source: string): Generator<string, void> {
  const book: unknown = JSON.parse(source);
  if (
    !book ||
    typeof book !== "object" ||
    !("cells" in book) ||
    !Array.isArray(book.cells) ||
    book.cells.length > 10_000
  )
    throw new Error("Invalid notebook");
  function* lines(value: unknown): Generator<string, void> {
    if (typeof value === "string") yield value;
    else if (Array.isArray(value))
      for (const line of value) {
        if (typeof line === "string") yield line;
      }
  }
  for (const [index, cell] of book.cells.entries()) {
    if (!cell || typeof cell !== "object") continue;
    const kind = "cell_type" in cell && cell.cell_type === "code" ? "code" : "markdown";
    yield `## Cell ${index + 1} (${kind})\n`;
    if ("source" in cell) yield* lines(cell.source);
    if ("outputs" in cell && Array.isArray(cell.outputs)) {
      yield "\nOutput:\n";
      for (const output of cell.outputs) {
        if (!output || typeof output !== "object") continue;
        if ("text" in output) yield* lines(output.text);
        else if (
          "data" in output &&
          output.data &&
          typeof output.data === "object" &&
          "text/plain" in output.data
        )
          yield* lines(output.data["text/plain"]);
        yield "\n";
      }
    }
    yield "\n\n";
  }
}

function* rtf(source: string): Generator<string, void> {
  if (!source.startsWith("{\\rtf")) throw new Error("Invalid RTF document");
  let state = { skip: false, uc: 1, decoder: new TextDecoder("windows-1252") };
  const stack: Array<typeof state> = [];
  let fallback = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "{" || char === "}") fallback = 0;
    if (char === "{") {
      stack.push({ ...state });
      if (stack.length > 128) throw new Error("RTF depth limit");
    } else if (char === "}") state = stack.pop() ?? state;
    else if (char === "\\") {
      const rest = source.slice(i + 1, i + 80);
      const hex = /^'([0-9a-f]{2})/i.exec(rest);
      const word = /^([a-z]+)(-?\d+)? ?/i.exec(rest);
      if (hex) {
        if (fallback) fallback--;
        else if (!state.skip)
          yield state.decoder.decode(Uint8Array.of(Number.parseInt(hex[1]!, 16)));
        i += 3;
      } else if (word) {
        i += word[0].length;
        const control = word[1]!;
        const value = Number(word[2]);
        if (control === "bin") {
          if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("Invalid RTF binary length");
          i += value;
        }
        if (fallback) {
          fallback--;
          continue;
        }
        if (
          [
            "fonttbl",
            "colortbl",
            "stylesheet",
            "info",
            "pict",
            "object",
            "fldinst",
            "header",
            "footer",
          ].includes(control)
        )
          state.skip = true;
        if (control === "ansicpg") {
          // Per-byte decoding only supports single-byte Windows code pages.
          if (value !== 874 && (value < 1250 || value > 1258))
            throw new Error("Unsupported RTF code page");
          state.decoder = new TextDecoder(`windows-${value}`, { fatal: true });
        } else if (control === "uc") state.uc = Math.max(0, Math.min(16, value));
        else if (control === "u" && !state.skip) {
          yield String.fromCharCode(value < 0 ? value + 65536 : value);
          fallback = state.uc;
        } else if (!state.skip && ["par", "line", "row"].includes(control)) yield "\n";
        else if (!state.skip && ["tab", "cell"].includes(control)) yield "\t";
      } else {
        i++;
        if (fallback) fallback--;
        else if (rest[0] === "*") state.skip = true;
        else if (!state.skip && ["\\", "{", "}"].includes(rest[0]!)) yield rest[0]!;
        else if (!state.skip && rest[0] === "~") yield " ";
      }
    } else if (!state.skip && char !== "\n" && char !== "\r") {
      if (fallback) fallback--;
      else
        yield char.charCodeAt(0) < 128
          ? char
          : state.decoder.decode(Uint8Array.of(char.charCodeAt(0)));
    }
  }
}

async function* document(path: string, extension: string): AsyncGenerator<TextPart, void> {
  if ((await NodeFSP.stat(path)).size > MAX_INPUT) throw new Error("Input byte limit");
  if (extension === ".ipynb") yield* notebook(await NodeFSP.readFile(path, "utf8"));
  else if (extension === ".rtf") yield* rtf((await NodeFSP.readFile(path)).toString("latin1"));
  else {
    const files = await archive(path);
    const read = (name: string) => {
      const data = files.get(name);
      if (!data) throw new Error("Missing document part");
      return xml(data, [".odt", ".ods", ".odp"].includes(extension));
    };
    const relations = (name: string) =>
      new Map(
        [...all(read(name), "Relationship")]
          .filter((rel) => rel.attrs.TargetMode !== "External")
          .map((rel) => [rel.attrs.Id, rel.attrs.Target]),
      );
    if (extension === ".docx") yield* paragraphs(read("word/document.xml"));
    else if ([".odt", ".ods", ".odp"].includes(extension)) {
      const content = read("content.xml");
      if (extension === ".odt") yield* paragraphs(content);
      else {
        let index = 0;
        for (const part of all(content, extension === ".ods" ? "table" : "page")) {
          yield extension === ".ods"
            ? `\n\n## Sheet: ${part.attrs.name ?? "Untitled"}\n`
            : `\n\n## Slide ${++index}\n`;
          if (extension === ".ods") yield* table(part);
          else yield* paragraphs(part);
        }
      }
    } else if (extension === ".xlsx") {
      const workbook = read("xl/workbook.xml");
      const dateSystem = ["1", "true"].includes(
        all(workbook, "workbookPr").next().value?.attrs.date1904 ?? "",
      )
        ? "1904"
        : "1900";
      const styles = files.has("xl/styles.xml") ? read("xl/styles.xml") : undefined;
      const customFormats = new Map(
        styles
          ? [...all(styles, "numFmt")].map((node) => [node.attrs.numFmtId, node.attrs.formatCode])
          : [],
      );
      const cellFormats = styles ? all(styles, "cellXfs").next().value : undefined;
      const formats = cellFormats ? children(cellFormats) : [];
      const strings = files.has("xl/sharedStrings.xml")
        ? [...all(read("xl/sharedStrings.xml"), "si")]
        : [];
      const rels = relations("xl/_rels/workbook.xml.rels");
      for (const sheet of all(workbook, "sheet")) {
        yield `\n## Sheet: ${sheet.attrs.name}\n`;
        const target = rels.get(sheet.attrs["r:id"] ?? sheet.attrs.id);
        if (!target) throw new Error("Missing sheet relationship");
        const name = target.startsWith("/")
          ? target.slice(1)
          : NodePath.posix.normalize(`xl/${target}`);
        let rowCount = 0;
        for (const row of all(read(name), "row")) {
          if (++rowCount > 10_000) throw new Error("Row limit");
          const cells: Array<XmlNode | undefined> = [];
          for (const cell of children(row).filter((node) => node.name === "c")) {
            const letters = cell.attrs.r?.match(/^[A-Z]+/)?.[0];
            const column = letters
              ? [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1
              : cells.length;
            if (column > 511) throw new Error("Column limit");
            cells[column] = cell;
          }
          for (const [column, cell] of cells.entries()) {
            if (column) yield "\t";
            if (!cell) continue;
            const value = all(cell, "v").next().value;
            const raw = value?.children.find((child) => typeof child === "string") ?? "";
            if (cell.attrs.t === "s") {
              const shared = strings[Number(raw)];
              if (shared) yield* inCell(text(shared));
            } else if (cell.attrs.t === "inlineStr") yield* inCell(text(cell));
            else {
              if (value) yield* inCell(text(value));
              else for (const formula of all(cell, "f")) yield* inCell(text(formula));
              const formatId = formats[Number(cell.attrs.s ?? 0)]?.attrs.numFmtId;
              const format = formatId ? customFormats.get(formatId) : undefined;
              if (
                (cell.attrs.t === undefined || cell.attrs.t === "n") &&
                raw &&
                formatId &&
                formatId !== "0"
              )
                yield ` [Excel numFmtId=${formatId}${format ? `; format=${format}` : ""}; date system ${dateSystem}]`;
            }
          }
          yield "\n";
        }
      }
    } else if (extension === ".pptx") {
      const rels = relations("ppt/_rels/presentation.xml.rels");
      let index = 0;
      for (const slide of all(read("ppt/presentation.xml"), "sldId")) {
        yield `\n\n## Slide ${++index}\n`;
        const target = rels.get(slide.attrs["r:id"] ?? slide.attrs.id);
        if (!target) throw new Error("Missing slide relationship");
        yield* paragraphs(
          read(
            target.startsWith("/") ? target.slice(1) : NodePath.posix.normalize(`ppt/${target}`),
          ),
        );
      }
    } else if (extension === ".epub") {
      const rootfile = all(read("META-INF/container.xml"), "rootfile").next().value?.attrs[
        "full-path"
      ];
      if (!rootfile) throw new Error("Missing EPUB package");
      const packageXml = read(rootfile);
      const items = new Map(
        [...all(packageXml, "item")].map((item) => [item.attrs.id, item.attrs.href]),
      );
      let index = 0;
      for (const item of all(packageXml, "itemref")) {
        yield `\n\n## Chapter ${++index}\n`;
        const href = items.get(item.attrs.idref);
        if (!href) throw new Error("Missing chapter");
        const name = NodePath.posix.normalize(
          NodePath.posix.join(
            NodePath.posix.dirname(rootfile),
            decodeURIComponent(href.split("#")[0]!),
          ),
        );
        yield* paragraphs(read(name));
      }
    } else throw new Error("Unsupported document");
  }
}

export async function extractDocumentText(path: string, extension: string): Promise<string> {
  let result = "";
  let remaining = MAX_OUTPUT;
  let cellDepth = 0;
  let started = false;
  let space = false;
  // Charge raw text before normalization so repeated whitespace also exhausts the budget.
  for await (const part of document(path, extension)) {
    if (part === CELL_START) {
      if (cellDepth++ === 0) {
        started = false;
        space = false;
      }
      continue;
    }
    if (part === CELL_END) {
      cellDepth--;
      continue;
    }
    if (typeof part !== "string" && started) continue;
    const raw = typeof part === "string" ? part : part.fallback;
    let value = raw.slice(0, remaining).replaceAll("\0", "");
    remaining -= Math.min(raw.length, remaining);
    if (cellDepth) {
      value = value.replaceAll(/\s+/g, " ");
      const trimmed = value.trim();
      if (trimmed) {
        result += (started && (space || value.startsWith(" ")) ? " " : "") + trimmed;
        started = true;
      }
      space = value.endsWith(" ") || (!value && space);
    } else result += value;
    if (remaining === 0) break;
  }
  result = result.replaceAll(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
  if (!result) throw new Error("No text extracted");
  return result + (remaining === 0 ? TRUNCATED : "");
}
