import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveMarkdownMediaPreview } from "./markdownMedia";
import { resolveMobileMarkdownMediaSource } from "./markdownMediaSource";

describe("mobile Markdown draft media", () => {
  it("authorizes relative images and videos against the draft directory", () => {
    for (const name of ["diagram.svg", "clip.mp4"]) {
      expect(
        resolveMobileMarkdownMediaSource(`./${name}`, {
          threadId: undefined,
          workspaceRoot: "/project/docs",
          imageEmbed: true,
        }),
      ).toMatchObject({
        access: "environment",
        resource: {
          _tag: "draft-workspace-file",
          cwd: "/project/docs",
          path: `/project/docs/./${name}`,
        },
      });
    }
  });

  it("keeps thread authorization when a thread exists", () => {
    const threadId = ThreadId.make("markdown-thread");
    expect(
      resolveMobileMarkdownMediaSource("image.png", { threadId, workspaceRoot: "/project" }),
    ).toMatchObject({ resource: { _tag: "media-file", threadId, path: "/project/image.png" } });
  });

  it("resolves a nested document's media from its own directory, not the thread root", () => {
    const threadId = ThreadId.make("markdown-thread");
    const input = {
      environmentId: EnvironmentId.make("remote"),
      threadId,
      workspaceRoot: "/repo/docs",
      imageEmbed: true,
    };
    for (const [href, path] of [
      ["report.png", "/repo/docs/report.png"],
      ["../clip.mp4", "/repo/docs/../clip.mp4"],
      ["guide.pdf", "/repo/docs/guide.pdf"],
    ] as const) {
      expect(resolveMarkdownMediaPreview(href, input)?.source).toMatchObject({
        resource: { _tag: "media-file", threadId, path },
      });
    }
  });

  it("keeps direct URLs direct and rejects unresolvable or blocked references", () => {
    const input = { threadId: undefined, workspaceRoot: "/project" };
    expect(resolveMobileMarkdownMediaSource("https://example.com/image.png", input)).toMatchObject({
      access: "direct",
      uri: "https://example.com/image.png",
    });
    expect(resolveMobileMarkdownMediaSource("javascript:alert(1)", input)).toBeNull();
    expect(resolveMobileMarkdownMediaSource("image.png", { threadId: undefined })).toBeNull();
  });
});
