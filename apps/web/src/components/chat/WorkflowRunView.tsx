import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveWorkflowGroups,
  isActiveSubagentStatus,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { NodeId, ThreadId, type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { CheckIcon, LoaderCircleIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useThreadProjection } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AgentElapsed } from "./AgentElapsed";
import { threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import {
  defaultWorkflowPhaseIndex,
  workflowPhaseStatus,
  workflowRunCounts,
  workflowRunPhases,
} from "./WorkflowRunView.logic";

export type WorkflowRunTab = "agents" | "script";

/** Switches a workflow thread between its run view and the raw script chat. */
function WorkflowRunTabs(props: {
  readonly value: WorkflowRunTab;
  readonly onChange: (tab: WorkflowRunTab) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Workflow view"
      value={[props.value]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "agents" || next === "script") props.onChange(next);
      }}
    >
      <Toggle value="agents">Agents</Toggle>
      <Toggle value="script">Script</Toggle>
    </ToggleGroup>
  );
}

/** Static glyph for an agent or phase state. Nothing here animates. */
function StatusGlyph({ status }: { readonly status: RuntimeSubagentStatus }) {
  const label = threadRelationshipStatusLabel(status);
  const glyph =
    status === "completed" ? (
      <CheckIcon className="size-3.5 text-success" />
    ) : status === "failed" ? (
      <XIcon className="size-3.5 text-destructive" />
    ) : status === "cancelled" || status === "interrupted" ? (
      <MinusIcon className="size-3.5 text-muted-foreground" />
    ) : status === "running" || status === "waiting" ? (
      <span className="size-2 rounded-full bg-info" />
    ) : (
      <span className="size-2 rounded-full border-2 border-muted-foreground/70" />
    );
  return (
    <span
      role="img"
      aria-label={label}
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      {glyph}
    </span>
  );
}

const ROW_GRID =
  "grid grid-cols-[1rem_minmax(0,1fr)_3.5rem_4rem] items-center gap-2 sm:grid-cols-[1rem_minmax(0,1fr)_8rem_3.5rem_3rem_4rem]";

function AgentRow(props: {
  readonly member: RuntimeSubagent;
  readonly provider: ServerProvider | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { member } = props;
  const model =
    member.model === null
      ? "–"
      : resolveSubagentMetadata({ model: member.model, provider: props.provider }).modelLabel;
  const retried = (member.attempt ?? 1) > 1;
  return (
    <li className={cn("rounded-md", props.expanded && "bg-accent/60")}>
      <button
        type="button"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
        className={cn(
          ROW_GRID,
          "w-full rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent/60",
        )}
      >
        <StatusGlyph status={member.status} />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{member.title}</span>
          {retried ? (
            <span className="shrink-0 text-2xs text-muted-foreground">
              attempt {member.attempt}
            </span>
          ) : null}
        </span>
        <span className="hidden truncate text-right text-muted-foreground sm:block">{model}</span>
        <span className="text-right tabular-nums">
          {member.usage ? formatTokens(member.usage.totalTokens) : "–"}
        </span>
        <span className="hidden text-right tabular-nums text-muted-foreground sm:block">
          {member.usage?.toolUses ?? "–"}
        </span>
        <span
          className={cn(
            "text-right tabular-nums",
            member.status !== "running" && "text-muted-foreground",
          )}
        >
          <AgentElapsed agent={member} />
        </span>
      </button>
      {!props.expanded && member.error ? (
        <p className="truncate ps-8 pe-1.5 pb-1 text-xs text-muted-foreground">{member.error}</p>
      ) : null}
      {props.expanded ? (
        <div className="grid gap-2 ps-8 pe-3 pt-0.5 pb-2.5 text-xs">
          {member.progress ? (
            <div>
              <div className="text-2xs text-muted-foreground">Prompt</div>
              <p className="line-clamp-6 whitespace-pre-wrap break-words">{member.progress}</p>
            </div>
          ) : null}
          {member.error || member.result ? (
            <div>
              <div
                className={cn(
                  "text-2xs",
                  member.error ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {member.error ? "Error" : "Result"}
              </div>
              <p className="line-clamp-6 whitespace-pre-wrap break-words">
                {member.error ?? member.result}
              </p>
            </div>
          ) : null}
          {member.childThreadId ? (
            <div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onOpenThread(ThreadId.make(member.childThreadId!))}
              >
                Open chat
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The run view a workflow coordinator's thread opens to: totals, a phase rail,
 * and one row per agent. It renders the coordinator's progress snapshot, so it
 * shows the same data as the Lineage panel at a size that fits a full run.
 */
function WorkflowRunView(props: {
  readonly group: SubagentWorkflowGroup;
  readonly provider: ServerProvider | undefined;
  readonly tab: WorkflowRunTab;
  readonly onTabChange: (tab: WorkflowRunTab) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStop: (() => void) | undefined;
  readonly stopping: boolean;
  /** Space the docked composer covers at the bottom of the view. */
  readonly bottomInset: number;
}) {
  const { workflow } = props.group;
  const phases = workflowRunPhases(props.group);
  const [pickedPhase, setPickedPhase] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Follow the live phase until the user picks one.
  const selectedIndex =
    pickedPhase !== null && phases.some((phase) => phase.index === pickedPhase)
      ? pickedPhase
      : defaultWorkflowPhaseIndex(phases);
  const selected = phases.find((phase) => phase.index === selectedIndex);
  const counts = workflowRunCounts(phases);
  const name = workflow.workflowName ?? workflow.title;
  const description = workflow.workflowName !== null ? workflow.title : null;
  const usage = workflow.usage;

  return (
    <div
      className="workflow-run-lane min-h-0 flex-1 overflow-y-auto"
      style={{ paddingBottom: props.bottomInset }}
    >
      <div className="chat-content-lane pt-3 sm:pt-4">
        <header className="flex items-start gap-3 border-b border-border pb-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusGlyph status={workflow.status} />
              <h2 className="truncate text-base font-semibold">{name}</h2>
              <span className="shrink-0 text-sm text-muted-foreground">
                {threadRelationshipStatusLabel(workflow.status)}
              </span>
            </div>
            {description && description !== name ? (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span>
                <span className="font-semibold text-foreground">
                  {counts.settled}/{counts.total}
                </span>{" "}
                agents
              </span>
              {counts.failed > 0 ? (
                <span className="text-destructive">{counts.failed} failed</span>
              ) : null}
              {usage ? (
                <span>
                  <span className="font-semibold text-foreground">
                    {formatTokens(usage.totalTokens)}
                  </span>{" "}
                  tokens
                </span>
              ) : null}
              {usage?.toolUses !== undefined ? (
                <span>
                  <span className="font-semibold text-foreground">{usage.toolUses}</span> tools
                </span>
              ) : null}
              <span className="font-semibold text-foreground empty:hidden">
                <AgentElapsed agent={workflow} />
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {props.onStop ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={props.stopping}
                onClick={props.onStop}
              >
                {props.stopping ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <SquareIcon className="fill-current" />
                )}
                Stop
              </Button>
            ) : null}
            <WorkflowRunTabs value={props.tab} onChange={props.onTabChange} />
          </div>
        </header>

        {phases.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No agents yet</p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-0">
            <nav
              aria-label="Phases"
              className="flex gap-0.5 overflow-x-auto sm:flex-col sm:border-e sm:border-border sm:pe-2.5"
            >
              {phases.map((phase) => (
                <button
                  key={phase.index}
                  type="button"
                  aria-pressed={phase.index === selectedIndex}
                  onClick={() => {
                    setPickedPhase(phase.index);
                    setExpandedId(null);
                  }}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent/60",
                    phase.index === selectedIndex && "bg-accent",
                    phase.state === "pending" && "text-muted-foreground",
                  )}
                >
                  <StatusGlyph status={workflowPhaseStatus(phase)} />
                  <span className="min-w-0 flex-1 truncate">{phase.title}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {phase.members.length === 0
                      ? "–"
                      : `${phase.settledCount}/${phase.members.length}`}
                  </span>
                </button>
              ))}
            </nav>
            <div className="min-w-0 sm:ps-3">
              <div
                aria-hidden
                className={cn(ROW_GRID, "px-1.5 pb-1.5 text-2xs text-muted-foreground")}
              >
                <span />
                <span>Agent</span>
                <span className="hidden text-right sm:block">Model</span>
                <span className="text-right">Tokens</span>
                <span className="hidden text-right sm:block">Tools</span>
                <span className="text-right">Time</span>
              </div>
              {selected === undefined || selected.members.length === 0 ? (
                <p className="px-1.5 py-2 text-sm text-muted-foreground">Not started</p>
              ) : (
                <ul className="m-0 grid list-none gap-px p-0">
                  {selected.members.map((member) => (
                    <AgentRow
                      key={member.id}
                      member={member}
                      provider={props.provider}
                      expanded={expandedId === member.id}
                      onToggle={() =>
                        setExpandedId((current) => (current === member.id ? null : member.id))
                      }
                      onOpenThread={props.onOpenThread}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Wraps a provider subagent thread's timeline. When the thread is a workflow
 * coordinator, it opens to the run view and keeps the timeline (the script and
 * the coordinator's answer) one tab away; any other thread renders the
 * timeline unchanged.
 *
 * The workflow snapshot lives on the coordinator's subagent record in the
 * parent thread, so this reads the parent's projection. Pass a null parent to
 * skip that read for threads that cannot be a coordinator.
 */
export function WorkflowRunSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly provider: ServerProvider | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly bottomInset: number;
  readonly children: ReactNode;
}) {
  const { environmentId, parentThreadId, threadId } = props;
  const parentRef = parentThreadId === null ? null : scopeThreadRef(environmentId, parentThreadId);
  const parentSubagents = useThreadProjection(parentRef)?.projection.subagents;
  const coordinator = parentSubagents?.find(
    (subagent) => subagent.childThreadId === threadId && subagent.workflow !== undefined,
  );
  const group = useMemo(
    () =>
      coordinator === undefined
        ? undefined
        : deriveWorkflowGroups(projectedSubagentsToRuntime([coordinator]))[0],
    [coordinator],
  );
  // ChatView reuses this surface across threads, so view state is keyed to
  // the thread: a new workflow always opens on Agents.
  const [tabState, setTabState] = useState<{ threadId: ThreadId; tab: WorkflowRunTab }>();
  const tab = tabState?.threadId === threadId ? tabState.tab : "agents";
  const setTab = (next: WorkflowRunTab) => setTabState({ threadId, tab: next });
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);
  const stopping = stoppingThreadId === threadId;
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canStop = useAtomValue(orchestrationEnvironment.stopWorkflow.permissionAtom(environmentId));

  if (group === undefined || coordinator === undefined || parentThreadId === null) {
    return props.children;
  }
  if (tab === "script") {
    return (
      <>
        <div className="workflow-run-lane">
          <div className="chat-content-lane flex justify-end pt-2">
            <WorkflowRunTabs value={tab} onChange={setTab} />
          </div>
        </div>
        {props.children}
      </>
    );
  }

  const stop = async () => {
    if (stopping) return;
    setStoppingThreadId(threadId);
    const result = await stopWorkflow({
      environmentId,
      input: { threadId: parentThreadId, subagentId: NodeId.make(coordinator.id) },
    });
    setStoppingThreadId((current) => (current === threadId ? null : current));
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    }
  };

  return (
    <WorkflowRunView
      key={threadId}
      group={group}
      provider={props.provider}
      tab={tab}
      onTabChange={setTab}
      onOpenThread={props.onOpenThread}
      onStop={
        canStop && isActiveSubagentStatus(group.workflow.status) ? () => void stop() : undefined
      }
      stopping={stopping}
      bottomInset={props.bottomInset}
    />
  );
}
