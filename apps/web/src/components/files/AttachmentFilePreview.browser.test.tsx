import { act, render, stubGlobal, type Screen } from "../../../test/render";
import "~/index.css";
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
import LargeTextViewer from "./LargeTextViewer";
import VirtualTablePreview from "./VirtualTablePreview";
import JSZip from "jszip";
import { boundedZip } from "./boundedZip";
import BinaryViewer from "./BinaryViewer";
import { decodeImagePreview } from "./decodeImagePreview";

describe("bounded binary previews", () => {
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
      await vi.waitFor(() =>
        expect(screen.container.querySelectorAll("tbody button")).toHaveLength(2),
      );
      const buttons = [...screen.container.querySelectorAll<HTMLButtonElement>("tbody button")];
      expect(buttons.map((button) => button.textContent)).toEqual(["foo.txt", "foo.txt"]);
      await act(() => buttons[1]!.click());
      await vi.waitFor(() => expect(screen.container.textContent).toContain("root file"));
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
  it("rejects malformed UTF-8 bytes through the real text worker", async () => {
    const src = URL.createObjectURL(new Blob([new Uint8Array([0xe9, 10])]));
    try {
      await using screen = await render(
        <LargeTextViewer src={src} name="latin.txt" delimiter={null} />,
      );
      await vi.waitFor(() =>
        expect(screen.container.querySelector('[role="alert"]')).not.toBeNull(),
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
      await vi.waitFor(() => expect(screen.container.textContent).toContain("current-40"));
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
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain("This file contains binary data."),
    );
    await screen.rerender(<LargeTextViewer name="log.txt" text="" delimiter={null} />);
    await vi.waitFor(() => expect(screen.container.textContent).toContain("This file is empty."));
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
