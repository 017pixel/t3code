import { approvalRequestLabel } from "@t3tools/client-runtime/state/thread-requests";
import { approvalCommandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { ShieldIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  actions?: ReactNode;
}

/** Laid out like the question card: the decisions sit in the header row, or below the request when narrow. */
export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  actions,
}: ComposerPendingApprovalPanelProps) {
  const label = approvalRequestLabel(approval.requestKind);
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";
  const providerGone = approval.responseCapability === "not_resumable";
  const isCode = approval.requestKind !== "mcp-elicitation" && !providerGone;
  const Detail = isCode ? "code" : "p";

  return (
    <div aria-label={label} role="group" data-chat-composer-collapsed-controls="true">
      <ComposerBanner.Row>
        <ComposerBanner.Icon className="text-warning">
          <ShieldIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="@max-[480px]:col-end-4">
          <span className="shrink-0 font-medium text-foreground">{label}</span>
          {approval.appName || approval.title ? (
            <span className="min-w-0 truncate text-secondary-label">
              {approval.appName ?? approval.title}
            </span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="@max-[480px]:col-start-2 @max-[480px]:col-end-4 @max-[480px]:row-start-3 @max-[480px]:mt-1.5">
          {pendingCount > 1 ? (
            <span className="me-1 text-3xs font-medium text-muted-foreground tabular-nums">
              1/{pendingCount}
            </span>
          ) : null}
          {actions}
        </ComposerBanner.Actions>
        <Detail
          aria-label={detailAriaLabel}
          className={cn(
            "col-start-2 col-end-4 row-start-2 mt-1.5 me-1 mb-1 block max-h-32 min-w-0 overflow-auto whitespace-pre-wrap text-xs leading-relaxed [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:w-1.5",
            // Long commands wrap so every part of what is approved stays readable.
            isCode
              ? "rounded-md border border-border bg-code px-2.5 py-1.5 font-mono text-foreground wrap-anywhere"
              : "text-foreground/85 wrap-break-word",
          )}
          data-approval-detail="complete"
          tabIndex={0}
        >
          {providerGone
            ? "Provider process is gone — interrupt or restart the run to respond."
            : approval.detail
              ? approval.requestKind === "command"
                ? approvalCommandDisplayText(approval.detail)
                : approval.detail
              : label}
        </Detail>
      </ComposerBanner.Row>
    </div>
  );
});
