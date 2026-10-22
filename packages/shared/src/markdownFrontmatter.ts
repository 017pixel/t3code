import { parse as parseYaml } from "yaml";

// A blank line after the opening delimiter is a thematic break followed by its
// own blocks. Eating that span would hide a real heading that YAML reads as a
// comment. Skill files use the same `---` delimiters, with the first key on the
// next line.
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function isYamlMapping(source: string): boolean {
  try {
    // Duplicate keys are still metadata; the preview only needs the shape.
    const parsed = parseYaml(source, { uniqueKeys: false });
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Split a leading YAML mapping off markdown a file preview will render. The
 * closing `---` would otherwise underline that mapping as a setext heading. A
 * `---` that is not a mapping stays in the text.
 */
export function splitMarkdownFrontmatter(markdown: string) {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  const source = match?.[1];
  if (match === null || source === undefined || /^\r?\n/.test(source) || !isYamlMapping(source)) {
    return { body: markdown, bodyOffset: 0 };
  }
  return { body: markdown.slice(match[0].length), bodyOffset: match[0].length };
}
