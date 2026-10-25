import { describe, expect, it } from "vite-plus/test";

import { followFileTreeSelection, toggleFileTreeDirectory } from "./fileTreeExpansion";

describe("followFileTreeSelection", () => {
  it("expands the selected file's ancestors", () => {
    const next = followFileTreeSelection(null, "scope", "src/lib/a.ts");
    expect([...next.expanded]).toEqual(["src", "src/lib"]);
  });

  it("keeps a collapsed ancestor collapsed until the selection changes", () => {
    const selected = followFileTreeSelection(null, "scope", "src/lib/a.ts");
    const collapsed = toggleFileTreeDirectory(selected, "src/lib");
    expect(followFileTreeSelection(collapsed, "scope", "src/lib/a.ts")).toBe(collapsed);
    expect([...followFileTreeSelection(collapsed, "scope", "src/lib/b.ts").expanded]).toEqual([
      "src",
      "src/lib",
    ]);
  });

  it("keeps earlier expansions when the selection moves", () => {
    const first = followFileTreeSelection(null, "scope", "docs/guide/a.md");
    const next = followFileTreeSelection(first, "scope", "src/a.ts");
    expect([...next.expanded].sort()).toEqual(["docs", "docs/guide", "src"]);
  });

  it("starts collapsed for a new scope", () => {
    const first = followFileTreeSelection(null, "one", "src/a.ts");
    expect([...followFileTreeSelection(first, "two", null).expanded]).toEqual([]);
  });
});
