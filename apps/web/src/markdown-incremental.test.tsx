import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  chatMarkdownRemarkPlugins,
} from "@t3tools/shared/markdownPipeline";
import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkCodexDirectives } from "@t3tools/shared/codexMarkdownDirectives";
import { remarkGithubAlerts } from "@t3tools/shared/markdownGithubAlerts";
import { createIncrementalMarkdownPlugin } from "./markdown-incremental";
import { remarkNormalizeListItemIndentation } from "@t3tools/shared/markdownListIndentation";

function render(source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) {
  let tree: Root | undefined;
  const observeParsing: Plugin<[], Root> = function () {
    const original = this.parser;
    if (original) {
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    }
  };
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        capture,
        remarkGfm,
        remarkGithubAlerts,
        remarkNormalizeListItemIndentation,
        remarkCodexDirectives,
        ...(incremental ? [incremental] : []),
      ]}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {source}
    </ReactMarkdown>,
  );
  return { html, tree };
}

const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";

describe("incremental Markdown parsing", () => {
  it("preserves citation IDs and numbering across a cached closed fence", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const parse = (source: string, plugin?: Plugin<[], Root>) => {
      const processor = unified()
        .use(remarkParse)
        .use(chatMarkdownRemarkPlugins({ isStreaming: true }))
        .use(plugin ? [plugin] : [])
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
      return processor.runSync(processor.parse(source), { value: source });
    };
    type Node = { type: string; value?: string; children?: Node[] };
    const text = (node: Node): string => node.value ?? node.children?.map(text).join("") ?? "";
    const before = "Before \uE200cite\uE202turn0search1\uE201.\n\n```js\ncode\n```\n\n";
    const after =
      "After \uE200cite\uE202turn0search2\uE201, again \uE200cite\uE202turn0search1\uE201.";
    for (const [tail, expectedTail] of [
      ["After", "After"],
      [after, "After [Source 2: turn0search2], again [Source 1: turn0search1]."],
      [
        `${after} Also \uE200cite\uE202turn0search2\uE201.`,
        "After [Source 2: turn0search2], again [Source 1: turn0search1]. Also [Source 2: turn0search2].",
      ],
    ]) {
      const source = before + tail;
      const full = parse(source);
      const cached = parse(source, incremental);
      expect(text(full)).toBe(`Before [Source 1: turn0search1].\ncode\n\n${expectedTail}`);
      expect(text(cached)).toBe(text(full));
      expect(cached).toEqual(full);
    }
  });

  it("keeps the document prefix cached when list recovery parses contain fences", () => {
    const source =
      prefix +
      "-       first block\n\n        ```ts\n        const nested = 1;\n        ```\n\n        tail";
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    expect(render(source, incremental, parsedSources)).toEqual(render(source));
    parsedSources.length = 0;
    const next = source + " more";
    expect(render(next, incremental, parsedSources)).toEqual(render(next));
    expect(parsedSources).not.toContain(next);
    expect(parsedSources.some((text) => text.startsWith("t3-markdown-inline-prefix:"))).toBe(true);
  });

  it.each([
    "a\n===\n\nb\n---\n",
    "- first\n\n  continued\n\n- next\n",
    "> quoted\n>\n> ```js\n> abc\n> ```\n\nend",
    "<div>\nhello\n\n</div>\n\nend",
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "a | b\n--|--\na | b\n",
    "```\na\n```\n\nnext\n\n~~~\nb\n~~~\n\nmore",
    "\n\n\tcode\n\nmore",
    "text <https://example.com> *bold*",
    "> [!NOTE]\n> alert\n\n- [ ] task",
    "\uFEFFtext after a byte-order mark",
  ])("preserves the parse tree, positions, and HTML while streaming %j", (tail) => {
    const source = prefix + tail;
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each(["\r\n", "\r"])("preserves partial %j line endings", (newline) => {
    const source = (prefix + "next\n\n```\nlast\n```\n\nend").replaceAll("\n", newline);
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental)).toEqual(render(text));
    }
  });

  it("updates earlier references when definitions arrive after the cached prefix", () => {
    const before = "[later] and footnote[^note]\n\n" + prefix;
    const incremental = createIncrementalMarkdownPlugin();
    for (const tail of ["text", "[later]: /target", "[later]: /target\n\n[^note]: a note"]) {
      expect(render(before + tail, incremental)).toEqual(render(before + tail));
    }
  });

  it("handles edits, replacements, and repeated renders without leaking transformed nodes", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const documents = [
      prefix + "- first\n - second",
      prefix + "> [!NOTE]\n> transformed alert",
      prefix + "plain text",
      "replacement without fences",
      prefix.replace("Before", "Edited") + "edited prefix",
      prefix + "plain text",
      prefix + "plain text",
    ];
    for (const document of documents) {
      expect(render(document, incremental)).toEqual(render(document));
    }
  });

  it("does not freeze unclosed, nested, indented, or mismatched fences", () => {
    const prefixes = [
      "```\nopen\n\n",
      "````\n```\n\n",
      "> ```\n> code\n> ```\n\n",
      "- ```\n  code\n  ```\n\n",
      "    ```\n    code\n    ```\n\n",
      "<script>\n```\ncode\n```\n\n",
    ];
    for (const start of prefixes) {
      const incremental = createIncrementalMarkdownPlugin();
      for (const tail of ["", "text", "\n```\n", "\n```\n\nnext"]) {
        expect(render(start + tail, incremental)).toEqual(render(start + tail));
      }
    }
  });
});
