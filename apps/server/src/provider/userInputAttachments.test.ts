// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "./DocumentText.ts";
import { extractDocumentText } from "./documentTextWorker.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as NodeZlib from "node:zlib";
import { appendUserInputAttachmentPaths } from "./userInputAttachments.ts";

const layer = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-answer-paths-" }),
  DocumentText.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const attachment = {
  type: "file" as const,
  id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
  name: 'spec "final".txt',
  mimeType: "text/plain",
  sizeBytes: 4,
};
describe("question answer paths", () => {
  it.effect("extracts notebook cells and outputs once and keeps both readable paths", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const file = {
        ...attachment,
        id: attachment.id.replace(/txt$/, "ipynb"),
        name: "survey.ipynb",
        mimeType: "application/x-ipynb+json",
      };
      const path = NodePath.join(config.attachmentsDir, `${file.id}.ipynb`);
      const notebook = JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Survey\n", "Vessel: Larkspur"] },
          {
            cell_type: "code",
            source: ["print(43 * 7)"],
            outputs: [{ text: ["301\n"] }, { data: { "text/plain": ["42"] } }],
          },
        ],
      });
      NodeFS.writeFileSync(path, notebook);
      const answers = yield* appendUserInputAttachmentPaths({
        answers: { q: "Read this" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [file] },
      });
      expect(answers.q).toContain(`text extracted to: "${path}.txt"`);
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Vessel: Larkspur");
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("301");
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("42");
      expect(NodeFS.readFileSync(path, "utf8")).toBe(notebook);
      const before = NodeFS.statSync(path + ".txt").mtimeMs;
      // A changed binary would fail parsing if the cached extraction were not reused.
      NodeFS.writeFileSync(path, "invalid notebook");
      const documents = yield* DocumentText.DocumentText;
      const results = yield* Effect.all([documents.ensure(path), documents.ensure(path)], {
        concurrency: "unbounded",
      });
      expect(results).toEqual([path + ".txt", path + ".txt"]);
      expect(NodeFS.statSync(path + ".txt").mtimeMs).toBe(before);
      yield* Effect.gen(function* () {
        const cleanup = yield* Cleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([file.id]);
        expect(NodeFS.existsSync(path)).toBe(false);
        expect(NodeFS.existsSync(path + ".txt")).toBe(false);
        NodeFS.writeFileSync(path + ".txt", "orphaned extraction");
        yield* cleanup.cleanupAttachments([file.id]);
        expect(NodeFS.existsSync(path + ".txt")).toBe(false);
      }).pipe(
        Effect.provide(
          Cleanup.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(TerminalManager.TerminalManager)({}),
                Layer.mock(PreviewManager.PreviewManager)({}),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "preserves corrupt documents, PDFs and unknown binaries without an extracted path",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        for (const extension of ["docx", "ipynb", "zip", "pdf"]) {
          const file = {
            ...attachment,
            id: attachment.id.replace(/txt$/, extension),
            name: `broken.${extension}`,
          };
          const path = NodePath.join(config.attachmentsDir, `${file.id}.${extension}`);
          NodeFS.writeFileSync(path, "invalid document");
          const answers = yield* appendUserInputAttachmentPaths({
            answers: {},
            attachmentsDir: config.attachmentsDir,
            attachmentsByQuestionId: { q: [file] },
          });
          expect(answers.q).toContain(path);
          expect(answers.q).not.toContain("text extracted");
          expect(NodeFS.existsSync(`${path}.txt`)).toBe(false);
          expect(NodeFS.readFileSync(path, "utf8")).toBe("invalid document");
        }
      }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves office structure and EPUB reading order with bounded archives", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const cases = [
        {
          ext: "docx",
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Report &amp; totals</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t>34</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
          },
          expected: ["## Report & totals", "North\t12 34"],
        },
        {
          ext: "xlsx",
          parts: {
            "xl/workbook.xml":
              '<workbook><sheets><sheet name="Inventory" r:id="a"/><sheet name="Budget" r:id="b"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/second.xml"/><Relationship Id="b" Target="worksheets/first.xml"/></Relationships>',
            "xl/sharedStrings.xml": "<sst><si><t>Lantern</t></si></sst>",
            "xl/worksheets/second.xml":
              '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>37</v></c></row></sheetData></worksheet>',
            "xl/worksheets/first.xml":
              '<worksheet><sheetData><row><c t="inlineStr"><is><t>Ferry</t></is></c><c><v>628</v></c></row></sheetData></worksheet>',
          },
          expected: ["## Sheet: Inventory", "Lantern\t\t37", "## Sheet: Budget", "Ferry\t628"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml":
              '<workbook><sheets><sheet name="Repeated" r:id="a"/><sheet name="Unneeded" r:id="missing"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/repeated.xml"/></Relationships>',
            "xl/sharedStrings.xml": `<sst><si><t>${"A".repeat(1_000_000 - "## Sheet: Repeated\n".length)}</t></si></sst>`,
            "xl/worksheets/repeated.xml": `<worksheet><sheetData>${'<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row>'.repeat(1_500)}</sheetData></worksheet>`,
          },
          expected: [
            "## Sheet: Repeated",
            "A".repeat(32),
            "[Extracted text truncated at 1,000,000 characters.]",
          ],
        },
        {
          ext: "pptx",
          parts: {
            "ppt/presentation.xml":
              '<p:presentation><p:sldIdLst><p:sldId id="1" r:id="b"/><p:sldId id="2" r:id="a"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
            "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Departure</a:t></a:r></a:p></p:sld>",
            "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Juniper Pier</a:t></a:r></a:p></p:sld>",
          },
          expected: ["## Slide 1", "Juniper Pier", "## Slide 2", "Departure"],
        },
        {
          ext: "odt",
          parts: {
            "content.xml":
              '<office:document><text:h text:outline-level="2">Orchard</text:h><text:p>19 violet crates</text:p></office:document>',
          },
          expected: ["## Orchard", "19 violet crates"],
        },
        {
          ext: "ods",
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Cargo"><table:table-row><table:table-cell><text:p>Violet</text:p></table:table-cell><table:table-cell office:value="19"/></table:table-row></table:table></office:document>',
          },
          expected: ["## Sheet: Cargo", "Violet\t19"],
        },
        {
          ext: "odp",
          parts: {
            "content.xml":
              "<office:document><draw:page><text:p>First</text:p></draw:page><draw:page><text:p>Second</text:p></draw:page></office:document>",
          },
          expected: ["## Slide 1", "First", "## Slide 2", "Second"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml":
              '<container><rootfile full-path="OEBPS/book.opf"/></container>',
            "OEBPS/book.opf":
              '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
            "OEBPS/a.xhtml":
              '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><body><p>Last chapter</p></body></html>',
            "OEBPS/b.xhtml":
              "<!DOCTYPE html><html><body><h1>First chapter</h1><p>Larkspur</p><div>Direct div<section>Direct section<li>Direct item <em>emphasis</em> trailing</li></section></div><table><thead><tr><th>Heading</th><th>Total</th></tr></thead><tbody><tr><td>Important value</td><td>731</td></tr></tbody></table></body></html>",
          },
          expected: [
            "## Chapter 1",
            "# First chapter",
            "Larkspur",
            "Direct div",
            "Direct section",
            "Direct item emphasis trailing",
            "Heading\tTotal",
            "Important value\t731",
            "## Chapter 2",
            "Last chapter",
          ],
        },
      ];
      for (const item of cases) {
        const local: Buffer[] = [];
        const central: Buffer[] = [];
        let offset = 0;
        for (const [name, content] of Object.entries(item.parts)) {
          const data = Buffer.from(content!);
          const filename = Buffer.from(name);
          const header = Buffer.alloc(30);
          header.writeUInt32LE(0x04034b50);
          header.writeUInt16LE(20, 4);
          header.writeUInt32LE(NodeZlib.crc32(data), 14);
          header.writeUInt32LE(data.length, 18);
          header.writeUInt32LE(data.length, 22);
          header.writeUInt16LE(filename.length, 26);
          const directory = Buffer.alloc(46);
          directory.writeUInt32LE(0x02014b50);
          directory.writeUInt16LE(20, 4);
          directory.writeUInt16LE(20, 6);
          directory.writeUInt32LE(NodeZlib.crc32(data), 16);
          directory.writeUInt32LE(data.length, 20);
          directory.writeUInt32LE(data.length, 24);
          directory.writeUInt16LE(filename.length, 28);
          directory.writeUInt32LE(offset, 42);
          local.push(header, filename, data);
          central.push(directory, filename);
          offset += header.length + filename.length + data.length;
        }
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50);
        end.writeUInt16LE(central.length / 2, 8);
        end.writeUInt16LE(central.length / 2, 10);
        end.writeUInt32LE(Buffer.concat(central).length, 12);
        end.writeUInt32LE(offset, 16);
        const path = NodePath.join(config.attachmentsDir, `structure.${item.ext}`);
        NodeFS.writeFileSync(path, Buffer.concat([...local, ...central, end]));
        const extracted = yield* Effect.promise(() => extractDocumentText(path, `.${item.ext}`));
        let previous = -1;
        for (const expected of item.expected) {
          const index = extracted.indexOf(expected);
          expect(index, `${item.ext}: ${expected} in ${extracted.slice(0, 500)}`).toBeGreaterThan(
            previous,
          );
          previous = index;
        }
        if (("bounded" in item && item.bounded) || item.ext === "epub") {
          expect(extracted.length).toBeLessThan(1_000_100);
          const documents = yield* DocumentText.DocumentText;
          expect(yield* documents.ensure(path)).toBe(path + ".txt");
          expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe(extracted);
        }
        if (item.ext === "docx") {
          end.writeUInt16LE(2049, 8);
          end.writeUInt16LE(2049, 10);
          NodeFS.writeFileSync(path, Buffer.concat([...local, ...central, end]));
          yield* Effect.promise(async () => {
            await expect(extractDocumentText(path, ".docx")).rejects.toThrow("Archive limit");
          });
          end.writeUInt16LE(central.length / 2, 8);
          end.writeUInt16LE(central.length / 2, 10);
          central[0]!.writeUInt16LE(8, 10);
          central[0]!.writeUInt32LE(33 * 1024 * 1024, 24);
          NodeFS.writeFileSync(path, Buffer.concat([...local, ...central, end]));
          yield* Effect.promise(async () => {
            await expect(extractDocumentText(path, ".docx")).rejects.toThrow("Archive limit");
          });
        }
      }
      const path = NodePath.join(config.attachmentsDir, "unicode.rtf");
      NodeFS.writeFileSync(
        path,
        String.raw`{\rtf1\ansi{\fonttbl hidden}Hello\tab world\par Unicode \u945?{\*\secret hidden}}`,
      );
      const extracted = yield* Effect.promise(() => extractDocumentText(path, ".rtf"));
      expect(extracted).toContain("Hello\tworld\nUnicode α");
      expect(extracted).not.toContain("hidden");
      NodeFS.writeFileSync(path, String.raw`{\rtf1 ` + "x".repeat(1_000_100) + "}");
      expect(yield* Effect.promise(() => extractDocumentText(path, ".rtf"))).toContain(
        "[Extracted text truncated",
      );
      NodeFS.writeFileSync(path, String.raw`{\rtf1 First` + " ".repeat(1_000_100) + "Last}");
      const whitespaceTruncated = yield* Effect.promise(() => extractDocumentText(path, ".rtf"));
      expect(whitespaceTruncated).toBe(
        "First\n\n[Extracted text truncated at 1,000,000 characters.]",
      );
      const documents = yield* DocumentText.DocumentText;
      expect(yield* documents.ensure(path)).toBe(path + ".txt");
      expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe(whitespaceTruncated);
      NodeFS.truncateSync(path, 17 * 1024 * 1024);
      yield* Effect.promise(async () => {
        await expect(extractDocumentText(path, ".rtf")).rejects.toThrow("Input byte limit");
      });
    }).pipe(Effect.provide(layer)),
  );
  it.effect("keeps selected values intact and appends an actual readable server path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = NodePath.join(config.attachmentsDir, `${attachment.id}.txt`);
      NodeFS.writeFileSync(path, "spec");
      const original = { q: ["First", "Second"], other: "No file" };
      const answers = yield* appendUserInputAttachmentPaths({
        answers: original,
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      });
      expect(answers.q).toEqual([
        "First",
        "Second",
        `Attached file "spec \\"final\\".txt": "${path}"`,
      ]);
      expect(answers.other).toBe("No file");
      expect(original.q).toEqual(["First", "Second"]);
      expect(NodeFS.readFileSync(path, "utf8")).toBe("spec");
      const specialKey = yield* appendUserInputAttachmentPaths({
        answers: {},
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { ["__proto__"]: [attachment] },
      });
      expect(Object.keys(specialKey)).toEqual(["__proto__"]);
      expect(specialKey["__proto__"]).toContain(path);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("does not send an unavailable attachment path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const result = yield* appendUserInputAttachmentPaths({
        answers: { q: "" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );
});
