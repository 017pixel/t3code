import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultWorkflowPhaseIndex,
  UNPHASED_WORKFLOW_PHASE_INDEX,
  workflowPhaseStatus,
  workflowRunCounts,
  workflowRunPhases,
} from "./WorkflowRunView.logic";

const at = DateTime.makeUnsafe("2026-10-15T10:00:00.000Z");

function phasesOf(
  workflow: OrchestrationV2SubagentWorkflow,
  status: "running" | "cancelled" = "running",
) {
  const [group] = deriveWorkflowGroups(
    projectedSubagentsToRuntime([
      {
        id: "coordinator",
        title: "Build the game",
        prompt: "export const meta = …",
        model: null,
        status,
        workflow,
        result: null,
        startedAt: at,
        completedAt: null,
        updatedAt: at,
      },
    ]),
  );
  return workflowRunPhases(group!);
}

const PLAN = [
  { index: 0, title: "Plan" },
  { index: 1, title: "Build" },
  { index: 2, title: "Verify" },
];

describe("workflow run view phases", () => {
  it("opens on the running phase and counts settled and failed agents", () => {
    const phases = phasesOf({
      phases: PLAN,
      agents: [
        { index: 0, label: "plan", state: "completed", phaseIndex: 0 },
        { index: 1, label: "build:a", state: "failed", phaseIndex: 1 },
        { index: 2, label: "build:b", state: "running", phaseIndex: 1 },
      ],
    });
    expect(defaultWorkflowPhaseIndex(phases)).toBe(1);
    expect(workflowRunCounts(phases)).toEqual({ total: 3, settled: 2, failed: 1 });
  });

  it("opens on the latest started phase once nothing runs", () => {
    const phases = phasesOf({
      phases: PLAN,
      agents: [
        { index: 0, label: "plan", state: "completed", phaseIndex: 0 },
        { index: 1, label: "build:a", state: "completed", phaseIndex: 1 },
      ],
    });
    expect(defaultWorkflowPhaseIndex(phases)).toBe(1);
  });

  it("lists agents without a phase under Other", () => {
    const phases = phasesOf({
      phases: [],
      agents: [{ index: 0, label: "loose", state: "running" }],
    });
    expect(phases.map((phase) => phase.title)).toEqual(["Other"]);
    expect(defaultWorkflowPhaseIndex(phases)).toBe(UNPHASED_WORKFLOW_PHASE_INDEX);
  });

  it("marks a phase stopped, not done, when the workflow was stopped", () => {
    const phases = phasesOf(
      {
        phases: PLAN,
        agents: [
          { index: 0, label: "plan", state: "completed", phaseIndex: 0 },
          { index: 1, label: "build:a", state: "completed", phaseIndex: 1 },
          { index: 2, label: "build:b", state: "running", phaseIndex: 1 },
        ],
      },
      "cancelled",
    );
    expect(phases.map(workflowPhaseStatus)).toEqual(["completed", "cancelled", "pending"]);
  });
});
