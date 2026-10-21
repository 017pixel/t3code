import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";
import { useSourceTextSelection } from "./useSourceTextSelection";

export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<undefined, undefined>["onPostRender"];
}) {
  const resolvedTheme = useRenderedAppearance();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const onSelectionPostRender = useSourceTextSelection(props.text);
  const { onPostRender } = props;
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        key={`${props.name}:${resolvedTheme}:${props.text.length}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={{
            name: props.name,
            contents: props.text,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          options={{
            disableFileHeader: true,
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            onPostRender: (fileContainer, instance, phase) => {
              onPostRender?.(fileContainer, instance, phase);
              onSelectionPostRender(fileContainer, phase);
            },
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}
