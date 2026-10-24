import { describe, expect, it } from "vite-plus/test";

import { classifyMarkdownImageSource, markdownImageMediaPath } from "./markdownImages.js";

describe("classifyMarkdownImageSource", () => {
  it.each([
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["file:///workspace/project/image%20one.png", null, "/workspace/project/image one.png"],
    ["file://server/share/image.png", "\\\\server\\share", "\\\\server\\share\\image.png"],
  ])("maps %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
    });
  });

  it.each(["image.png", "javascript:alert(1)", "file://%"])(
    "blocks unsupported or unresolved source %s",
    (source) => {
      expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
    },
  );

  // Loading these makes Windows send the user's NTLM credentials to the named host.
  it.each([
    "file://attacker.test/share/cat.jpg",
    "\\\\attacker.test\\share\\cat.jpg",
    "/\\attacker.test\\share\\cat.jpg",
    "file:/%5Cattacker.test%5Cshare%5Ccat.jpg",
    "\\\\server\\other\\cat.jpg",
  ])("blocks network path %s outside the project", (source) => {
    expect(classifyMarkdownImageSource(source, "\\\\server\\share\\project")).toEqual({
      _tag: "Blocked",
    });
  });
});

describe("markdownImageMediaPath", () => {
  it.each([
    ["../shot.png", "/repo/docs", "docs/../shot.png"],
    ["/repo/docs/shot.png", "/repo/docs", "/repo/docs/shot.png"],
    ["file:///repo/docs/shot.png", "/repo/docs", "/repo/docs/shot.png"],
  ])("resolves %s from %s against the thread's own host", (source, baseDir, path) => {
    const classified = classifyMarkdownImageSource(source, baseDir);
    expect(classified._tag).toBe("WorkspaceFile");
    if (classified._tag !== "WorkspaceFile") return;
    expect(markdownImageMediaPath(source, classified.path, "/repo")).toBe(path);
  });
});
