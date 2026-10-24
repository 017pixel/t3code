import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { HtmlRenderDialog } from "./HtmlRenderDialog";

vi.mock(import("../files/BrowserDocumentFrame"), async (original) => ({
  ...(await original()),
  HtmlRenderDocument: () => <div className="size-full" />,
}));

// Desktop on Windows and Linux paints native window controls over the top of the page.
it("keeps the close button below native window controls and the zoom bar on screen", async () => {
  await page.viewport(1280, 800);
  document.documentElement.style.setProperty("--native-titlebar-height", "52px");
  try {
    await using _screen = await render(
      <HtmlRenderDialog
        src="https://environment.test/page.html"
        title="Diagram"
        onClose={vi.fn()}
      />,
    );
    const close = page.getByRole("button", { name: "Close", exact: true });
    await expect.element(close).toBeVisible();
    const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
    expect(close.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(52);
    expect(zoomIn.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(800);
  } finally {
    document.documentElement.style.removeProperty("--native-titlebar-height");
  }
});
