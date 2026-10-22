import {
  hydratePartialDiff,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createGitDiffFileContentsLoader } from "./diffFileContents";

const PATCH = [
  "diff --git a/notes.txt b/notes.txt",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -4,5 +4,5 @@",
  " four",
  " five",
  "-six",
  "+SIX",
  " seven",
  " eight",
  "",
].join("\n");
const OLD_CONTENTS = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
const NEW_CONTENTS = "one\ntwo\nthree\nfour\nfive\nSIX\nseven\neight\nnine\n";

function parseFileDiff(patch = PATCH): FileDiffMetadata {
  const fileDiff = parsePatchFiles(patch, "test")[0]?.files[0];
  if (!fileDiff) throw new Error("expected a parsed file diff");
  return fileDiff;
}

function workingTreeLoader(oldContents: string, newContents: string) {
  return createGitDiffFileContentsLoader(
    async () => AsyncResult.success({ oldContents, newContents }),
    {
      environmentId: EnvironmentId.make("environment-1"),
      cwd: "/repo",
      sourceKind: "working-tree",
      baseRef: "HEAD",
      headRef: null,
      cacheKey: "diff-1",
    },
  );
}

// Mirrors Pierre's FileDiff.loadFilesForDiff: a rejected load leaves the patch as parsed.
async function hydrateLikePierre(fileDiff: FileDiffMetadata, loader: FileDiffContentsLoader) {
  try {
    hydratePartialDiff("merge", fileDiff, await loader(fileDiff));
  } catch {}
}

function displayedChange(fileDiff: FileDiffMetadata) {
  const change = fileDiff.hunks[0]?.hunkContent.find((content) => content.type === "change");
  if (change?.type !== "change") throw new Error("expected a change block");
  return {
    deleted: fileDiff.deletionLines.slice(
      change.deletionLineIndex,
      change.deletionLineIndex + change.deletions,
    ),
    added: fileDiff.additionLines.slice(
      change.additionLineIndex,
      change.additionLineIndex + change.additions,
    ),
  };
}

describe("diff file contents loaders", () => {
  it("hydrates a partial diff with the files the patch was made from", async () => {
    const fileDiff = parseFileDiff();
    await hydrateLikePierre(fileDiff, workingTreeLoader(OLD_CONTENTS, NEW_CONTENTS));

    expect(fileDiff.isPartial).toBe(false);
    expect(displayedChange(fileDiff)).toEqual({ deleted: ["six\n"], added: ["SIX\n"] });
  });

  it("hydrates ignored-whitespace patches when only context whitespace differs", async () => {
    const fileDiff = parseFileDiff();
    await hydrateLikePierre(
      fileDiff,
      workingTreeLoader(OLD_CONTENTS, NEW_CONTENTS.replace("four\n", "    four\n")),
    );

    expect(fileDiff.isPartial).toBe(false);
    expect(displayedChange(fileDiff)).toEqual({ deleted: ["six\n"], added: ["SIX\n"] });
  });

  it("keeps the patch when either side changed after the patch was generated", async () => {
    for (const [oldContents, newContents] of [
      [OLD_CONTENTS, `inserted\n${NEW_CONTENTS}`],
      [`inserted\n${OLD_CONTENTS}`, NEW_CONTENTS],
    ] as const) {
      const fileDiff = parseFileDiff();
      await hydrateLikePierre(fileDiff, workingTreeLoader(oldContents, newContents));

      expect(displayedChange(fileDiff)).toEqual({ deleted: ["six\n"], added: ["SIX\n"] });
      expect(fileDiff.isPartial).toBe(true);
    }
  });

  it("keeps one-sided patches when the unchecked side shifted", async () => {
    const header = ["diff --git a/notes.txt b/notes.txt", "--- a/notes.txt", "+++ b/notes.txt"];
    const deletion = [
      ...header,
      "@@ -4,5 +4,4 @@",
      " four",
      " five",
      "-six",
      " seven",
      " eight",
      "",
    ];
    const insertion = [
      ...header,
      "@@ -4,4 +4,5 @@",
      " four",
      " five",
      "+six",
      " seven",
      " eight",
      "",
    ];
    const withSix = OLD_CONTENTS;
    const withoutSix = OLD_CONTENTS.replace("six\n", "");
    for (const [patch, oldContents, newContents] of [
      [deletion, withSix, `PREFIX\n${withoutSix}`],
      [insertion, `PREFIX\n${withoutSix}`, withSix],
    ] as const) {
      const fileDiff = parseFileDiff(patch.join("\n"));
      await hydrateLikePierre(fileDiff, workingTreeLoader(oldContents, newContents));

      expect(fileDiff.isPartial).toBe(true);
    }
  });
});
