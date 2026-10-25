import type { CodeViewScrollTarget } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { createCodeViewFileReveal } from "./useCodeViewFileReveal";

function viewer(initialItems: ReadonlyArray<string>) {
  const items = new Set(initialItems);
  const scrolls: CodeViewScrollTarget[] = [];
  return {
    items,
    scrolls,
    getInstance: () => ({}),
    getItem: (id: string) => (items.has(id) ? {} : undefined),
    scrollTo: (target: CodeViewScrollTarget) => scrolls.push(target),
  };
}

describe("createCodeViewFileReveal", () => {
  it("scrolls at once to a file the viewer holds", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer(["a"]);

    reveal.request(view, "a");

    expect(view.scrolls).toEqual([{ type: "item", id: "a", align: "start" }]);
  });

  it("keeps a missing file pending until a flush finds it, then drops it", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer([]);

    reveal.request(view, "a");
    reveal.flush(view);
    expect(view.scrolls).toEqual([]);

    view.items.add("a");
    reveal.flush(view);
    reveal.flush(view);
    expect(view.scrolls).toHaveLength(1);
  });

  it("drops a pending reveal when another viewer replaces the one it was asked of", () => {
    const reveal = createCodeViewFileReveal();
    const first = viewer([]);
    const second = viewer(["a"]);

    reveal.request(first, "a");
    reveal.flush(second);

    expect(second.scrolls).toEqual([]);
  });
});
