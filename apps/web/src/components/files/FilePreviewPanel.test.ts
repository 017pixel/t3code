import JSZip from "jszip";
import { openRtf, openNotebook, openDocument, openEpub } from "./extendedDocumentPreview";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  filePreviewReadErrorMessage,
  isMarkdownPreviewFile,
  resolveFilePreviewPath,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
  workspaceAssetResource,
} from "./filePreviewMode";

const decodeReadError = Schema.decodeSync(ProjectReadFileError);

describe("file preview read errors", () => {
  it.each([
    ["path_not_file", "The path is a directory or special file, not a regular file."],
    ["binary_file", "The file is binary and cannot be displayed as text."],
    ["workspace_path_outside_root", "The requested path is outside the workspace."],
    ["resolved_path_outside_root", "The path resolves to a location outside the workspace."],
    [
      "operation_failed",
      "The file could not be accessed or read. It may be missing or inaccessible.",
    ],
  ] as const)("describes %s without revealing the platform cause", (failure, message) => {
    const error = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "workspace/outline.md",
      failure,
      operation: "realpath-target",
      resolvedPath: "/workspace/workspace/outline.md",
      cause: new Error("EACCES: sensitive platform detail"),
    });
    expect(filePreviewReadErrorMessage(error)).toBe(message);
  });

  it("distinguishes an inaccessible workspace from an inaccessible file", () => {
    const error = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "outline.md",
      failure: "operation_failed",
      operation: "realpath-workspace-root",
      operationPath: "/workspace",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("The workspace folder could not be accessed.");
  });

  it("preserves the public message from older servers", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Legacy file read failure.",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("Legacy file read failure.");
  });
});

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MARKDOWN")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.mdown")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.mkd")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("shouldShowFileExplorer", () => {
  it("hides the workspace tree for host files and attachments", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "/tmp/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "report.pdf",
        explorerOpen: true,
        attachmentOpen: true,
      }),
    ).toBe(false);
  });

  it("keeps the saved explorer preference for workspace files", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: false,
        attachmentOpen: false,
      }),
    ).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("resolveFilePreviewPath", () => {
  it.each([
    ["/repo/project", null],
    ["/repo/project/", null],
    [".", null],
    [null, null],
    ["/repo/project/src", "/repo/project/src"],
    ["/repo/project/src/main.ts", "/repo/project/src/main.ts"],
    ["src/main.ts", "src/main.ts"],
    ["/repo/project-other", "/repo/project-other"],
  ])("opens %s in the appropriate workspace surface", (path, expected) => {
    const relativePath = resolveFilePreviewPath(path, "/repo/project");
    expect(relativePath).toBe(expected);
    if (expected === null) {
      expect(
        shouldShowFileExplorer({ relativePath, explorerOpen: false, attachmentOpen: false }),
      ).toBe(true);
    }
  });
});

describe("workspaceAssetResource", () => {
  const input = {
    kind: "workspace-file" as const,
    threadRef: {
      environmentId: "env" as ScopedThreadRef["environmentId"],
      threadId: "thread-1" as ScopedThreadRef["threadId"],
    },
    workspaceRoot: "/repo",
    absolutePath: "/repo/docs/index.html",
  };

  it("names the thread once the server knows it", () => {
    expect(workspaceAssetResource({ ...input, draft: false })).toEqual({
      _tag: "workspace-file",
      threadId: "thread-1",
      path: "/repo/docs/index.html",
    });
  });

  it("names the workspace root for a draft, which the server cannot resolve from a thread", () => {
    expect(workspaceAssetResource({ ...input, draft: true })).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "/repo/docs/index.html",
    });
  });
});

describe("document preview contents", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer;

  it("decodes rich text formatting and Unicode without showing hidden destinations", () => {
    const result = openRtf(
      bytes(
        String.raw`{\rtf1\ansi{\fonttbl{\f0 Hidden font;}}Hello \b bold\b0\par Unicode: \u945?{\*\unknown hidden}{\field{\*\fldinst HYPERLINK "https://example.com"}{\fldrslt visible}}}`,
      ),
    );
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    const html = result.pages[0]!.html;
    expect(html.replaceAll(/<[^>]*>/g, "")).toBe("Hello boldUnicode: αvisible");
    expect(html).toContain("<strong>");
    expect(html).not.toContain("https:");
  });

  it("reads saved notebook cells and preferred outputs without executing code", () => {
    const result = openNotebook(
      bytes(
        JSON.stringify({
          nbformat: 4,
          metadata: { language_info: { name: "python" } },
          cells: [
            { cell_type: "markdown", source: ["# Results"] },
            {
              cell_type: "code",
              source: ["print(42)"],
              outputs: [
                { output_type: "stream", text: ["\n  "] },
                { output_type: "display_data", data: {} },
                { data: { "text/html": [""] } },
                { output_type: "stream", text: ["42\n"] },
                { data: { "text/html": ["<b>Results</b>"], "text/plain": ["Results"] } },
              ],
            },
          ],
        }),
      ),
    );
    expect(result).toEqual({
      type: "notebook",
      language: "python",
      cells: [
        { kind: "markdown", source: "# Results", outputs: [] },
        {
          kind: "code",
          source: "print(42)",
          outputs: [
            { kind: "text", text: "42\n" },
            { kind: "html", text: "<b>Results</b>" },
          ],
        },
      ],
    });
    expect(() => openNotebook(bytes('{"nbformat":3,"cells":[]}'))).toThrow("version 4");
    expect(() =>
      openNotebook(
        bytes(JSON.stringify({ nbformat: 4, cells: Array.from({ length: 501 }, () => ({})) })),
      ),
    ).toThrow("500 cells");
  });

  it("bounds repeated OpenDocument spreadsheet cells and keeps sheet names and values", async () => {
    const archive = new JSZip().file(
      "content.xml",
      '<office:document-content xmlns:office="office" xmlns:table="table" xmlns:text="text"><office:body><office:spreadsheet><table:table table:name="Budget"><table:table-row table:number-rows-repeated="999999999"><table:table-cell table:number-columns-repeated="999999999"><text:p>Research &amp; design</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
    );
    const result = await openDocument(archive, "ods");
    expect(result.type).toBe("xlsx");
    if (result.type !== "xlsx") throw new Error("Expected workbook");
    expect(result.sheets[0]!.name).toBe("Budget");
    expect(result.sheets[0]!.truncated).toBe(true);
    expect(result.sheets[0]!.rows).toHaveLength(500);
    expect(result.sheets[0]!.rows[0]).toHaveLength(50);
    expect(result.sheets[0]!.rows[0]![0]).toBe("Research & design");
  });

  it.each(["odt", "odp"] as const)("reads %s text and rejects XML entities", async (kind) => {
    const archive = new JSZip().file(
      "content.xml",
      `<office:document-content xmlns:office="office" xmlns:text="text" xmlns:draw="draw"><office:body>${kind === "odt" ? "<office:text><text:p>Field notes</text:p></office:text>" : '<draw:page draw:name="Overview"><text:h>Launch plan</text:h></draw:page>'}</office:body></office:document-content>`,
    );
    const result = await openDocument(archive, kind);
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toContain(kind === "odt" ? "Field notes" : "Launch plan");
    archive.file(
      "content.xml",
      '<!DOCTYPE x [<!ENTITY external SYSTEM "file:///etc/passwd">]><x>&external;</x>',
    );
    await expect(openDocument(archive, kind)).rejects.toThrow("unsupported XML");
  });

  it("reads EPUB chapters in spine order and removes active and remote content", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="Book/book.opf"/></rootfiles></container>',
      )
      .file(
        "Book/book.opf",
        '<package><manifest><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/><item id="b" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
      )
      .file(
        "Book/one.xhtml",
        '<html><head><title>First</title></head><body><h1>First chapter</h1><img src="cover.png" alt="Cover"/><img src="https://example.com/tracker.png"/><script>alert(1)</script><style>@import "https://example.com/style.css";</style></body></html>',
      )
      .file(
        "Book/two.xhtml",
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><head><title>Second</title></head><body><h1>Second chapter</h1></body></html>',
      )
      .file("Book/cover.png", new Uint8Array([137, 80, 78, 71]));
    const result = await openEpub(archive);
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages.map((page) => page.title)).toEqual(["Second", "First"]);
    expect(result.pages[1]!.html).toContain('src="data:image/png;base64,');
    expect(result.pages[1]!.html).not.toMatch(/https:|script|alert/);
  });
});
