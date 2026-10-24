import type { FileContents } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

// regression: #7907 Enter at the end of a long wrapped file jumped the viewport away from the caret
const contents = Array.from(
  { length: 999 },
  (_, index) =>
    `${String(index + 1).padStart(4, "0")} ${"wrapped editor sample text ".repeat(12).slice(0, 235)}`,
).join("\n");
const file: FileContents = { name: "wrapped.txt", contents, cacheKey: "wrapped", lang: "text" };

function viewport(container: HTMLElement) {
  const scroller = container.firstElementChild;
  if (!(scroller instanceof HTMLElement))
    throw new Error("Expected the virtualizer scroll container");
  return scroller;
}

function visibleLineIndexes(scroller: HTMLElement) {
  const bounds = scroller.getBoundingClientRect();
  const rows = scroller
    .querySelector("diffs-container")
    ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line][data-line-index]");
  return [...(rows ?? [])]
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    })
    .map((row) => Number(row.dataset.lineIndex));
}

describe("wrapped file editor", () => {
  it("keeps the caret line in view after Enter at the end of the file", async () => {
    const container = document.createElement("div");
    container.style.cssText = "display:flex;width:539px;height:708px";
    await using screen = await render(
      <EditProvider createEditor={(type, options, key) => new Editor(type, options, key)}>
        <Virtualizer
          style={{ flex: 1, minHeight: 0, overflow: "auto" }}
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={file}
            edit
            options={{ disableFileHeader: true, overflow: "wrap", theme: "pierre-dark" }}
          />
        </Virtualizer>
      </EditProvider>,
      { container, router: false },
    );
    const scroller = viewport(screen.container);
    await expect.poll(() => visibleLineIndexes(scroller).length).toBeGreaterThan(0);

    await userEvent.click(scroller);
    // The first jump settles short of the end once wrapped rows are measured.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await userEvent.keyboard("{Control>}{End}{/Control}");
      await expect.poll(() => visibleLineIndexes(scroller)).toContain(998);
    }

    await userEvent.keyboard("{Enter}");

    await expect.poll(() => visibleLineIndexes(scroller), { timeout: 3_000 }).toContain(999);
  });
});
