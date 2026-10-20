import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as reviewHighlighter from "../review/shikiReviewHighlighter";
import { buildNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import { highlightNativeReviewDiffVisibleRows } from "./nativeReviewDiffHighlighter";

const tokenization = vi.hoisted(() => ({
  calls: [] as string[],
  contextCharacters: [] as number[],
  afterCall: undefined as (() => void) | undefined,
}));

vi.mock("@shikijs/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shikijs/core")>();
  return {
    ...original,
    createHighlighterCore: async (...args: Parameters<typeof original.createHighlighterCore>) => {
      const highlighter = await original.createHighlighterCore(...args);
      return {
        ...highlighter,
        codeToTokensBase: (...input: Parameters<typeof highlighter.codeToTokensBase>) => {
          tokenization.calls.push(input[0]);
          tokenization.contextCharacters.push(input[1].grammarContextCode?.length ?? 0);
          const result = highlighter.codeToTokensBase(...input);
          tokenization.afterCall?.();
          return result;
        },
      };
    },
  };
});

vi.mock("react-native-shiki-engine", async () => {
  const { createJavaScriptRegexEngine } = await import("@shikijs/engine-javascript");
  return { isNativeEngineAvailable: () => true, createNativeEngine: createJavaScriptRegexEngine };
});

afterEach(() => {
  tokenization.calls = [];
  tokenization.contextCharacters = [];
  tokenization.afterCall = undefined;
});

const TYPESCRIPT_FILE: NativeReviewDiffFile = {
  id: "file-1",
  path: "example.ts",
  language: "typescript",
  additions: 0,
  deletions: 0,
};

function makeLine(
  input: Pick<NativeReviewDiffRow, "id" | "content" | "change" | "oldLineNumber" | "newLineNumber">,
): NativeReviewDiffRow {
  return {
    kind: "line",
    fileId: TYPESCRIPT_FILE.id,
    ...input,
  };
}

function makeHunk(id: string): NativeReviewDiffRow {
  return {
    kind: "hunk",
    id,
    fileId: TYPESCRIPT_FILE.id,
    text: "@@",
  };
}

function highlight(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  alreadyHighlightedRowIds?: ReadonlySet<string>,
) {
  return highlightNativeReviewDiffVisibleRows({
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark",
    engine: "javascript",
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
    maxRows: 100,
    alreadyHighlightedRowIds,
  });
}

async function highlightSveltePatch(patch: string) {
  const { rows, files } = buildNativeReviewDiffData(buildReviewParsedDiff(patch, "svelte"));
  const result = await highlightNativeReviewDiffVisibleRows({
    rows,
    files,
    scheme: "dark",
    engine: "javascript",
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
  });
  return rows
    .filter((row) => row.kind === "line")
    .map((row) => ({
      content: row.content,
      tokens: result.tokensByRowId[row.id],
    }));
}

function fullSveltePatch(lines: readonly string[]) {
  return [
    "diff --git a/App.svelte b/App.svelte",
    "--- /dev/null",
    "+++ b/App.svelte",
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

describe("highlightNativeReviewDiffVisibleRows", () => {
  it("does not carry grammar state across hunk boundaries", async () => {
    const exportRow = makeLine({
      id: "export-row",
      content: "export async function run() {}",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 100,
    });
    const rows = [
      makeHunk("hunk-1"),
      makeLine({
        id: "import-open",
        content: "import {",
        change: "context",
        oldLineNumber: 1,
        newLineNumber: 1,
      }),
      makeLine({
        id: "import-entry",
        content: "  Model,",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 2,
      }),
      makeHunk("hunk-2"),
      exportRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([makeHunk("standalone-hunk"), exportRow]),
    ]);

    expect(highlighted.tokensByRowId[exportRow.id]).toEqual(standalone.tokensByRowId[exportRow.id]);
  });

  it("keeps grammar state across inline comment rows", async () => {
    const openingRow = makeLine({
      id: "template-open",
      content: "const message = `open",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const closingRow = makeLine({
      id: "template-close",
      content: "closed`;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 2,
    });
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const commentRow: NativeReviewDiffRow = {
      kind: "comment",
      id: "comment-1",
      fileId: TYPESCRIPT_FILE.id,
      commentText: "Review note",
    };

    const [withComment, contiguous] = await Promise.all([
      highlight([openingRow, commentRow, closingRow, trailingRow]),
      highlight([openingRow, closingRow, trailingRow]),
    ]);

    expect(withComment.tokensByRowId).toEqual(contiguous.tokensByRowId);
  });

  it("does not join unhighlighted rows across cached gaps", async () => {
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const rows = [
      makeLine({
        id: "template-open",
        content: "const message = `open",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
      }),
      makeLine({
        id: "template-close",
        content: "closed`;",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
      }),
      trailingRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows, new Set(["template-close"])),
      highlight([trailingRow]),
    ]);

    expect(highlighted.tokensByRowId[trailingRow.id]).toEqual(
      standalone.tokensByRowId[trailingRow.id],
    );
  });

  it("keeps deletion grammar state out of addition rows", async () => {
    const additionRow = makeLine({
      id: "addition-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const rows = [
      makeLine({
        id: "deletion-row",
        content: "const removed = `open",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
      }),
      additionRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([additionRow]),
    ]);

    expect(highlighted.tokensByRowId[additionRow.id]).toEqual(
      standalone.tokensByRowId[additionRow.id],
    );
  });

  it("renders partial Svelte script, style and markup like full-file syntax on both sides", async () => {
    const actual = await highlightSveltePatch(
      [
        "diff --git a/App.svelte b/App.svelte",
        "--- a/App.svelte",
        "+++ b/App.svelte",
        "@@ -5,3 +5,3 @@",
        "   let count = $state(0);",
        "-  count = 1;",
        "+  count = 2;",
        "   console.log(count);",
        "@@ -20,3 +20,3 @@",
        " <main>",
        "-  <p>{label}</p>",
        '+  <p class="label">{label}</p>',
        " </main>",
        "@@ -40,4 +40,4 @@",
        "     display: grid;",
        "-    color: red;",
        "+    color: blue;",
        "   }",
        " </style>",
        "@@ -60,5 +60,3 @@",
        " export const prerender = true;",
        " </script>",
        "-<script>",
        "-  const removed = 1;",
        "-</script>",
        '+<div class="x">hi</div>',
      ].join("\n"),
    );
    const expected = await highlightSveltePatch(
      fullSveltePatch([
        '<script lang="ts">',
        "  let count = $state(0);",
        "  count = 1;",
        "  count = 2;",
        "  console.log(count);",
        "export const prerender = true;",
        "</script>",
        "<main>",
        "  <p>{label}</p>",
        '  <p class="label">{label}</p>',
        "</main>",
        "<style>",
        "  p {",
        "    display: grid;",
        "    color: red;",
        "    color: blue;",
        "  }",
        "</style>",
        '<div class="x">hi</div>',
      ]),
    );
    for (const content of [
      "  let count = $state(0);",
      "  count = 1;",
      "  count = 2;",
      "  console.log(count);",
      "  <p>{label}</p>",
      '  <p class="label">{label}</p>',
      "    display: grid;",
      "    color: red;",
      "    color: blue;",
      '<div class="x">hi</div>',
    ]) {
      const matching = actual.filter((line) => line.content === content);
      expect(matching.length, content).toBeGreaterThan(0);
      const reference = expected.find((line) => line.content === content)!;
      for (const line of matching) expect.soft(line.tokens, content).toEqual(reference.tokens);
    }
    tokenization.contextCharacters = [];
    const manyEdits = await highlightSveltePatch(
      [
        "diff --git a/App.svelte b/App.svelte",
        "--- a/App.svelte",
        "+++ b/App.svelte",
        "@@ -20,200 +20,200 @@",
        ...Array.from({ length: 100 }, (_, index) => [
          `   const value${index} = compute(${index});`,
          `-  total += value${index};`,
          `+  total += value${index} * 2;`,
        ]).flat(),
      ].join("\n"),
    );
    expect(manyEdits).toHaveLength(300);
    expect(
      manyEdits.every(
        (line) => line.tokens?.map((token) => token.content).join("") === line.content,
      ),
    ).toBe(true);
    expect(tokenization.contextCharacters.some((length) => length > 0)).toBe(true);
    expect(
      tokenization.contextCharacters.reduce((total, length) => total + length, 0),
    ).toBeLessThanOrEqual(8_000);
  });
  it("uses CSS evidence, keeps ambiguous text plain, and resumes markup after a long line", async () => {
    const actual = await highlightSveltePatch(
      [
        "diff --git a/App.svelte b/App.svelte",
        "--- a/App.svelte",
        "+++ b/App.svelte",
        "@@ -40,2 +40,2 @@",
        "     display: grid;",
        "-    color: red;",
        "+    color: blue;",
        "@@ -70 +70 @@",
        "-Welcome to version 1",
        "+Welcome to version 2",
      ].join("\n"),
    );
    const expected = await highlightSveltePatch(
      fullSveltePatch([
        "<style>",
        "  p {",
        "    display: grid;",
        "    color: red;",
        "    color: blue;",
        "  }",
        "</style>",
        "<main>",
        "Welcome to version 1",
        "Welcome to version 2",
        "</main>",
      ]),
    );
    for (const content of [
      "    display: grid;",
      "    color: red;",
      "    color: blue;",
      "Welcome to version 1",
      "Welcome to version 2",
    ]) {
      const matching = actual.filter((line) => line.content === content);
      expect(matching.length, content).toBeGreaterThan(0);
      const reference = expected.find((line) => line.content === content)!;
      for (const line of matching) expect.soft(line.tokens, content).toEqual(reference.tokens);
    }
    const longLine = "x".repeat(1_001);
    const spanning = await highlightSveltePatch(
      [
        "diff --git a/App.svelte b/App.svelte",
        "--- a/App.svelte",
        "+++ b/App.svelte",
        "@@ -4,4 +4,4 @@",
        "   let count = 0;",
        " </script>",
        ` ${longLine}`,
        "-Welcome to version 1",
        "+Welcome to version 2",
      ].join("\n"),
    );
    for (const content of ["Welcome to version 1", "Welcome to version 2"]) {
      expect
        .soft(spanning.find((line) => line.content === content)?.tokens, content)
        .toEqual(expected.find((line) => line.content === content)?.tokens);
    }
    expect(spanning.find((line) => line.content === longLine)?.tokens).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);
  });

  it("retries a failed lazy grammar load and discards a batch cancelled while loading", async () => {
    const { rows, files } = buildNativeReviewDiffData(
      buildReviewParsedDiff(
        fullSveltePatch(["def greet(name):", '    return "Hello " + name']).replaceAll(
          "App.svelte",
          "greet.py",
        ),
        "python",
      ),
    );
    const input = {
      rows,
      files,
      scheme: "dark",
      engine: "javascript",
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
    } as const;
    const language = (await reviewHighlighter.importReviewLanguage("python"))!;
    const loading = Promise.withResolvers<typeof language>();
    const started = Promise.withResolvers<void>();
    const importer = vi
      .spyOn(reviewHighlighter, "importReviewLanguage")
      .mockRejectedValueOnce(new Error("grammar unavailable"))
      .mockImplementationOnce(() => {
        started.resolve();
        return loading.promise;
      });
    try {
      const fallback = await highlightNativeReviewDiffVisibleRows(input);
      const lineRows = rows.filter((row) => row.kind === "line");
      for (const row of lineRows) {
        expect(fallback.tokensByRowId[row.id]).toEqual([
          { content: row.content, color: null, fontStyle: null },
        ]);
      }
      const controller = new AbortController();
      tokenization.calls = [];
      const pending = highlightNativeReviewDiffVisibleRows({ ...input, signal: controller.signal });
      await started.promise;
      controller.abort();
      loading.resolve(language);
      expect(await pending).toMatchObject({ tokensByRowId: {}, rowCount: 0 });
      expect(tokenization.calls).toEqual([]);

      const recovered = await highlightNativeReviewDiffVisibleRows(input);
      const tokens = recovered.tokensByRowId[lineRows[0]!.id]!;
      expect(tokens.map((token) => token.content).join("")).toBe("def greet(name):");
      expect(new Set(tokens.map((token) => token.color)).size).toBeGreaterThan(1);
    } finally {
      loading.resolve(language);
      importer.mockRestore();
    }
  });
});

describe.each(["native", "javascript"] as const)("%s highlighting budgets", (engine) => {
  const highlightRows = (rows: ReadonlyArray<NativeReviewDiffRow>, signal?: AbortSignal) =>
    highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
      signal,
    });

  const line = (id: number, content: string) =>
    makeLine({
      id: `line-${id}`,
      content,
      change: "add",
      oldLineNumber: null,
      newLineNumber: id,
    });

  it("still highlights a line at the length limit", async () => {
    const content = `// ${"x".repeat(997)}`;
    const result = await highlightRows([line(1, content)]);

    expect(tokenization.calls).toEqual([content]);
    expect(result.tokensByRowId["line-1"]?.some((token) => token.color !== null)).toBe(true);
  });

  it("keeps only the long line plain and resumes highlighting after it", async () => {
    const longLine = `${"x".repeat(1_001)} /*`;
    const rows = [
      line(1, "export const before = 1;"),
      line(2, longLine),
      { kind: "comment", id: "note", commentText: "Check this", fileId: TYPESCRIPT_FILE.id },
      line(3, "export const inside = 'x';"),
      makeHunk("next-hunk"),
      line(100, "export const after = 2;"),
    ] satisfies ReadonlyArray<NativeReviewDiffRow>;
    const result = await highlightRows(rows);

    expect(result.engine).toBe(engine);
    expect(Object.keys(result.tokensByRowId)).toEqual(["line-1", "line-2", "line-3", "line-100"]);
    expect(result.tokensByRowId["line-2"]).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);
    for (const id of ["line-1", "line-3", "line-100"]) {
      expect(result.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
    }
    expect(tokenization.calls.some((code) => code.includes(longLine))).toBe(false);
  });

  it("highlights the rows after a long line the same regardless of the first window", async () => {
    const rows = [
      line(1, "export const before = 1;"),
      line(2, `const data = "${"x".repeat(1_050)}";`),
      line(3, "export const inside = 'x';"),
      line(4, "export const after = 2;"),
    ];
    const spanning = await highlightRows(rows);
    const afterLongLine = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 2,
      lastRowIndex: 3,
      overscanRows: 0,
    });

    for (const id of ["line-3", "line-4"]) {
      expect(spanning.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
      expect(afterLongLine.tokensByRowId[id]).toEqual(spanning.tokensByRowId[id]);
    }
  });

  it("preserves multiline grammar and row mapping across character-limited batches", async () => {
    const opening = line(1, "const message = `open");
    const body = Array.from({ length: 40 }, (_, index) => line(index + 2, "inside ".repeat(45)));
    const closing = line(42, "closed`; ");
    const trailing = line(43, "export const after = 2;");
    const result = await highlightRows([opening, ...body, closing, trailing]);
    const calls = [...tokenization.calls];
    const expected = await highlightRows([
      opening,
      { ...closing, newLineNumber: 2 },
      { ...trailing, newLineNumber: 3 },
    ]);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((code) => code.length <= 8_000)).toBe(true);
    expect(result.rowCount).toBe(43);
    for (const row of [opening, ...body, closing, trailing]) {
      expect(result.tokensByRowId[row.id]?.map((token) => token.content).join("")).toBe(
        row.content,
      );
    }
    expect(result.tokensByRowId[closing.id]).toEqual(expected.tokensByRowId[closing.id]);
    expect(result.tokensByRowId[trailing.id]).toEqual(expected.tokensByRowId[trailing.id]);
  });

  it("stops before later batches and publishes no partial result after cancellation", async () => {
    const controller = new AbortController();
    tokenization.afterCall = () => controller.abort();
    const rows = Array.from({ length: 30 }, (_, index) => line(index + 1, `// ${"x".repeat(400)}`));

    const result = await highlightRows(rows, controller.signal);

    expect(tokenization.calls).toHaveLength(1);
    expect(result.rowCount).toBe(0);
    expect(result.tokensByRowId).toEqual({});
  });
});
