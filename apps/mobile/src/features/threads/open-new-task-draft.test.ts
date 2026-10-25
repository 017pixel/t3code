import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { INITIAL_NEW_TASK_FLOW_STATE, resolveRouteDraft } from "./new-task-flow-state";
import { withOpenedNewTaskDraft } from "./open-new-task-draft";
import type { NewTaskDraftRouteParams } from "./thread-route-state";

const onlyProject = vi.hoisted(() => ({
  current: null as { environmentId: string; id: string } | null,
}));

vi.mock("./read-only-new-task-project", () => ({
  readOnlyNewTaskProject: () => onlyProject.current,
}));
vi.mock("./new-task-project-branches", () => ({ refreshNewTaskDraftBranches: () => {} }));

const environmentId = EnvironmentId.make("env");
const p1 = { environmentId, id: ProjectId.make("p1") };
const p2 = { environmentId, id: ProjectId.make("p2") };

function setup(only: typeof p1 | null) {
  onlyProject.current = only;
}

function openedProject(draftId: string, projects: ReadonlyArray<typeof p1>) {
  return resolveRouteDraft({
    flow: INITIAL_NEW_TASK_FLOW_STATE,
    routeDraftId: draftId,
    draftsLoaded: true,
    stamp: getComposerDraftSnapshot(draftId).project,
    projects,
  });
}

describe("withOpenedNewTaskDraft", () => {
  it("gives a route naming a project a draft stamped with it", () => {
    setup(null);
    const { draft } = withOpenedNewTaskDraft<{ draft?: NewTaskDraftRouteParams }>({
      draft: { requestId: "r1", environmentId: "env", projectId: "p2" },
    });
    expect(getComposerDraftSnapshot(draft!.draftId as string).project).toMatchObject({
      environmentId: "env",
      projectId: "p2",
    });
  });

  it("keeps the only project once the route opened, whatever projects arrive later", () => {
    setup(p1);
    const { draft } = withOpenedNewTaskDraft<{ draft?: NewTaskDraftRouteParams }>({
      draft: { requestId: "r2" },
    });
    const draftId = draft!.draftId as string;
    expect(draft).toMatchObject({ environmentId: "env", projectId: "p1" });

    // A second project connects: the route still opens on the first.
    expect(openedProject(draftId, [p1, p2])).toMatchObject({
      kind: "open",
      flow: { projectKey: "env:p1", draftKey: draftId },
    });
    // The project is swapped: the route goes to the picker instead of
    // rebinding to whichever project is alone now.
    expect(openedProject(draftId, [p2])).toEqual({ kind: "missing" });
  });

  it("leaves a route with a choice to make, or an existing draft, alone", () => {
    setup(null);
    const choice = { draft: { requestId: "r3" } };
    expect(withOpenedNewTaskDraft(choice)).toBe(choice);
    const existing = { draft: { draftId: "new-task:existing", environmentId: "env" } };
    expect(withOpenedNewTaskDraft(existing)).toBe(existing);
  });
});
