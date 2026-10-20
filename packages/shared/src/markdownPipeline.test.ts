import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { renderCodexCitationsAsMarkdown } from "./codexCitations.ts";
import { parseMarkdownWithMath } from "./markdownMath.ts";
import { searchableMessageSegments } from "./threadFindText.ts";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

it("preserves in-app thread links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      '[Open thread](t3-thread://v1/environment/thread)\n\n<a href="javascript:alert(1)">Unsafe</a>',
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v1/environment/thread" },
        children: [{ type: "text", value: "Open thread" }],
      },
    ],
  });
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

it("keeps backslashes that CommonMark would read as escapes in prose Windows paths", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const text = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "code"
        ? `<code>${(node.children ?? []).map(text).join("")}</code>`
        : (node.children ?? []).map(text).join("");
  const render = (markdown: string) => text(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`),
  ).toBe(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`);
  // Paths render as written, so one an agent already escaped keeps its doubled backslashes.
  expect(render(String.raw`Escaped C:\\Users\\me`)).toBe(String.raw`Escaped C:\\Users\\me`);
  expect(render(String.raw`See C:\x and \*this\* and Note:\*that\*.`)).toBe(
    String.raw`See C:\x and *this* and Note:*that*.`,
  );
  expect(render(String.raw`${"`"}C:\me\.t3${"`"} and C:\me\.t3`)).toBe(
    String.raw`<code>C:\me\.t3</code> and C:\me\.t3`,
  );
});

type MarkdownNode = { type: string; value?: string; tagName?: string; children?: MarkdownNode[] };

function markdownText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(markdownText).join("") ?? "";
}

it("renders stable source numbers, grouped locators and opaque IDs through both shared pipelines", () => {
  const markdown =
    "First \uE200cite\uE202turn0view0\uE201. " +
    "Grouped \uE200cite\uE202__opaque_id__\uE202turn0view0\uE202__opaque_id__\uE202L8-L13\uE201. " +
    "Sole \uE200cite\uE202L42\uE201\uE200cite\uE202L42\uE202L9\uE201.";
  const expected =
    "First [Source 1: turn0view0]. " +
    "Grouped [Source 2: __opaque_id__; Source 1: turn0view0; L8-L13]. " +
    "Sole [Source 3: L42][Source 3: L42; L9].";
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(processor.parse(markdown), { value: markdown });
  expect(markdownText(tree)).toBe(expected);
  expect(JSON.stringify(tree)).not.toContain('"href"');

  const copiedTree = parseMarkdownWithMath(renderCodexCitationsAsMarkdown(markdown));
  expect(copiedTree.children).toMatchObject([
    { type: "paragraph", children: [{ type: "text", value: expected }] },
  ]);

  const withBreaks = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  expect(markdownText(withBreaks.runSync(withBreaks.parse(markdown), { value: markdown }))).toBe(
    expected,
  );

  const nextMessage = "\uE200cite\uE202L42\uE201";
  expect(
    markdownText(processor.runSync(processor.parse(nextMessage), { value: nextMessage })),
  ).toBe("[Source 1: L42]");
  expect(
    searchableMessageSegments({ role: "assistant", text: markdown, streaming: false }),
  ).toEqual([expected]);
});

it("keeps citation examples literal without numbering them or suppressing later prose", () => {
  const example = "\uE200cite\uE202excluded\uE201";
  const unsupported = "\uE200image\uE202turn0view0\uE201";
  const malformed = "\uE200cite\uE202two words\uE201";
  const markdown = [
    `Inline \`${example}\`, [link ${example}](https://example.com), <code>${example}</code>.`,
    "",
    "```md",
    example,
    "```",
    "",
    `${unsupported} ${malformed} Actual \uE200cite\uE202turn0view0\uE201.`,
  ].join("\n");
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  expect(markdownText(processor.runSync(processor.parse(markdown), { value: markdown }))).toBe(
    `Inline ${example}, link ${example}, ${example}.\n${example}\n\n` +
      `${unsupported} ${malformed} Actual [Source 1: turn0view0].`,
  );
});
