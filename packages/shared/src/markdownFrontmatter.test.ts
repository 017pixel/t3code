import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownFrontmatter } from "./markdownFrontmatter.ts";

function headingTexts(markdown: string): Array<string> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  return tree.children.flatMap((node: RootContent) => {
    if (node.type !== "heading") return [];
    return [node.children.map((child) => (child.type === "text" ? child.value : "")).join("")];
  });
}

const ISSUE_SOURCE = [
  "---",
  "type: Task",
  "title: Decide the joke source and Draft safety limits",
  "description: Settle where Jokes come from and what a Draft may never contain.",
  "status: draft",
  "task_status: ready",
  "blocked_by: []",
  "created: 2026-10-22",
  "---",
  "",
  "# Decide the joke source and Draft safety limits",
  "",
  "- [ ] Ship it",
  "",
  "---",
  "",
  "After the rule.",
  "",
].join("\n");

describe("splitMarkdownFrontmatter", () => {
  // regression: #23704 a closing frontmatter delimiter is a setext heading
  it("drops a leading YAML mapping so the preview starts at the real heading", () => {
    expect(headingTexts(ISSUE_SOURCE)[0]).toBe(
      [
        "type: Task",
        "title: Decide the joke source and Draft safety limits",
        "description: Settle where Jokes come from and what a Draft may never contain.",
        "status: draft",
        "task_status: ready",
        "blocked_by: []",
        "created: 2026-10-22",
      ].join("\n"),
    );

    const preview = splitMarkdownFrontmatter(ISSUE_SOURCE);
    // The blank line between the closing delimiter and the heading stays in the body.
    expect(preview.bodyOffset).toBe(ISSUE_SOURCE.indexOf("\n# Decide"));
    expect(ISSUE_SOURCE.slice(preview.bodyOffset)).toBe(preview.body);
    expect(headingTexts(preview.body)).toEqual(["Decide the joke source and Draft safety limits"]);
    expect(preview.body).toContain("\n---\n");
    const marker = preview.body.indexOf("[");
    expect(ISSUE_SOURCE[preview.bodyOffset + marker]).toBe("[");
    expect(ISSUE_SOURCE[preview.bodyOffset + marker + 1]).toBe(" ");
  });

  it("keeps Windows line endings and a duplicate key in the hidden block", () => {
    const markdown = "---\r\ntitle: a\r\ntitle: b\r\n---\r\n# Title\r\n";
    const preview = splitMarkdownFrontmatter(markdown);
    expect(preview).toEqual({ body: "# Title\r\n", bodyOffset: markdown.indexOf("# Title") });
  });

  it.each([
    ["a horizontal rule that is not frontmatter", "# Title\n\n---\n\nBody\n"],
    ["prose between rules", "---\nJust prose\n---\n# Title\n"],
    ["a list", "---\n- one\n---\n# Title\n"],
    ["an unclosed block", "---\ntitle: T\n# Title\n"],
    ["a blank line after the opener", "---\n\ntitle: T\n---\n# Title\n"],
    ["yaml that is not a mapping", "---\ntitle: T\nworld\n---\n# Title\n"],
  ])("leaves %s in the preview", (_label, markdown) => {
    expect(splitMarkdownFrontmatter(markdown)).toEqual({ body: markdown, bodyOffset: 0 });
  });
});
