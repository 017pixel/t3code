import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
// Never load the original: its highlighter graph can outlast waitFor on a cold CI browser.
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { OfficeFilePreview } from "./OfficeFilePreview";
import { MermaidFilePreview } from "./MermaidFilePreview";
import type { OfficeWorkerResult } from "./officePreviewProtocol";

it.each([
  "paragraphs",
  "runs",
  "tables",
  "auxiliary XML",
  "XML bytes",
  "renamed XML",
  "section after prefix",
  "oversized section",
])("bounds excessive Word %s before rendering DOM", async (scenario) => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const body = ["paragraphs", "section after prefix", "oversized section"].includes(scenario)
    ? "<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(200_000)
    : scenario === "runs"
      ? `<w:p>${"<w:r><w:t>x</w:t></w:r>".repeat(50_001)}</w:p>`
      : scenario === "tables"
        ? "<w:tbl/>".repeat(50_001)
        : scenario === "XML bytes"
          ? `<w:p><w:r><w:t>${"x".repeat(2 * 1024 * 1024)}</w:t></w:r></w:p>`
          : "<w:p/>";
  const section =
    '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:left="1440" w:bottom="1440" w:right="1440"/></w:sectPr>';
  archive.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${scenario === "section after prefix" ? '<w:p xmlns:s="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:pPr><s:sectPr><s:pgSz s:w="11906" s:h="16838"/></s:sectPr></w:pPr></w:p>' : ""}${scenario === "oversized section" ? `<w:sectPr>${"<w:cols/>".repeat(2_001)}</w:sectPr>` : section}</w:body></w:document>`,
  );
  if (scenario === "auxiliary XML" || scenario === "renamed XML")
    archive.file(
      scenario === "renamed XML" ? "word/footnotes.dat" : "word/footnotes.xml",
      `<w:footnotes>${"<w:p/>".repeat(50_001)}</w:footnotes>`,
    );
  const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
  const src = URL.createObjectURL(file);
  try {
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        void file
          .arrayBuffer()
          .then((bytes) => worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]));
      });
      if (
        scenario === "auxiliary XML" ||
        scenario === "renamed XML" ||
        scenario === "oversized section"
      ) {
        expect(result).toMatchObject({
          type: "error",
          message: expect.stringContaining("Preview limited"),
        });
      } else {
        expect(result.type).toBe("docx");
        if (result.type !== "docx") throw new Error("Expected a Word prefix");
        expect(result.truncated).toBe(true);
        for (const xml of result.documents) {
          const document = new DOMParser().parseFromString(xml, "application/xml");
          expect(document.querySelector("parsererror")).toBeNull();
          const bodies = document.getElementsByTagNameNS("*", "body");
          expect(bodies).toHaveLength(1);
          const section = bodies[0]!.lastElementChild!;
          expect(section.localName).toBe("sectPr");
          const size = section.getElementsByTagNameNS("*", "pgSz")[0]!;
          expect(size.getAttributeNS(section.namespaceURI, "w")).toBe(
            scenario === "section after prefix" ? "11906" : "16838",
          );
          expect(size.getAttributeNS(section.namespaceURI, "orient")).toBe(
            scenario === "section after prefix" ? null : "landscape",
          );
        }
        const markup = result.documents.join("");
        expect(markup.length).toBeLessThan(body.length);
        expect(markup.length).toBeLessThanOrEqual(3 * 1024 * 1024);
        expect(markup.match(/<(?![!?/])/g)!.length).toBeLessThanOrEqual(100_000);
      }
    } finally {
      worker.terminate();
    }
  } finally {
    URL.revokeObjectURL(src);
  }
});

it.each([
  "relationship markup",
  "relationship bytes",
  "content type",
  "metadata type",
  "deep XML",
  "query path",
])("bounds XML hidden in media by %s", async (scenario) => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const path = `word/media/payload.png${scenario === "query path" ? "?xml" : ""}`;
  archive.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
  );
  archive.file(
    "[Content_Types].xml",
    `<Types><Override PartName="/${path}" ContentType="${scenario === "content type" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml" : "image/png"}"/>${scenario === "metadata type" ? '<Default Extension="rels" ContentType="image/png"/>' : ""}</Types>`,
  );
  archive.file(
    "word/_rels/document.xml.rels",
    `<Relationships>${scenario === "content type" ? "" : `<Relationship Id="style" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="${path.slice(5)}"/>`}${scenario === "metadata type" ? "<unused/>".repeat(50_001) : ""}</Relationships>`,
  );
  archive.file(
    path,
    scenario === "relationship bytes"
      ? `<styles>${"x".repeat(1024 * 1024)}</styles>`
      : scenario === "deep XML"
        ? `${"<styles>".repeat(65)}${"</styles>".repeat(65)}`
        : `<styles>${"<style/>".repeat(50_001)}</styles>`,
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const result = await new Promise<OfficeWorkerResult>((resolve) => {
      worker.addEventListener(
        "message",
        (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
        { once: true },
      );
      worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]);
    });
    expect(result).toMatchObject({
      type: "error",
      message: expect.stringContaining("Preview limited"),
    });
  } finally {
    worker.terminate();
  }
});

it.each([
  "footnotes",
  "endnotes",
  "header",
  "footer",
  "comments",
  "fontTable",
  "styles",
  "numbering",
  "picture numbering",
])(
  "keeps the body and warns when omitting expanded %s",
  async (role) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const type = role === "picture numbering" ? "numbering" : role;
    archive.file(
      "_rels/.rels",
      '<Relationships><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    const text = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="${ns}"><w:body>${text("body retained")}${Array.from({ length: 500 }, () => `<w:p><w:r><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`,
    );
    archive.file(
      "word/_rels/document.xml.rels",
      `<Relationships><Relationship Id="aux" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="media/aux.xml"/></Relationships>`,
    );
    const xml =
      role === "styles"
        ? `<w:styles xmlns:w="${ns}">${Array.from({ length: 100 }, (_, i) => `<w:style w:styleId="s${i}" w:type="paragraph"><w:basedOn w:val="s0"/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style>`).join("")}</w:styles>`
        : role.includes("numbering")
          ? `<w:numbering xmlns:w="${ns}">${role === "picture numbering" ? '<w:numPicBullet w:numPicBulletId="1"/>' : ""}<w:abstractNum w:abstractNumId="1">${Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:lvlText w:val="%1."/></w:lvl>`).join("")}</w:abstractNum>${Array.from({ length: 100 }, (_, i) => `<w:num w:numId="${i}"><w:abstractNumId w:val="1"/></w:num>`).join("")}</w:numbering>`
          : `<w:footnotes xmlns:w="${ns}"><w:footnote w:id="1">${text("omitted payload").repeat(2_000)}</w:footnote></w:footnotes>`;
    archive.file("word/media/aux.xml", xml);
    const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
    const src = URL.createObjectURL(file);
    try {
      await using screen = await render(
        <OfficeFilePreview src={src} name="expanded.docx" kind="docx" sizeBytes={file.size} />,
      );
      await vi.waitFor(
        () => {
          expect(screen.container.querySelector('[role="alert"]')?.textContent ?? "").toBe("");
          expect(screen.container.querySelector("iframe")?.srcdoc).toContain("body retained");
        },
        { timeout: 30_000 },
      );
      expect(screen.container.textContent).toContain("Preview limited");
      const frame = screen.container.querySelector("iframe")!;
      expect(frame.srcdoc).not.toContain("omitted payload");
      expect(frame.srcdoc.length).toBeLessThan(150_000);
    } finally {
      URL.revokeObjectURL(src);
    }
  },
  35_000,
);

it("charges auxiliary XML once per Word render batch", async () => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  archive.file(
    "word/document.xml",
    `<w:document xmlns:w="${ns}"><w:body>${"<w:p><w:r><w:t>body</w:t></w:r></w:p>".repeat(5_000)}</w:body></w:document>`,
  );
  archive.file(
    "word/_rels/document.xml.rels",
    '<Relationships><Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
  );
  const settings = `<w:settings xmlns:w="${ns}"><w:unused>${"s".repeat(120_000)}</w:unused></w:settings>`;
  archive.file("word/settings.xml", settings);
  const bytes = await archive.generateAsync({ type: "arraybuffer" });
  const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const result = await new Promise<OfficeWorkerResult>((resolve) => {
      worker.addEventListener(
        "message",
        (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
        { once: true },
      );
      worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]);
    });
    expect(result.type).toBe("docx");
    if (result.type !== "docx") throw new Error("Expected a Word prefix");
    expect(result.truncated).toBe(true);
    expect(result.documents.length).toBeGreaterThan(1);
    expect(
      result.documents.reduce((sum, xml) => sum + xml.length + settings.length, 0),
    ).toBeLessThanOrEqual(3 * 1024 * 1024);
  } finally {
    worker.terminate();
  }
});

it.each(["repeated binary", "XML relationship alias", "duplicate relationship ID"])(
  "bounds Word image expansion for %s",
  async (scenario) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "[Content_Types].xml",
      '<Types><Default Extension="png" ContentType="image/png"/></Types>',
    );
    archive.file(
      "word/_rels/document.xml.rels",
      `<Relationships><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${scenario === "XML relationship alias" ? "styles" : "image"}" Target="media/payload.png"/>${scenario === "duplicate relationship ID" ? '<Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tiny.png"/>' : ""}</Relationships>`,
    );
    archive.file(
      "word/media/payload.png",
      scenario === "XML relationship alias" ? "<styles/>" : new Uint8Array(8 * 1024 * 1024),
    );
    if (scenario === "duplicate relationship ID")
      archive.file("word/media/tiny.png", new Uint8Array(1));
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p>${'<w:r><a:blip r:embed="image"/></w:r>'.repeat(7)}</w:p></w:body></w:document>`,
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]);
      });
      expect(result).toMatchObject({
        type: "error",
        message: expect.stringContaining("expanded markup"),
      });
    } finally {
      worker.terminate();
    }
  },
);

it.each(["XFD200", "XFD1048576", "AX500", "AZ9999999"])(
  "bounds spreadsheet cells at %s before padding",
  async (ref) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    // A nonstandard relationship target must get the same bounds.
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="custom.xml"/></Relationships>',
    );
    archive.file(
      "xl/custom.xml",
      `<worksheet><dimension ref="A1:${ref}"/><sheetData><row r="1"><c r="A1"><v>7</v></c></row><row r="${ref.replace(/\D/g, "")}"><c r="${ref}"><v>9</v></c></row></sheetData></worksheet>`,
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]);
      });
      if (ref === "AZ9999999") {
        expect(result).toMatchObject({
          type: "error",
          message: expect.stringContaining("invalid"),
        });
      } else {
        expect(result.type).toBe("xlsx");
        if (result.type !== "xlsx") throw new Error("Expected workbook values");
        const sheet = result.sheets[0]!;
        expect(sheet.rows[0]![0]).toBe("7");
        expect(sheet.rows.length).toBeLessThanOrEqual(500);
        expect(Math.max(...sheet.rows.map((row) => row.length))).toBeLessThanOrEqual(50);
        expect(sheet.truncated).toBe(ref !== "AX500");
        if (ref === "AX500") expect(sheet.rows[499]![49]).toBe("9");
      }
    } finally {
      worker.terminate();
    }
  },
);

it("keeps spreadsheet dates on their calendar day west of UTC", async () => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  archive.file(
    "xl/styles.xml",
    '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>46023</v></c></row></sheetData></worksheet>',
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer" });
  const workerModule = new URL("./officePreview.worker.ts?worker_file&type=module", import.meta.url)
    .href;
  // Give the worker a west-of-UTC default while preserving explicit format options.
  const bootstrap = URL.createObjectURL(
    new Blob(
      [
        `
    const format = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function(locale, options) {
      return format.call(this, "en-US", { timeZone: "America/Los_Angeles", ...options });
    };
    await import(${JSON.stringify(workerModule)});
    postMessage({ type: "ready" });
  `,
      ],
      { type: "text/javascript" },
    ),
  );
  const worker = new Worker(bootstrap, { type: "module" });
  try {
    const result = await new Promise<OfficeWorkerResult>((resolve) => {
      worker.addEventListener(
        "message",
        (event: MessageEvent<OfficeWorkerResult | { type: "ready" }>) => {
          if (event.data.type === "ready")
            worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]);
          else resolve(event.data);
        },
      );
    });
    if (result.type === "error") throw new Error(result.message);
    expect(result).toMatchObject({ type: "xlsx", sheets: [{ rows: [["1/1/2026"]] }] });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(bootstrap);
  }
});

it.each([60, 100])(
  "renders all %i pages of a table-heavy Word report",
  async (pages) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    const paragraph = (text: string) =>
      `<w:p><w:pPr><w:spacing w:after="120"/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${Array.from({ length: pages }, (_, page) => paragraph(`page ${page + 1}`) + `<w:tbl>${Array.from({ length: 10 }, () => `<w:tr>${Array.from({ length: 5 }, () => `<w:tc><w:tcPr><w:tcW w:w="1800"/></w:tcPr>${paragraph("report entry")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`).join("")}</w:body></w:document>`,
    );
    archive.file(
      "_rels/.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    archive.file(
      "[Content_Types].xml",
      '<Types><Default Extension="png" ContentType="image/png"/></Types>',
    );
    // Binary media must not consume the document's markup budget.
    archive.file("word/media/image.png", new Uint8Array(2_500_000));
    const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
    const src = URL.createObjectURL(file);
    try {
      await using screen = await render(
        <OfficeFilePreview src={src} name="report.docx" kind="docx" sizeBytes={file.size} />,
      );
      await vi.waitFor(
        () => expect(screen.container.querySelector("iframe")?.srcdoc).toContain(`page ${pages}`),
        { timeout: 30_000 },
      );
      expect(screen.container.textContent).not.toContain("Preview limited");
      expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      URL.revokeObjectURL(src);
    }
  },
  35_000,
);

describe("standalone Mermaid previews", () => {
  it.each([
    'A@{ "img": "//attacker.invalid/pixel.png" }',
    'A@{ "im\\u0067": "/pixel.png" }',
    "A@{ label: &key img, *key: '/pixel.png' }",
    'A["<img src=//attacker.invalid/pixel.png>"]',
  ])("rejects resource syntax before Mermaid lays out %s", async (node) => {
    using imageSource = vi
      .spyOn(HTMLImageElement.prototype, "src", "set")
      .mockImplementation(() => {});
    await using screen = await render(<MermaidFilePreview text={`flowchart LR\n${node}`} />);
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Show Mermaid source",
      ),
    );
    expect(imageSource).not.toHaveBeenCalled();
    expect(screen.container.querySelector("svg")).toBeNull();
  });

  it.each(["<-->", "<==>", "<-.->", "-->"])("renders the %s arrow", async (arrow) => {
    await using screen = await render(<MermaidFilePreview text={`flowchart LR\nA ${arrow} B`} />);
    await vi.waitFor(
      () => expect(screen.container.querySelector("svg .edgePaths path")).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    expect(screen.container.textContent).toContain("A");
    expect(screen.container.textContent).toContain("B");
  });
});

it("clears an Office metadata error when the same URL becomes previewable", async () => {
  const src = "data:application/octet-stream,invalid-office-file";
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  using _fetch = stubGlobal(
    "fetch",
    vi.fn(() => response),
  );
  await using screen = await render(
    <OfficeFilePreview src={src} name="report.docx" kind="docx" sizeBytes={51 * 1024 * 1024} />,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("under 50 MB"));
  await screen.rerender(
    <OfficeFilePreview src={src} name="report.docx" kind="docx" sizeBytes={100} />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[aria-label="Loading file"]')).not.toBeNull(),
  );
  expect(screen.container.textContent).not.toContain("under 50 MB");
  resolveResponse(new Response("invalid-office-file"));
  await vi.waitFor(() => expect(screen.container.textContent).toContain("not a valid Office"), {
    timeout: 10_000,
  });
});

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";

  function setup() {
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
  }

  const openRemote = () =>
    render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
      />,
    );

  const toggleMode = async (screen: Screen, label: string) => {
    const button = screen.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = (screen: Screen) => screen.container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode(screen, "Show HTML source");
    await act(async () => {
      await import("./ReadOnlySourcePreview");
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );

    await toggleMode(screen, "Show rendered page");
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode(screen, "Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(alert(screen)?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode(screen, "Show rendered page");
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await using screen = await render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={file.size}
        file={file}
      />,
    );
    await toggleMode(screen, "Show HTML source");
    await vi.waitFor(() => expect(alert(screen)?.textContent).toContain("not UTF-8"));

    await toggleMode(screen, "Show rendered page");
    expect(alert(screen)).toBeNull();
    expect(screen.container.querySelector("iframe")?.title).toBe("document.html");
  });
});
