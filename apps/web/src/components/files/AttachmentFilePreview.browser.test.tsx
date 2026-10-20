import DocumentPages, { sanitizeDocumentHtml } from "./DocumentPages";
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

describe("document output sanitization", () => {
  it("fits saved HTML outputs to their content and resizes when the content changes", async () => {
    await using screen = await render(
      <DocumentPages html="<table><tr><td>42</td></tr></table>" name="Output" output />,
    );
    const frame = screen.container.querySelector("iframe")!;
    await vi.waitFor(() => {
      expect(frame.contentDocument?.querySelector("td")?.textContent).toBe("42");
      expect(frame.clientHeight).toBeGreaterThan(32);
      expect(frame.clientHeight).toBeLessThan(120);
    });
    const initialHeight = frame.clientHeight;
    await screen.rerender(
      <DocumentPages html={"<p>More saved output</p>".repeat(10)} name="Output" output />,
    );
    await vi.waitFor(() => {
      expect(frame.contentDocument?.querySelectorAll("p")).toHaveLength(10);
      expect(frame.clientHeight).toBeGreaterThan(initialHeight);
      expect(frame.contentDocument!.body.scrollHeight).toBeLessThanOrEqual(frame.clientHeight);
    });
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
