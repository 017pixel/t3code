import { useId } from "react";
import {
  codexCitationMarkdown,
  codexCitationText,
  type CodexCitation,
} from "@t3tools/shared/codexCitations";

import { ContextChip, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

export function CodexCitationChip({ citation }: { citation: CodexCitation }) {
  const descriptionId = useId();
  const numbers = citation.sources.map((source) => source.number).join(", ");
  const label = `${citation.sources.length === 1 ? "Source" : "Sources"} ${numbers}`;

  return (
    <span
      data-markdown-copy={codexCitationMarkdown(citation)}
      data-markdown-copy-text={codexCitationText(citation)}
    >
      <Popover>
        <PopoverTrigger
          render={<ContextChip kind="citation" render={<button type="button" />} />}
          aria-label={`View ${label.toLowerCase()}`}
          title={`${label}. Source URL unavailable.`}
        >
          <ContextChipLabel className="tabular-nums">{numbers}</ContextChipLabel>
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          width="md"
          padding="compact"
          aria-describedby={descriptionId}
        >
          <PopoverTitle>{label}</PopoverTitle>
          <dl className="mt-3 space-y-2 text-xs">
            {citation.sources.map((source) => (
              <div key={source.id} className="flex items-baseline gap-3">
                <dt className="shrink-0 text-muted-foreground">Source {source.number}</dt>
                <dd className="min-w-0 font-mono wrap-anywhere select-text">{source.id}</dd>
              </div>
            ))}
            {citation.locator ? (
              <div className="flex items-baseline gap-3">
                <dt className="shrink-0 text-muted-foreground">Lines</dt>
                <dd className="min-w-0 font-mono wrap-anywhere select-text">{citation.locator}</dd>
              </div>
            ) : null}
          </dl>
          <p id={descriptionId} className="mt-3 text-xs text-muted-foreground">
            Source URL unavailable. Codex supplied source IDs without destination links.
          </p>
        </PopoverPopup>
      </Popover>
    </span>
  );
}
