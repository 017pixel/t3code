import type { ScopedThreadRef } from "@t3tools/contracts";

import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { splitMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

import ChatMarkdown from "~/components/ChatMarkdown";

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;
  // The checkbox offset is into the rendered body. The file still has the
  // frontmatter in front of that body, so the saved edit adds it back.
  const preview = splitMarkdownFrontmatter(props.text);
  const onTaskListChange = props.onTaskListChange;

  return (
    <ChatMarkdown
      text={preview.body}
      cwd={props.cwd}
      imageBaseDir={imageBaseDir}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
      className="mx-auto max-w-4xl px-6 py-5"
      onTaskListChange={
        onTaskListChange === undefined
          ? undefined
          : ({ markerOffset, checked }) => {
              onTaskListChange({
                markerOffset: markerOffset + preview.bodyOffset,
                checked,
              });
            }
      }
    />
  );
}
