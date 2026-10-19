import type {
  OrchestrationV2Subagent,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { fileBasename } from "@t3tools/shared/path";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

export function subagentGroupSummary(
  members: ReadonlyArray<{ readonly status: OrchestrationV2TurnItemStatus }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${active ? "Kicked off" : "Ran"} ${members.length} ${members.length === 1 ? "subagent" : "subagents"}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}

export function resolveSubagentMetadata(input: {
  readonly model: string | null;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null | undefined;
  readonly parentThread?:
    | Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">
    | null
    | undefined;
  readonly childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath">
    | null
    | undefined;
  readonly parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | null | undefined;
  readonly childProject?:
    | Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
    | null
    | undefined;
}) {
  const model = input.model?.trim();
  const slug = input.provider
    ? resolveSelectableModel(input.provider.driver, model, input.provider.models)
    : model;
  const catalogModel = input.provider?.models.find((candidate) => candidate.slug === slug);
  const reportedLabel = catalogModel
    ? catalogModel.shortName || catalogModel.name
    : model
      ? formatModelSlugName(model)
      : "Not reported";
  const qualifier = catalogModel?.subProvider?.trim();
  const modelLabel = qualifier
    ? reportedLabel
        .replace(
          new RegExp(
            `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
            "iu",
          ),
          "",
        )
        .trim() || reportedLabel
    : reportedLabel;
  const parentWorkspace = input.parentThread?.worktreePath ?? input.parentProject?.workspaceRoot;
  const childWorkspace = input.childThread?.worktreePath ?? input.childProject?.workspaceRoot;
  const workspace = [
    ...(input.parentThread &&
    input.childProject &&
    input.childProject.id !== input.parentThread.projectId
      ? [{ label: "Project", value: input.childProject.title }]
      : []),
    ...(parentWorkspace && childWorkspace && parentWorkspace !== childWorkspace
      ? [
          {
            label: input.childThread?.branch
              ? "Branch"
              : input.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: input.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  return { modelLabel, workspace };
}

export function subagentDetailPreview(input: {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
}): string | null {
  const result = input.result?.trim();
  const progress = input.progress?.trim();
  const detail =
    (isTerminalSubagentStatus(input.status) ? result || progress : progress || result) || "";
  const compact = detail.replace(/\s+/gu, " ");
  return compact.length > 280 ? `${compact.slice(0, 280).trimEnd()}…` : compact || null;
}

export function resolveSubagentContextUsage(
  subagent: {
    readonly status: OrchestrationV2Subagent["status"];
    readonly usage?: OrchestrationV2Subagent["usage"] | null;
  },
  childThread?: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status"> | null,
): OrchestrationV2Subagent["usage"] | null {
  // A follow-up runs in the child thread without updating the settled task.
  if (
    isTerminalSubagentStatus(subagent.status) &&
    (childThread?.activityRunStatus || childThread?.status === "queued")
  ) {
    return null;
  }
  return subagent.usage ?? null;
}

export function formatSubagentUsage(usage: OrchestrationV2Subagent["usage"] | null): string | null {
  if (!usage) return null;
  const tools = `${usage.toolUses} ${usage.toolUses === 1 ? "tool use" : "tool uses"}`;
  return `${formatTokens(usage.contextTokens)} context · ${tools}`;
}
