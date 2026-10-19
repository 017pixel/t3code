import { useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { MermaidDiagram } from "../chat/MermaidDiagram";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";

export default function MermaidViewer(props: { readonly text: string }) {
  const { resolvedTheme } = useTheme();
  const [expanded, setExpanded] = useState<string | null>(null);
  // Mermaid lays out DOM before sanitizing its SVG. Refuse resource and config
  // syntax before that pass so standalone files cannot initiate requests.
  if (
    /%%\s*\{|^\s*---|<|\b(?:img|image)\s*:|url\s*\(|@import|(?:https?|data|blob|file):/im.test(
      props.text,
    )
  )
    return (
      <div role="alert" className="p-6 text-xs text-muted-foreground">
        This diagram contains resource URLs, markup, or custom configuration. Show Mermaid source to
        inspect it safely.
      </div>
    );
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto p-6 [&_*]:animate-none!">
      <MermaidDiagram source={props.text} theme={resolvedTheme} onExpand={setExpanded} />
      {expanded ? (
        <ExpandedImageDialog
          preview={{ images: [{ src: expanded, name: "Mermaid diagram" }], index: 0 }}
          onClose={() => setExpanded(null)}
        />
      ) : null}
    </div>
  );
}
