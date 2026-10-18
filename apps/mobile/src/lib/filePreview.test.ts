import { describe, expect, it } from "vite-plus/test";

import { inlineFilePreviewKind, isPdfFile } from "./filePreview";

describe("PDF preview detection", () => {
  it.each([
    [{ name: "download", mimeType: "application/pdf" }, true],
    [{ name: "download", mimeType: "APPLICATION/PDF; charset=binary" }, true],
    [{ name: "Report.PDF", mimeType: "application/octet-stream" }, true],
    [{ name: "https://example.com/report.pdf?signature=abc#page=2" }, true],
    [{ name: "report.pdf", mimeType: "text/plain" }, false],
    [{ name: "report.pdf.exe" }, false],
    [{ name: "https://example.com/page?download=report.pdf" }, false],
  ])("classifies %j as %s", (file, expected) => {
    expect(isPdfFile(file)).toBe(expected);
  });
});

describe("inline file previews", () => {
  it.each([
    [{ name: "sound.MP3" }, "audio"],
    [{ name: "sound", mimeType: "audio/wav" }, "audio"],
    [{ name: "report.PDF", mimeType: "text/plain" }, null],
    [{ name: "report.csv" }, null],
    [{ name: "report.tsv" }, null],
    [{ name: "report", mimeType: "text/csv; charset=utf-8" }, null],
    [{ name: "report.csv", mimeType: "image/png" }, null],
    [{ name: "image.png" }, null],
    [{ name: "clip.mp4" }, null],
    [{ name: "file.zip" }, null],
    [{ name: "report.docx" }, null],
    [{ name: "report.xlsx" }, null],
    [{ name: "report.pptx" }, null],
    [{ name: "download", mimeType: "application/pdf" }, null],
    [{ name: "sound.mp3", mimeType: "application/pdf" }, null],
  ])("classifies %j as %s", (file, expected) => {
    expect(inlineFilePreviewKind(file)).toBe(expected);
  });
});
