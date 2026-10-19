import DocumentPages, { sanitizeDocumentHtml } from "./DocumentPages";
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
vi.mock(import("./ReadOnlySourcePreview"), async (original) => ({
  ...(await original()),
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

import { AttachmentFilePreview } from "./AttachmentFilePreview";

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";
  let now = 0;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openRemote = () =>
    act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
        />,
      ),
    );

  const toggleMode = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = () => container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    await openRemote();
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode("Show HTML source");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    await vi.waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );

    await toggleMode("Show rendered page");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode("Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(alert()?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode("Show rendered page");
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={file.size}
          file={file}
        />,
      ),
    );
    await toggleMode("Show HTML source");
    await vi.waitFor(() => expect(alert()?.textContent).toContain("not UTF-8"));

    await toggleMode("Show rendered page");
    expect(alert()).toBeNull();
    expect(container.querySelector("iframe")?.title).toBe("document.html");
  });
});

describe("document output sanitization", () => {
  it("fits saved HTML outputs to their content and resizes when the content changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <DocumentPages html="<table><tr><td>42</td></tr></table>" name="Output" output />,
        );
      });
      const frame = container.querySelector("iframe")!;
      await vi.waitFor(() => {
        expect(frame.contentDocument?.querySelector("td")?.textContent).toBe("42");
        expect(frame.clientHeight).toBeGreaterThan(32);
        expect(frame.clientHeight).toBeLessThan(120);
      });
      const initialHeight = frame.clientHeight;
      await act(async () => {
        root.render(
          <DocumentPages html={"<p>More saved output</p>".repeat(10)} name="Output" output />,
        );
      });
      await vi.waitFor(() => {
        expect(frame.contentDocument?.querySelectorAll("p")).toHaveLength(10);
        expect(frame.clientHeight).toBeGreaterThan(initialHeight);
        expect(frame.contentDocument!.body.scrollHeight).toBeLessThanOrEqual(frame.clientHeight);
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("preserves table content and raster data while removing scripts and network resources", () => {
    const html = sanitizeDocumentHtml(
      '<script>alert(1)</script><style>@import "https://example.com/style.css";</style><iframe src="https://example.com"></iframe><img src="https://example.com/tracker.png" onerror="alert(1)"><img src="data:image/png;base64,iVBORw0KGgo="><table><tr><td>Research</td></tr></table><a href="https://example.com">Results</a>',
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("td")?.textContent).toBe("Research");
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0]!.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(doc.querySelector("script,style,iframe,a,[onerror]")).toBeNull();
    expect(html).not.toContain("https://");
  });
});
