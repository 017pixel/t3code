import { describe, expect, it } from "vite-plus/test";

import {
  inlineFilePreviewKind,
  INLINE_TABLE_MAX_BYTES,
  readInlineTable,
  isPdfFile,
} from "./filePreview";

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
    [{ name: "report.PDF", mimeType: "text/plain" }, "pdf"],
    [{ name: "report.csv" }, "table"],
    [{ name: "report.tsv" }, "table"],
    [{ name: "report", mimeType: "text/csv; charset=utf-8" }, "table"],
    [{ name: "report.csv", mimeType: "image/png" }, null],
    [{ name: "image.png" }, null],
    [{ name: "clip.mp4" }, null],
    [{ name: "file.zip" }, null],
  ])("classifies %j as %s", (file, expected) => {
    expect(inlineFilePreviewKind(file)).toBe(expected);
  });

  it("parses quoted CSV cells and caps the inline table at 5 rows and 3 columns", async () => {
    const response = new Response(
      'name,value,notes,hidden\n"first, row",1,"line one\nline two",x\nsecond,2,,,\nthird,3,,,\nfourth,4,,,\nfifth,5',
    );
    const rows = await readInlineTable(response, new AbortController().signal, ",");
    expect(rows).toEqual([
      ["name", "value", "notes"],
      ["first, row", "1", "line one\nline two"],
      ["second", "2", ""],
      ["third", "3", ""],
      ["fourth", "4", ""],
    ]);
  });

  it("parses TSV and empty files", async () => {
    expect(
      await readInlineTable(new Response("name\tvalue\na\t1"), new AbortController().signal, "\t"),
    ).toEqual([
      ["name", "value"],
      ["a", "1"],
    ]);
    expect(await readInlineTable(new Response(""), new AbortController().signal, ",")).toEqual([]);
  });

  it("cancels a server that ignores Range after the byte budget", async () => {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        chunks++;
        controller.enqueue(new TextEncoder().encode("a,b\n".repeat(INLINE_TABLE_MAX_BYTES / 4)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const rows = await readInlineTable({ ok: true, body }, new AbortController().signal, ",");
    expect(rows).toHaveLength(5);
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThanOrEqual(2);
  });

  it("aborts an in-flight read and releases its stream", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      cancel() {
        cancelled = true;
      },
    });
    const result = readInlineTable({ ok: true, body }, controller.signal, ",");
    controller.abort();
    await expect(result).rejects.toThrow("Preview cancelled");
    expect(cancelled).toBe(true);
  });

  it("rejects HTTP failures and binary files", async () => {
    await expect(
      readInlineTable(new Response("error", { status: 403 }), new AbortController().signal, ","),
    ).rejects.toThrow("Table unavailable");
    await expect(
      readInlineTable(new Response(new Uint8Array([0, 1])), new AbortController().signal, ","),
    ).rejects.toThrow("binary data");
  });
});
