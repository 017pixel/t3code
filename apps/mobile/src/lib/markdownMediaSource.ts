import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import {
  resolveMediaSource,
  type ResolveMediaSourceInput,
} from "@t3tools/client-runtime/media-source";

export function resolveMobileMarkdownMediaSource(href: string, input: ResolveMediaSourceInput) {
  const source = input.workspaceRoot
    ? classifyMarkdownImageSource(href, input.workspaceRoot)
    : null;
  // Mobile never falls back to another host, so it keeps the path resolved against the
  // Markdown file's own directory rather than one relative to the thread workspace.
  const media = resolveMediaSource(
    href,
    source?._tag === "WorkspaceFile" && input.resolvedFilePath === undefined
      ? { ...input, resolvedFilePath: source.path }
      : input,
  );
  if (media?.access !== "unavailable" || !input.workspaceRoot) return media;
  if (source?._tag !== "WorkspaceFile") return media;
  return {
    ...media,
    access: "environment" as const,
    resource: {
      _tag: "draft-workspace-file" as const,
      cwd: input.workspaceRoot,
      path: source.path,
    },
  };
}
