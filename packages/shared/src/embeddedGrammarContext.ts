const SCRIPT_CONTEXT = '<script lang="ts">\n';
const STYLE_CONTEXT = "<style>\n";
// A style hunk that closes a rule before opening one starts among that rule's declarations.
const STYLE_RULE_CONTEXT = "<style>\n* {\n";
const MAX_CONTEXT_LINES = 360;
const MAX_CONTEXT_CHARACTERS = 8_000;
const CLOSING_SCRIPT = /^\s*<\/script\s*>/i;
const CLOSING_STYLE = /^\s*<\/style\s*>/i;
const MARKUP = /^\s*(?:<[A-Za-z!/]|\{[#:/@])/;
const BRACE = /[{}]/;
const SCRIPT_STATEMENT =
  /^\s*(?:(?:import|export)\b|(?:const|let|var|function|class|interface|type|enum)\s+[$\w])/;
// Semicolons distinguish declarations from ordinary object properties. A bare JS label with
// the same syntax is inherently ambiguous without the missing file context.
const CSS_DECLARATION = /^\s*(?:--[\w-]+|[a-z][\w-]*)\s*:[^;{}]+;\s*$/i;

/**
 * Partial hunks lack the preceding grammar state. Infer an opener from bounded local evidence;
 * ambiguous hunks retain Svelte's top-level markup state.
 */
export function inferEmbeddedGrammarContext(
  language: string,
  firstLineNumber: number,
  lines: Iterable<string>,
) {
  if (language !== "svelte" || firstLineNumber <= 1) return undefined;
  let firstBrace: string | undefined;
  let inferredContext: string | undefined;
  let lineCount = 0;
  let charactersRemaining = MAX_CONTEXT_CHARACTERS;
  for (const line of lines) {
    if (line.length + 1 > charactersRemaining) break;
    charactersRemaining -= line.length + 1;
    if (CLOSING_SCRIPT.test(line)) return SCRIPT_CONTEXT;
    if (CLOSING_STYLE.test(line)) return firstBrace === "}" ? STYLE_RULE_CONTEXT : STYLE_CONTEXT;
    if (MARKUP.test(line)) return undefined;
    firstBrace ??= BRACE.exec(line)?.[0];
    if (SCRIPT_STATEMENT.test(line)) inferredContext ??= SCRIPT_CONTEXT;
    if (CSS_DECLARATION.test(line)) {
      inferredContext ??= firstBrace === "{" ? STYLE_CONTEXT : STYLE_RULE_CONTEXT;
    }
    lineCount += 1;
    if (lineCount === MAX_CONTEXT_LINES) break;
  }
  return inferredContext;
}
