import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Music2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

import { AudioPreview } from "./AudioPreview";

export function InlineAudioPreview(props: {
  readonly name: string;
  readonly environmentId?: EnvironmentId;
  readonly resource?: AssetResource;
  readonly src?: string;
  readonly copyMarkdown?: string;
  readonly onOpen?: () => void;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const asset = useAssetUrlState(
    visible ? (props.environmentId ?? null) : null,
    visible ? (props.resource ?? null) : null,
  );
  const src = visible ? (asset._tag === "Success" ? asset.url : props.src) : undefined;
  const failed = asset._tag === "Failure" || (src !== undefined && failedSrc === src);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={container}
      data-markdown-copy={props.copyMarkdown}
      className="my-1 inline-flex h-24 w-96 max-w-full flex-col overflow-hidden rounded-lg border border-border/80 bg-background/70 align-top text-foreground"
    >
      <button
        type="button"
        aria-label={`Preview ${props.name}`}
        disabled={!props.onOpen}
        onClick={props.onOpen}
        className="flex h-11 w-full shrink-0 cursor-pointer items-center gap-2 px-3 text-left text-xs hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
      >
        <Music2Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{props.name}</span>
      </button>
      {src && !failed ? (
        <AudioPreview compact name={props.name} src={src} onError={() => setFailedSrc(src)} />
      ) : (
        <span
          className="flex min-h-0 flex-1 items-center px-3 pb-2 text-2xs text-muted-foreground"
          role={failed ? "status" : undefined}
        >
          {failed ? "Audio unavailable. Open the file to try again." : "Loading audio..."}
        </span>
      )}
    </span>
  );
}
