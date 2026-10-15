import {
  isTerminalSubagentStatus,
  type RuntimeSubagentStatus,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";

export type WorkflowRunPhase = SubagentWorkflowGroup["phases"][number];

/** Rail index for members the provider reported without a phase. */
export const UNPHASED_WORKFLOW_PHASE_INDEX = -1;

/**
 * Phases the run view's rail lists, in plan order. Members without a phase get
 * a trailing "Other" entry so every agent stays reachable from the rail.
 */
export function workflowRunPhases(group: SubagentWorkflowGroup): ReadonlyArray<WorkflowRunPhase> {
  const members = group.unphasedMembers;
  if (members.length === 0) return group.phases;
  const active = members.some((member) => !isTerminalSubagentStatus(member.status));
  return [
    ...group.phases,
    {
      index: UNPHASED_WORKFLOW_PHASE_INDEX,
      title: "Other",
      members,
      state: active ? "running" : "done",
      settledCount: members.filter((member) => isTerminalSubagentStatus(member.status)).length,
    },
  ];
}

/**
 * The phase the rail opens on: the first running one, else the latest one
 * with agents, else the first. Null when the plan has no phases yet.
 */
export function defaultWorkflowPhaseIndex(phases: ReadonlyArray<WorkflowRunPhase>): number | null {
  const running = phases.find((phase) => phase.state === "running");
  if (running) return running.index;
  const started = phases.findLast((phase) => phase.members.length > 0);
  return (started ?? phases[0])?.index ?? null;
}

/** Agent counts for the run header. */
export function workflowRunCounts(phases: ReadonlyArray<WorkflowRunPhase>) {
  const members = phases.flatMap((phase) => phase.members);
  return {
    total: members.length,
    settled: members.filter((member) => isTerminalSubagentStatus(member.status)).length,
    failed: members.filter((member) => member.status === "failed").length,
  };
}

/** One status for a phase's rail glyph. Failure wins, then a stop. */
export function workflowPhaseStatus(phase: WorkflowRunPhase): RuntimeSubagentStatus {
  if (phase.state === "running") return "running";
  if (phase.state === "pending") return "pending";
  const has = (...statuses: ReadonlyArray<RuntimeSubagentStatus>) =>
    phase.members.some((member) => statuses.includes(member.status));
  if (has("failed")) return "failed";
  if (has("cancelled", "interrupted")) return "cancelled";
  return "completed";
}
