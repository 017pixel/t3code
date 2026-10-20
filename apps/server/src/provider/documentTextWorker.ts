// @effect-diagnostics nodeBuiltinImport:off -- isolated CLI worker; no server runtime is loaded here.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { SaxesParser } from "saxes";
import * as Yauzl from "yauzl";

const MAX_INPUT = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_OUTPUT = 1_000_000;
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
function all(node: XmlNode, name: string): XmlNode[] {
  return children(node).flatMap((child) => (child.name === name ? [child] : all(child, name)));
}
function text(node: XmlNode): string {
  if (["script", "style", "binary-data"].includes(node.name)) return "";
  if (["tab", "cell"].includes(node.name)) return "\t";
  if (["br", "line-break"].includes(node.name)) return "\n";
  if (node.spaceCount !== undefined) return " ".repeat(node.spaceCount);
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}
function paragraphs(node: XmlNode): string {
  if (["script", "style", "binary-data"].includes(node.name)) return "";
  return node.children
    .map((child) => {
      if (typeof child === "string") return child;
      if (child.name === "tbl" || child.name === "table") return table(child);
      if (child.name === "p" || child.name === "h") {
        const style = all(child, "pStyle")[0]?.attrs.val ?? "";
        const level =
          child.name === "h"
            ? Number(child.attrs["outline-level"]) || 1
            : Number(style.match(/^Heading([1-6])$/i)?.[1]) || 0;
        return `${"#".repeat(Math.min(6, level))}${level ? " " : ""}${text(child)}\n`;
      }
      if (/^h[1-6]$/.test(child.name))
        return `${"#".repeat(Number(child.name[1]))} ${text(child)}\n`;
      if (["li", "div", "section"].includes(child.name)) return `${paragraphs(child)}\n`;
      return paragraphs(child) || text(child);
    })
    .join("");
}
function table(node: XmlNode, limit = MAX_OUTPUT + 1): string {
  const rows = [...all(node, "tr"), ...all(node, "table-row")];
  if (rows.length > 10_000) throw new Error("Row limit");
  let result = "";
  let rowCount = 0;
  for (const row of rows) {
    const cells = children(row).filter((cell) =>
      ["tc", "table-cell", "covered-table-cell", "td", "th"].includes(cell.name),
    );
    const values: string[] = [];
    let length = 0;
    const budget = limit - result.length;
    for (const cell of cells) {
      const count = Math.min(512, Number(cell.attrs["number-columns-repeated"]) || 1);
      if (values.length + count > 512) throw new Error("Column limit");
      const value = paragraphs(cell).replaceAll(/\s+/g, " ").trim() || cell.attrs.value || "";
      for (let column = 0; column < count; column++) {
        if (values.length > 0) length++;
        const part = value.slice(0, Math.max(0, budget - length));
        values.push(part);
        length += part.length;
        if (length >= budget) break;
      }
      if (length >= budget) break;
    }
    const line = values.join("\t");
    const repeat = Math.min(10_000, Number(row.attrs["number-rows-repeated"]) || 1);
    if (!line.trim()) continue;
    rowCount += repeat;
    if (rowCount > 10_000) throw new Error("Repeated row limit");
    const remaining = limit - result.length;
    result += `${line}\n`
      .repeat(Math.min(repeat, Math.ceil(remaining / (line.length + 1))))
      .slice(0, remaining);
    if (result.length >= limit) break;
  }
  return result;
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

function notebook(source: string): string {
  const book: unknown = JSON.parse(source);
  if (
    !book ||
    typeof book !== "object" ||
    !("cells" in book) ||
    !Array.isArray(book.cells) ||
    book.cells.length > 10_000
  )
    throw new Error("Invalid notebook");
  const lines = (value: unknown): string =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.filter((line) => typeof line === "string").join("")
        : "";
  return book.cells
    .map((cell: unknown, index) => {
      if (!cell || typeof cell !== "object") return "";
      const source = "source" in cell ? lines(cell.source) : "";
      const kind = "cell_type" in cell && cell.cell_type === "code" ? "code" : "markdown";
      const outputs =
        "outputs" in cell && Array.isArray(cell.outputs)
          ? cell.outputs
              .map((output: unknown) => {
                if (!output || typeof output !== "object") return "";
                if ("text" in output) return lines(output.text);
                if ("data" in output && output.data && typeof output.data === "object") {
                  if ("text/plain" in output.data) return lines(output.data["text/plain"]);
                }
                return "";
              })
              .join("\n")
          : "";
      return `## Cell ${index + 1} (${kind})\n${source}\n${outputs ? `Output:\n${outputs}` : ""}`;
    })
    .join("\n\n");
}

function rtf(source: string): string {
  if (!source.startsWith("{\\rtf")) throw new Error("Invalid RTF document");
  let state = { skip: false, uc: 1, decoder: new TextDecoder("windows-1252") };
  const stack: Array<typeof state> = [];
  let fallback = 0;
  let result = "";
  for (let i = 0; i < source.length && result.length <= MAX_OUTPUT; i++) {
    const char = source[i]!;
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
          result += state.decoder.decode(Uint8Array.of(Number.parseInt(hex[1]!, 16)));
        i += 3;
      } else if (word) {
        i += word[0].length;
        const control = word[1]!;
        const value = Number(word[2]);
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
        } else if (control === "bin") {
          if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("Invalid RTF binary length");
          i += value;
        } else if (control === "uc") state.uc = Math.max(0, Math.min(16, value));
        else if (control === "u" && !state.skip) {
          result += String.fromCharCode(value < 0 ? value + 65536 : value);
          fallback = state.uc;
        } else if (!state.skip && ["par", "line", "row"].includes(control)) result += "\n";
        else if (!state.skip && ["tab", "cell"].includes(control)) result += "\t";
      } else {
        i++;
        if (rest[0] === "*") state.skip = true;
        else if (fallback) fallback--;
        else if (!state.skip && ["\\", "{", "}"].includes(rest[0]!)) result += rest[0];
        else if (!state.skip && rest[0] === "~") result += " ";
      }
    } else if (!state.skip && char !== "\n" && char !== "\r") {
      if (fallback) fallback--;
      else
        result +=
          char.charCodeAt(0) < 128 ? char : state.decoder.decode(Uint8Array.of(char.charCodeAt(0)));
    }
  }
  return result;
}

export async function extractDocumentText(path: string, extension: string): Promise<string> {
  if ((await NodeFSP.stat(path)).size > MAX_INPUT) throw new Error("Input byte limit");
  let result: string;
  let outputTruncated = false;
  if (extension === ".ipynb") result = notebook(await NodeFSP.readFile(path, "utf8"));
  else if (extension === ".rtf") {
    result = rtf((await NodeFSP.readFile(path)).toString("latin1"));
    outputTruncated = result.length > MAX_OUTPUT;
  } else {
    const files = await archive(path);
    const read = (name: string) => {
      const data = files.get(name);
      if (!data) throw new Error("Missing document part");
      return xml(data, [".odt", ".ods", ".odp"].includes(extension));
    };
    if (extension === ".docx") result = paragraphs(read("word/document.xml"));
    else if ([".odt", ".ods", ".odp"].includes(extension)) {
      const content = read("content.xml");
      if (extension === ".ods") {
        result = "";
        for (const sheet of all(content, "table")) {
          result += `${result ? "\n\n" : ""}## Sheet: ${sheet.attrs.name ?? "Untitled"}\n`.slice(
            0,
            MAX_OUTPUT + 1 - result.length,
          );
          if (result.length > MAX_OUTPUT) break;
          result += table(sheet, MAX_OUTPUT + 1 - result.length);
          if (result.length > MAX_OUTPUT) break;
        }
      } else {
        result =
          extension === ".odp"
            ? all(content, "page")
                .map((slide, i) => `## Slide ${i + 1}\n${paragraphs(slide)}`)
                .join("\n\n")
            : paragraphs(content);
      }
    } else if (extension === ".xlsx") {
      const strings = files.has("xl/sharedStrings.xml")
        ? all(read("xl/sharedStrings.xml"), "si").map(text)
        : [];
      const relations = new Map(
        all(read("xl/_rels/workbook.xml.rels"), "Relationship")
          .filter((rel) => rel.attrs.TargetMode !== "External")
          .map((rel) => [rel.attrs.Id, rel.attrs.Target]),
      );
      result = "";
      for (const sheet of all(read("xl/workbook.xml"), "sheet")) {
        if (result.length > MAX_OUTPUT) break;
        const target = relations.get(sheet.attrs["r:id"] ?? sheet.attrs.id);
        if (!target) throw new Error("Missing sheet relationship");
        const name = target.startsWith("/")
          ? target.slice(1)
          : NodePath.posix.normalize(`xl/${target}`);
        const rows = all(read(name), "row");
        if (rows.length > 10_000) throw new Error("Row limit");
        result += `${result ? "\n" : ""}## Sheet: ${sheet.attrs.name}\n`.slice(
          0,
          MAX_OUTPUT + 1 - result.length,
        );
        for (const row of rows) {
          if (result.length > MAX_OUTPUT) break;
          const values: string[] = [];
          let rowLength = 0;
          for (const cell of children(row).filter((node) => node.name === "c")) {
            const letters = cell.attrs.r?.match(/^[A-Z]+/)?.[0];
            const column = letters
              ? [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1
              : values.length;
            if (column > 511) throw new Error("Column limit");
            while (values.length <= column) values.push("");
            const value = all(cell, "v")[0];
            const raw = value ? text(value) : "";
            rowLength -= values[column]!.length;
            values[column] = (
              cell.attrs.t === "s"
                ? (strings[Number(raw)] ?? "")
                : cell.attrs.t === "inlineStr"
                  ? all(cell, "t").map(text).join("")
                  : raw || all(cell, "f").map(text).join("")
            )
              .slice(0, MAX_OUTPUT + 1 - result.length - rowLength)
              .replaceAll(/[\t\r\n]+/g, " ");
            rowLength += values[column]!.length;
            if (result.length + rowLength > MAX_OUTPUT) break;
          }
          result += `${values.join("\t")}\n`.slice(0, MAX_OUTPUT + 1 - result.length);
        }
      }
      outputTruncated = result.length > MAX_OUTPUT;
    } else if (extension === ".pptx") {
      const relations = new Map(
        all(read("ppt/_rels/presentation.xml.rels"), "Relationship")
          .filter((rel) => rel.attrs.TargetMode !== "External")
          .map((rel) => [rel.attrs.Id, rel.attrs.Target]),
      );
      result = all(read("ppt/presentation.xml"), "sldId")
        .map((slide, i) => {
          const target = relations.get(slide.attrs["r:id"] ?? slide.attrs.id);
          if (!target) throw new Error("Missing slide relationship");
          return `## Slide ${i + 1}\n${paragraphs(read(target.startsWith("/") ? target.slice(1) : NodePath.posix.normalize(`ppt/${target}`)))}`;
        })
        .join("\n\n");
    } else if (extension === ".epub") {
      const rootfile = all(read("META-INF/container.xml"), "rootfile")[0]?.attrs["full-path"];
      if (!rootfile) throw new Error("Missing EPUB package");
      const packageXml = read(rootfile);
      const items = new Map(
        all(packageXml, "item").map((item) => [item.attrs.id, item.attrs.href]),
      );
      result = all(packageXml, "itemref")
        .map((item, i) => {
          const href = items.get(item.attrs.idref);
          if (!href) throw new Error("Missing chapter");
          const name = NodePath.posix.normalize(
            NodePath.posix.join(
              NodePath.posix.dirname(rootfile),
              decodeURIComponent(href.split("#")[0]!),
            ),
          );
          return `## Chapter ${i + 1}\n${paragraphs(read(name))}`;
        })
        .join("\n\n");
    } else throw new Error("Unsupported document");
  }
  outputTruncated ||= result.length > MAX_OUTPUT;
  result = result
    .replaceAll("\0", "")
    .replaceAll(/\n(?:[ \t]*\n){2,}/g, "\n\n")
    .trim();
  if (!result) throw new Error("No text extracted");
  return outputTruncated || result.length > MAX_OUTPUT
    ? result.slice(0, MAX_OUTPUT) + TRUNCATED
    : result;
}
