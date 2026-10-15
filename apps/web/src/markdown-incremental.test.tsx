import { chatMarkdownRehypePlugins, loadRehypeRaw } from "@t3tools/shared/markdownPipeline";
import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkCodexDirectives } from "@t3tools/shared/codexMarkdownDirectives";
import { remarkGithubAlerts } from "@t3tools/shared/markdownGithubAlerts";
import {
  createCachedMarkdownPlugin,
  createIncrementalMarkdownPlugin,
} from "./markdown-incremental";
import { remarkNormalizeListItemIndentation } from "@t3tools/shared/markdownListIndentation";

const CHAT_MARKDOWN_REHYPE_PLUGINS = chatMarkdownRehypePlugins(await loadRehypeRaw());

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
  it.each([
    "ordinary prose with 123, punctuation, and Unicode café 東京",
    "1. list\n\n    indented code\n\nwww.example.com &amp; user@example.com",
    "a | b\n--|--\na | b\n\n[ref]\n\n[ref]: /later",
  ])("keeps rendered output and positions for unfenced streaming %j", (source) => {
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it("reuses a parsed document across mounts without retaining mutated transforms", () => {
    const source = "> [!NOTE]\n> cached alert\n\n- a\n\n[link]: /target";
    const expected = render(source);
    expect(render(source, createCachedMarkdownPlugin())).toEqual(expected);
    const parsedSources: string[] = [];
    expect(render(source, createCachedMarkdownPlugin(), parsedSources)).toEqual(expected);
    expect(parsedSources).not.toContain(source);
    const edited = source + "\n\n[link]";
    expect(render(edited, createCachedMarkdownPlugin())).toEqual(render(edited));
    expect(render(source, createCachedMarkdownPlugin())).toEqual(expected);
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
