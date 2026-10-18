import { approvalRequestLabel } from "@t3tools/client-runtime/state/thread-requests";
import { approvalCommandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { EyeIcon, ShieldIcon, SquarePenIcon, TerminalIcon } from "lucide-react";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

export function ComposerPendingApprovalKindIcon({
  requestKind,
}: {
  requestKind: PendingApproval["requestKind"];
}) {
  switch (requestKind) {
    case "command":
      return <TerminalIcon />;
    case "file-change":
      return <SquarePenIcon />;
    case "file-read":
      return <EyeIcon />;
    default:
      return <ShieldIcon />;
  }
}

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel = approvalRequestLabel(approval.requestKind);
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

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">
          {approval.appName ?? approval.title ?? fallbackLabel}
        </span>
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </span>
      <Detail
        aria-label={detailAriaLabel}
        className={cn(
          "block w-full min-w-0 overflow-auto text-xs text-muted-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:w-1.5",
          approval.requestKind === "mcp-elicitation"
            ? "max-h-20 whitespace-pre-wrap font-sans wrap-break-word"
            : "max-h-40 whitespace-pre-wrap font-mono wrap-anywhere",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.responseCapability === "not_resumable"
          ? "Provider process is gone — interrupt or restart the run to respond."
          : approval.detail
            ? approval.requestKind === "command"
              ? approvalCommandDisplayText(approval.detail)
              : approval.detail
            : fallbackLabel}
      </Detail>
    </span>
  );
});
