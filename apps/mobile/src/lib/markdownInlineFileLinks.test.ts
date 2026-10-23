import { describe, expect, it, vi } from "vite-plus/test";
import { unified } from "unified";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import {
  markdownForNativeRendering,
  markdownWithInlineFileLinks,
  parseMarkdownDocument,
} from "./markdownDocument";

const rewrite = (markdown: string) =>
  markdownWithInlineFileLinks(markdown, ENRICHED_INLINE_FILE_LINK_REGEX);

describe("inline code that names a file", () => {
  it("parses a streamed revision once for both file links and table breaks", () => {
    using parse = vi.spyOn(Object.getPrototypeOf(unified()) as ReturnType<typeof unified>, "parse");
    const markdown = "See `src/math.ts:2`\n| File |\n|---|\n| `./README.md` |";
    expect(markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX)).toBe(
      "See [src/math.ts:2](<src/math.ts:2>)\n\n| File |\n|---|\n| [./README.md](<./README.md>) |",
    );
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("keeps tables and file links exposed by HTML normalization", () => {
    using parse = vi.spyOn(Object.getPrototypeOf(unified()) as ReturnType<typeof unified>, "parse");
    expect(
      markdownForNativeRendering(
        "<details>\n<summary>Files</summary>\n\nSee `src/math.ts:2`\n| `./README.md` |\n|---|\n| ok |\n</details>",
        ENRICHED_INLINE_FILE_LINK_REGEX,
      ),
    ).toBe(
      "\n\n\n\n\n**Files**\n\n\n\nSee [src/math.ts:2](<src/math.ts:2>)\n\n| [./README.md](<./README.md>) |\n|---|\n| ok |\n\n\n",
    );
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("skips parsing ordinary streamed prose", () => {
    using parse = vi.spyOn(Object.getPrototypeOf(unified()) as ReturnType<typeof unified>, "parse");
    const markdown = "Streaming ordinary prose with `anIdentifier` and no rich blocks.";
    expect(markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX)).toBe(markdown);
    expect(parse).not.toHaveBeenCalled();
  });

  it("keeps file edits inside lazy table headers disjoint from container breaks", () => {
    for (const ending of ["\n", "\r\n", "\r"]) {
      expect(
        markdownForNativeRendering(
          ["> Intro", "`./README.md` | file", "> | - | - |", "> | ok | yes |"].join(ending),
          ENRICHED_INLINE_FILE_LINK_REGEX,
        ),
      ).toBe(
        [
          "> Intro",
          ">",
          "> [./README.md](<./README.md>) | file",
          "> | - | - |",
          "> | ok | yes |",
        ].join(ending),
      );
    }
  });

  it("becomes a link to the same path", () => {
    expect(rewrite("See `src/math.ts:2` and `./README.md`.")).toBe(
      "See [src/math.ts:2](<src/math.ts:2>) and [./README.md](<./README.md>).",
    );
  });

  it("keeps commands, identifiers and URLs as code", () => {
    const markdown = "Run `vp test run`, call `useMemo`, open `https://example.com/a.ts`.";
    expect(rewrite(markdown)).toBe(markdown);
  });

  it("leaves fenced code blocks and code already inside a link alone", () => {
    const markdown = "```\nsrc/math.ts:2\n```\n\n[`src/math.ts`](src/math.ts)";
    expect(rewrite(markdown)).toBe(markdown);
  });

  it("links to the exact path when it holds backslashes or ampersands", () => {
    for (const path of ["C:\\repo\\_private\\file.ts", "./src/a&copy;.ts", "./src/[id].ts"]) {
      const paragraph = parseMarkdownDocument(rewrite(`\`${path}\``)).children[0];
      const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
      expect(link?.type === "link" && link.url).toBe(path);
      expect(
        link?.type === "link" && link.children[0]?.type === "text" && link.children[0].value,
      ).toBe(path);
    }
  });
});
