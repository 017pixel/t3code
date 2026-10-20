import { act, render, stubGlobal, type Screen } from "../../../test/render";
import "~/index.css";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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
import LargeTextViewer from "./LargeTextViewer";
import VirtualTablePreview from "./VirtualTablePreview";
import { OfficeFilePreview } from "./OfficeFilePreview";
import { MermaidFilePreview } from "./MermaidFilePreview";
import JSZip from "jszip";
import { boundedZip } from "./boundedZip";
import BinaryViewer from "./BinaryViewer";
import { decodeImagePreview } from "./decodeImagePreview";
import type { BinaryWorkerResult } from "./binaryPreviewProtocol";

// Real worker imports and WASM initialization can exceed waitFor's default second
// when the full browser project runs concurrently on CI.
describe("bounded binary previews", () => {
  it("preserves length-delimited local and global PAX attributes", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const block = (name: string, content: Uint8Array, type = "0", size = content.length) => {
      const bytes = new Uint8Array(512 + Math.ceil(content.length / 512) * 512);
      const write = (offset: number, value: string) => bytes.set(encode(value), offset);
      write(0, name);
      write(124, size.toString(8).padStart(11, "0") + "\0");
      bytes.fill(32, 148, 156);
      write(156, type);
      write(
        148,
        bytes
          .subarray(0, 512)
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
      );
      bytes.set(content, 512);
      return bytes;
    };
    const attributes = (values: Record<string, string>) =>
      encode(
        Object.entries(values)
          .map(([key, value]) => {
            const payload = ` ${key}=${value}\n`;
            let record = `${encode(payload).length + 1}${payload}`;
            while (encode(record).length !== Number.parseInt(record, 10))
              record = `${encode(record).length}${payload}`;
            return record;
          })
          .join(""),
      );
    const chunks = [
      block("Global", attributes({ size: "5", mtime: "-86400" }), "g"),
      block("Local", attributes({ path: "café\n9 size=1\nname.txt" }), "x"),
      block("first.txt", encode("hello"), "0", 0),
      block("world.txt", encode("world"), "0", 0),
      block("Local", attributes({ size: "3", mtime: "-172800" }), "x"),
      block("short.txt", encode("bye"), "0", 0),
      block("again.txt", encode("again"), "0", 0),
      new Uint8Array(1024),
    ];
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const worker = new Worker(new URL("./binaryPreview.worker.ts", import.meta.url), {
      type: "module",
    });
    const request = (input: object) =>
      new Promise<BinaryWorkerResult>((resolve, reject) => {
        worker.addEventListener("message", (event) => resolve(event.data), { once: true });
        worker.addEventListener("error", reject, { once: true });
        worker.postMessage(input, []);
      });
    try {
      const result = await request({
        type: "open",
        kind: "archive",
        name: "pax.tar",
        bytes: bytes.buffer,
      });
      expect(result.type).toBe("archive");
      if (result.type !== "archive") throw new Error("Expected archive");
      expect(result.entries.map((entry) => [entry.path, entry.size, entry.modified])).toEqual([
        ["café\n9 size=1\nname.txt", 5, "1969-12-31T00:00:00.000Z"],
        ["world.txt", 5, "1969-12-31T00:00:00.000Z"],
        ["short.txt", 3, "1969-12-30T00:00:00.000Z"],
        ["again.txt", 5, "1969-12-31T00:00:00.000Z"],
      ]);
      const entry = await request({ type: "entry", path: "café\n9 size=1\nname.txt" });
      if (entry.type !== "entry") throw new Error("Expected entry");
      expect(new TextDecoder().decode(entry.bytes)).toBe("hello");
    } finally {
      worker.terminate();
    }
  });

  it("can leave an archive folder with a repeated separator", async () => {
    const bytes = new Uint8Array(2048);
    const write = (offset: number, value: string) =>
      bytes.set(new TextEncoder().encode(value), offset);
    write(0, "a//hello.txt");
    write(124, "00000000014\0");
    bytes.fill(32, 148, 156);
    write(156, "0");
    write(
      148,
      bytes
        .subarray(0, 512)
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
    );
    write(512, "nested hello");
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      await using screen = await render(<BinaryViewer src={src} name="paths.tar" kind="archive" />);
      const child = () => screen.container.querySelector<HTMLButtonElement>("tbody button");
      await vi.waitFor(() => expect(child()?.textContent).toBe("a"), 10_000);
      await act(() => child()!.click());
      await act(() => child()!.click());
      await vi.waitFor(() => expect(child()?.textContent).toBe("hello.txt"));
      const parent = () =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="Parent folder"]')!;
      await act(() => parent().click());
      await act(() => parent().click());
      expect(parent().disabled).toBe(true);
      expect(child()?.textContent).toBe("a");
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("uses a PAX size override for the following TAR payload and bounds it", async () => {
    const archive = (size: string) => {
      const header = (name: string, size: number, type: string) => {
        const bytes = new Uint8Array(512);
        const write = (offset: number, value: string) =>
          bytes.set(new TextEncoder().encode(value), offset);
        write(0, name);
        write(124, size.toString(8).padStart(11, "0") + "\0");
        bytes.fill(32, 148, 156);
        write(156, type);
        write(
          148,
          bytes
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, "0") + "\0 ",
        );
        return bytes;
      };
      const payload = ` size=${size}\n`;
      let record = `${payload.length + 1}${payload}`;
      while (record.length !== Number.parseInt(record, 10)) record = `${record.length}${payload}`;
      const bytes = new Uint8Array(3072);
      bytes.set(header("PaxHeader", record.length, "x"));
      bytes.set(new TextEncoder().encode(record), 512);
      bytes.set(header("hello.txt", 0, "0"), 1024);
      bytes.set(new TextEncoder().encode("hello"), 1536);
      return bytes;
    };
    for (const size of ["5", "999999999999999999999"]) {
      const src = URL.createObjectURL(new Blob([archive(size)]));
      try {
        await using screen = await render(<BinaryViewer src={src} name="pax.tar" kind="archive" />);
        if (size === "5") {
          await vi.waitFor(
            () =>
              expect(screen.container.querySelector("tbody button")?.textContent).toBe("hello.txt"),
            10_000,
          );
          await act(() =>
            screen.container.querySelector<HTMLButtonElement>("tbody button")!.click(),
          );
          await vi.waitFor(
            () => expect(screen.container.querySelector("pre")?.textContent).toBe("hello"),
            10_000,
          );
        } else {
          await vi.waitFor(
            () =>
              expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
                "too large or damaged",
              ),
            10_000,
          );
        }
      } finally {
        URL.revokeObjectURL(src);
      }
    }
  });

  it("shows stored and virtual generated SQLite columns", async () => {
    const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
      import("sql.js"),
      import("sql.js/dist/sql-wasm.wasm?url"),
    ]);
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const database = new SQL.Database();
    database.run(
      "CREATE TABLE sqliteData (price INTEGER, quantity INTEGER, total INTEGER GENERATED ALWAYS AS (price * quantity) STORED, doubled INTEGER GENERATED ALWAYS AS (price * 2) VIRTUAL); INSERT INTO sqliteData(price, quantity) VALUES (7, 3); CREATE TABLE zzInventory (stock INTEGER); INSERT INTO zzInventory VALUES(42)",
    );
    const src = URL.createObjectURL(new Blob([new Uint8Array(database.export())]));
    database.close();
    try {
      await using screen = await render(
        <BinaryViewer src={src} name="orders.sqlite" kind="sqlite" />,
      );
      await vi.waitFor(
        () =>
          expect([...screen.container.querySelectorAll("th")].map((x) => x.textContent)).toEqual([
            "price",
            "quantity",
            "total",
            "doubled",
          ]),
        10_000,
      );
      expect([...screen.container.querySelectorAll("td")].map((x) => x.textContent)).toEqual([
        "7",
        "3",
        "21",
        "14",
      ]);
      await act(() =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="Table"]')!.click(),
      );
      await page.getByRole("option", { name: "zzInventory (1 rows)" }).click();
      await vi.waitFor(() =>
        expect([...screen.container.querySelectorAll("td")].map((x) => x.textContent)).toEqual([
          "42",
        ]),
      );
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("reauthorizes a failed image when retry is clicked", async () => {
    const image =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
    refresh
      .mockReset()
      .mockResolvedValueOnce("data:image/png;base64,broken")
      .mockResolvedValue(image);
    await using screen = await render(
      <AttachmentFilePreview
        name="photo.png"
        mimeType="image/png"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "image" }}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Unable to load image.",
      ),
    );
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(image),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reads a small ZIP64 archive and rejects understated directory counts", async () => {
    const zip = new JSZip().file("readme.txt", "hello");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const end = bytes.length - 22;
    const legacy = new DataView(bytes.buffer);
    const extended = new Uint8Array(bytes.length + 76);
    extended.set(bytes.subarray(0, end));
    extended.set(bytes.subarray(end), end + 76);
    const view = new DataView(extended.buffer);
    view.setUint32(end, 0x06064b50, true);
    view.setBigUint64(end + 4, 44n, true);
    view.setBigUint64(end + 24, 1n, true);
    view.setBigUint64(end + 32, 1n, true);
    view.setBigUint64(end + 40, BigInt(legacy.getUint32(end + 12, true)), true);
    view.setBigUint64(end + 48, BigInt(legacy.getUint32(end + 16, true)), true);
    view.setUint32(end + 56, 0x07064b50, true);
    view.setBigUint64(end + 64, BigInt(end), true);
    view.setUint32(end + 72, 1, true);
    view.setUint16(end + 76 + 10, 0xffff, true);
    expect(
      new TextDecoder().decode((await boundedZip(extended.buffer)).get("readme.txt")?.bytes),
    ).toBe("hello");

    const redirected = new Uint8Array(extended.length + 56);
    redirected.set(extended.subarray(0, end + 56));
    redirected.set(extended.subarray(end + 56), end + 112);
    const redirect = new DataView(redirected.buffer);
    redirect.setUint32(end + 56, 0x06064b50, true);
    redirect.setBigUint64(end + 60, 44n, true);
    redirect.setBigUint64(end + 104, BigInt(end), true);
    await expect(boundedZip(redirected.buffer)).rejects.toThrow("Unsupported ZIP64 directory");

    const many = new JSZip();
    for (let i = 0; i < 2049; i++) many.file(`file-${i}`, "");
    const crowded = await many.generateAsync({ type: "arraybuffer" });
    new DataView(crowded).setUint16(crowded.byteLength - 12, 1, true);
    await expect(boundedZip(crowded)).rejects.toThrow("more than 2,048 entries");
  });

  it("keeps a file and directory with the same basename accessible", async () => {
    const bytes = await new JSZip()
      .file("foo.txt", "root file")
      .file("foo.txt/bar.txt", "child")
      .generateAsync({ type: "arraybuffer" });
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      await using screen = await render(<BinaryViewer src={src} name="names.zip" kind="archive" />);
      await vi.waitFor(
        () => expect(screen.container.querySelectorAll("tbody button")).toHaveLength(2),
        10_000,
      );
      const buttons = [...screen.container.querySelectorAll<HTMLButtonElement>("tbody button")];
      expect(buttons.map((button) => button.textContent)).toEqual(["foo.txt", "foo.txt"]);
      await act(() => buttons[1]!.click());
      await vi.waitFor(() => expect(screen.container.textContent).toContain("root file"), 10_000);
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("keeps WhiteIsZero TIFF brightness and rejects oversized metadata before decoding", async () => {
    const tags = [
      [256, 2],
      [257, 1],
      [258, 8],
      [259, 1],
      [262, 0],
      [273, 134],
      [277, 1],
      [278, 1],
      [279, 2],
      [284, 1],
    ];
    const bytes = new ArrayBuffer(136);
    const view = new DataView(bytes);
    view.setUint16(0, 0x4949);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, tags.length, true);
    tags.forEach(([tag, value], index) => {
      const offset = 10 + index * 12;
      view.setUint16(offset, tag!, true);
      view.setUint16(offset + 2, 4, true);
      view.setUint32(offset + 4, 1, true);
      view.setUint32(offset + 8, value!, true);
    });
    view.setUint8(135, 255);
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      const blob = await decodeImagePreview(src, false, new AbortController().signal);
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(2, 1);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      expect([...context.getImageData(0, 0, 2, 1).data]).toEqual([
        255, 255, 255, 255, 0, 0, 0, 255,
      ]);
      bitmap.close();
    } finally {
      URL.revokeObjectURL(src);
    }
    view.setUint32(14, 1_000_000, true);
    const invalid = URL.createObjectURL(new Blob([bytes]));
    try {
      await expect(
        decodeImagePreview(invalid, false, new AbortController().signal),
      ).rejects.toThrow("metadata");
    } finally {
      URL.revokeObjectURL(invalid);
    }
  });
});

describe("large text preview recovery", () => {
  it("scrolls within a wrapped row when the row-count track is shorter than the viewport", async () => {
    await using screen = await render(
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="one.txt"
          count={1}
          columns={1}
          source
          wrap
          getRows={() => [["wrapped source text ".repeat(500)]]}
        />
      </div>,
    );
    const row = () => screen.container.querySelector<HTMLElement>('[data-preview-row="0"]')!;
    const viewport = () => screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
    await vi.waitFor(() => expect(row()?.offsetHeight).toBeGreaterThan(1000));
    await act(() =>
      viewport().dispatchEvent(
        new WheelEvent("wheel", { deltaY: 150, bubbles: true, cancelable: true }),
      ),
    );
    await vi.waitFor(() => {
      const offset = viewport().getBoundingClientRect().top - row().getBoundingClientRect().top;
      expect(offset).toBeGreaterThan(50);
      expect(offset).toBeLessThan(300);
    });
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(
        Math.abs(row().getBoundingClientRect().bottom - viewport().getBoundingClientRect().bottom),
      ).toBeLessThan(2),
    );
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(row().getBoundingClientRect().top).toBe(viewport().getBoundingClientRect().top),
    );
  });

  it("scrolls every tall row in the final virtual viewport", async () => {
    await using screen = await render(
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="tail.txt"
          count={100}
          columns={1}
          source
          wrap
          getRows={(page) =>
            Array.from({ length: 32 }, (_, i) => [
              "line-" + (page * 32 + i + 1) + " wrapped source text".repeat(500),
            ])
          }
        />
      </div>,
    );
    const viewport = () => screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
    const row = (index: number) =>
      screen.container.querySelector<HTMLElement>('[data-preview-row="' + index + '"]')!;
    await vi.waitFor(() => expect(row(0)?.offsetHeight).toBeGreaterThan(1000));
    await act(() => {
      viewport().scrollTop = 100 * 29 - viewport().clientHeight;
      viewport().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const checkTop = (index: number) =>
      expect(
        Math.abs(row(index).getBoundingClientRect().top - viewport().getBoundingClientRect().top),
      ).toBeLessThan(2);
    await vi.waitFor(() => checkTop(87));
    for (let index = 88; index < 100; index++) {
      await act(() =>
        viewport().dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: row(index - 1).offsetHeight,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      if (index < 99) await vi.waitFor(() => checkTop(index));
    }
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(
        Math.abs(
          row(99).getBoundingClientRect().bottom - viewport().getBoundingClientRect().bottom,
        ),
      ).toBeLessThan(2),
    );
  });

  it("rejects malformed UTF-8 bytes through the real text worker", async () => {
    const src = URL.createObjectURL(new Blob([new Uint8Array([0xe9, 10])]));
    try {
      await using screen = await render(
        <LargeTextViewer src={src} name="latin.txt" delimiter={null} />,
      );
      await vi.waitFor(
        () => expect(screen.container.querySelector('[role="alert"]')).not.toBeNull(),
        10_000,
      );
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("replaces both prefetched pages with the worker's current file version", async () => {
    const old = Array.from({ length: 64 }, (_, i) => "old-" + i).join("\n") + "\n";
    const current = Array.from({ length: 100 }, (_, i) => "current-" + i).join("\n");
    const src = URL.createObjectURL(new Blob([current]));
    using _fetch = stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(old, {
          status: 206,
          headers: {
            "content-length": String(old.length),
            "content-range": "bytes 0-" + (old.length - 1) + "/100000",
          },
        }),
      ),
    );
    try {
      await using screen = await render(
        <div style={{ display: "flex", height: 2000, width: 600 }}>
          <LargeTextViewer src={src} name="log.txt" delimiter={null} />
        </div>,
      );
      await vi.waitFor(() => expect(screen.container.textContent).toContain("current-40"), 10_000);
      expect(screen.container.textContent).not.toContain("old-");
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("fills the horizontal viewport using measured column widths", async () => {
    const header = Array.from({ length: 20 }, (_, i) => "C" + i);
    await using screen = await render(
      <div style={{ display: "flex", height: 400, width: 400 }}>
        <VirtualTablePreview
          name="wide.csv"
          count={2}
          columns={20}
          header={header}
          getRows={() => [header, header]}
        />
      </div>,
    );
    const outer = () => screen.container.querySelector('[role="table"]')!.parentElement!;
    const check = () => {
      const cells = screen.container.querySelectorAll('[role="columnheader"]');
      expect(cells.length).toBeGreaterThan(0);
      expect(cells[cells.length - 1]!.getBoundingClientRect().right).toBeGreaterThanOrEqual(
        outer().getBoundingClientRect().right - 1,
      );
    };
    await vi.waitFor(check);
    await act(() => {
      outer().scrollLeft = outer().scrollWidth;
      outer().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await vi.waitFor(check);
    expect(screen.container.textContent).toContain("C19");
  });

  it("reveals and highlights requested source lines again for a new request", async () => {
    const view = (line: number, request: number) => (
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="log.txt"
          count={1000}
          columns={1}
          source
          wrap
          revealLine={line}
          revealRequestId={request}
          getRows={(page) =>
            Array.from({ length: 32 }, (_, i) => [
              "line-" + (page * 32 + i + 1) + " wrapped source text".repeat(20),
            ])
          }
        />
      </div>
    );
    await using screen = await render(view(500, 1));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-preview-reveal="true"]')?.textContent).toContain(
        "line-500",
      ),
    );
    const checkVisible = () => {
      const row = screen.container.querySelector<HTMLElement>('[data-preview-reveal="true"]')!;
      const viewport = screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
      expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        viewport.getBoundingClientRect().top - 1,
      );
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        viewport.getBoundingClientRect().bottom + 1,
      );
    };
    await vi.waitFor(checkVisible);
    await screen.rerender(view(900, 2));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-preview-reveal="true"]')?.textContent).toContain(
        "line-900",
      ),
    );
    await vi.waitFor(checkVisible);
    await screen.rerender(view(999, 3));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-preview-reveal="true"]')?.textContent).toContain(
        "line-999",
      ),
    );
    await vi.waitFor(checkVisible);
  });

  it("recovers from a failed worker load when its source changes", async () => {
    await using screen = await render(
      <LargeTextViewer name="log.txt" text={"bad\0text"} delimiter={null} />,
    );
    await vi.waitFor(
      () => expect(screen.container.textContent).toContain("This file contains binary data."),
      10_000,
    );
    await screen.rerender(<LargeTextViewer name="log.txt" text="" delimiter={null} />);
    await vi.waitFor(
      () => expect(screen.container.textContent).toContain("This file is empty."),
      10_000,
    );
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reloads a partial page when the indexed row count grows", async () => {
    const load = vi.fn();
    const rows = [["first"]];
    const view = (count: number) => (
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="log.txt"
          count={count}
          columns={1}
          source
          getRows={() => rows}
          loadPage={load}
        />
      </div>
    );
    await using screen = await render(view(1));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("first"));
    expect(load).not.toHaveBeenCalled();
    await screen.rerender(view(2));
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith(0));
  });
});
it.each(["paragraphs", "runs", "tables", "auxiliary XML", "XML bytes", "renamed XML"])(
  "rejects excessive Word %s in the worker before rendering DOM",
  async (scenario) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    const body =
      scenario === "paragraphs"
        ? "<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(200_000)
        : scenario === "runs"
          ? `<w:p>${"<w:r><w:t>x</w:t></w:r>".repeat(50_001)}</w:p>`
          : scenario === "tables"
            ? "<w:tbl/>".repeat(50_001)
            : scenario === "XML bytes"
              ? `<w:p><w:r><w:t>${"x".repeat(2 * 1024 * 1024)}</w:t></w:r></w:p>`
              : "<w:p/>";
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    );
    if (scenario === "auxiliary XML" || scenario === "renamed XML")
      archive.file(
        scenario === "renamed XML" ? "word/footnotes.dat" : "word/footnotes.xml",
        `<w:footnotes>${"<w:p/>".repeat(50_001)}</w:footnotes>`,
      );
    const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
    const src = URL.createObjectURL(file);
    try {
      await using screen = await render(
        <OfficeFilePreview src={src} name="large.docx" kind="docx" sizeBytes={file.size} />,
      );
      await vi.waitFor(
        () =>
          expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
            "Preview limited",
          ),
        { timeout: 10_000 },
      );
      expect(screen.container.querySelector("iframe")).toBeNull();
    } finally {
      URL.revokeObjectURL(src);
    }
  },
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

it("opens a known empty attachment even when its range response is inaccessible", async () => {
  refresh.mockResolvedValue("https://unreachable.invalid/empty.txt");
  await using screen = await render(
    <AttachmentFilePreview
      name="empty.txt"
      mimeType="text/plain"
      sizeBytes={0}
      asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "empty" }}
    />,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("This file is empty."));
});

it.each(["draft", "thread"] as const)(
  "reads an unknown-size %s workspace file instead of treating it as empty",
  async (source) => {
    refresh.mockResolvedValue("https://example.test/binary.txt");
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid\0text")),
    );
    await using screen = await render(
      <AttachmentFilePreview
        name="binary.txt"
        mimeType="application/octet-stream"
        sizeBytes={0}
        asset={{
          environmentId: EnvironmentId.make("test"),
          resource:
            source === "draft"
              ? { _tag: "draft-workspace-file", cwd: "/repo", path: "/repo/binary.txt" }
              : { _tag: "media-file", threadId: ThreadId.make("test"), path: "/repo/binary.txt" },
        }}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain(
        "This file contains binary data and cannot be shown as text.",
      ),
    );
    expect(fetch).toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain("This file is empty.");
  },
);

it("refreshes authorization and retries a failed streamed attachment", async () => {
  const bad = URL.createObjectURL(new Blob(["invalid\0text"]));
  const good = URL.createObjectURL(new Blob(["recovered text\n"]));
  refresh.mockReset().mockResolvedValueOnce(bad).mockResolvedValue(good);
  try {
    await using screen = await render(
      <AttachmentFilePreview
        name="retry.txt"
        mimeType="text/plain"
        sizeBytes={2_000_000}
        asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "retry" }}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain("This file contains binary data."),
    );
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await vi.waitFor(() => expect(screen.container.textContent).toContain("recovered text"));
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    URL.revokeObjectURL(bad);
    URL.revokeObjectURL(good);
  }
});

it.each([
  ["custom/sheet1.xml", 250001],
  ["/xl/custom/sheet1.bin", 250001],
  ["custom/valid.xml", 1],
] as const)(
  "bounds the worksheet relationship target %s at row %i before the reader allocates its grid",
  async (target, row) => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/></Relationships>`,
    );
    zip.file(
      target.startsWith("/") ? target.slice(1) : `xl/${target}`,
      `<worksheet><sheetData><row r="${row}"><c r="A${row}" t="inlineStr"><is><t>worksheet value</t></is></c></row></sheetData></worksheet>`,
    );
    const file = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const src = URL.createObjectURL(file);
    try {
      await using screen = await render(
        <div style={{ display: "flex", height: 400, width: 600 }}>
          <OfficeFilePreview name="custom.xlsx" src={src} kind="xlsx" sizeBytes={file.size} />
        </div>,
      );
      await vi.waitFor(
        () =>
          expect(screen.container.textContent).toContain(
            row > 250000 ? "This workbook exceeds the preview limit" : "worksheet value",
          ),
        { timeout: 10_000 },
      );
    } finally {
      URL.revokeObjectURL(src);
    }
  },
);

it("copies every indexed line rather than the mounted preview rows", async () => {
  const text = Array.from({ length: 10_000 }, (_, i) => `line-${i}`).join("\n");
  const copyContents = { current: null as (() => Promise<string>) | null };
  await using screen = await render(
    <LargeTextViewer name="whole.txt" text={text} delimiter={null} copyContents={copyContents} />,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("line-0"));
  await vi.waitFor(async () => expect(await copyContents.current!()).toBe(text));
});

it.each(["archive", "sqlite"] as const)(
  "reauthorizes and retries a failed %s attachment",
  async (kind) => {
    const bad = URL.createObjectURL(new Blob(["invalid"]));
    let bytes: Uint8Array<ArrayBuffer>;
    if (kind === "archive")
      bytes = new Uint8Array(
        await new JSZip().file("recovered.txt", "ok").generateAsync({ type: "uint8array" }),
      );
    else {
      const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
        import("sql.js"),
        import("sql.js/dist/sql-wasm.wasm?url"),
      ]);
      const SQL = await initSqlJs({ locateFile: () => wasmUrl });
      const database = new SQL.Database();
      database.run(
        "CREATE TABLE recovered (value TEXT); INSERT INTO recovered VALUES('retry succeeded')",
      );
      bytes = new Uint8Array(database.export());
      database.close();
    }
    const good = URL.createObjectURL(new Blob([bytes]));
    refresh.mockReset().mockResolvedValueOnce(bad).mockResolvedValue(good);
    try {
      await using screen = await render(
        <AttachmentFilePreview
          name={kind === "archive" ? "retry.zip" : "retry.sqlite"}
          mimeType="application/octet-stream"
          sizeBytes={bytes.length}
          asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "retry" }}
        />,
      );
      await vi.waitFor(
        () => expect(screen.container.querySelector('[role="alert"] button')).not.toBeNull(),
        10_000,
      );
      await act(() =>
        screen.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
      );
      await vi.waitFor(
        () =>
          expect(screen.container.textContent).toContain(
            kind === "archive" ? "recovered.txt" : "retry succeeded",
          ),
        10_000,
      );
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      URL.revokeObjectURL(bad);
      URL.revokeObjectURL(good);
    }
  },
);
