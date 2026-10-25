import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  INITIAL_NEW_TASK_FLOW_STATE,
  newTaskFlowKey,
  newTaskFlowStateAtom,
  pruneNewTaskFlowStates,
  readNewTaskFlowState,
  resolveRouteDraft,
  resolveRouteProject,
  routeNewTaskDraftKey,
  updateNewTaskFlowState,
} from "./new-task-flow-state";
import { parseLegacyNewTaskDraftKey } from "../../state/new-task-draft-key";

function draftRoute(key: string, draftId: string) {
  return { key, name: "Thread", params: { draft: { draftId } } };
}

describe("new task flow state", () => {
  it("keeps a covered draft route's flow while another draft route is pushed above it", () => {
    const routeA = draftRoute("route-a", "draft-a");
    const routeB = draftRoute("route-b", "draft-b");
    const flowA = newTaskFlowKey(routeA)!;
    const flowB = newTaskFlowKey(routeB)!;

    // The provider subscribes to A, writes its selection, then moves to B.
    const unmountA = appAtomRegistry.mount(newTaskFlowStateAtom(flowA));
    updateNewTaskFlowState(flowA, { projectKey: "env:project-a", draftKey: "draft-a" });
    unmountA();
    const unmountB = appAtomRegistry.mount(newTaskFlowStateAtom(flowB));
    pruneNewTaskFlowStates({ routes: [{ key: "home", name: "Home" }, routeA, routeB] });

    expect(readNewTaskFlowState(flowB)).toBe(INITIAL_NEW_TASK_FLOW_STATE);
    expect(appAtomRegistry.get(newTaskFlowStateAtom(flowA))).toMatchObject({
      projectKey: "env:project-a",
      draftKey: "draft-a",
    });

    // Popping B returns to A with its state intact.
    unmountB();
    pruneNewTaskFlowStates({ routes: [{ key: "home", name: "Home" }, routeA] });
    expect(readNewTaskFlowState(flowA).projectKey).toBe("env:project-a");
  });

  it("drops a flow when its route is popped or promoted to a live thread", () => {
    const routeA = draftRoute("route-a", "draft-a");
    const routeB = draftRoute("route-b", "draft-b");
    updateNewTaskFlowState(newTaskFlowKey(routeA)!, { projectKey: "env:project-a" });
    updateNewTaskFlowState(newTaskFlowKey(routeB)!, { projectKey: "env:project-b" });

    pruneNewTaskFlowStates({
      routes: [{ key: "route-a", name: "Thread", params: { environmentId: "env", threadId: "t" } }],
    });

    expect(readNewTaskFlowState(newTaskFlowKey(routeA)!)).toBe(INITIAL_NEW_TASK_FLOW_STATE);
    expect(readNewTaskFlowState(newTaskFlowKey(routeB)!)).toBe(INITIAL_NEW_TASK_FLOW_STATE);
  });
});

describe("resolveRouteDraft", () => {
  const environmentId = EnvironmentId.make("env");
  const projectId = ProjectId.make("project");
  const stamp = { environmentId, projectId };
  const project = { environmentId, id: projectId };
  const base = {
    flow: INITIAL_NEW_TASK_FLOW_STATE,
    routeDraftId: "new-task:draft-1",
    draftsLoaded: true,
    stamp,
    projects: [project],
  };

  it("binds the route's draft and its stamped project", () => {
    expect(resolveRouteDraft(base)).toEqual({
      kind: "open",
      flow: {
        ...INITIAL_NEW_TASK_FLOW_STATE,
        environmentId,
        projectKey: "env:project",
        draftKey: "new-task:draft-1",
      },
    });
  });

  it("leaves a flow that already bound a draft alone", () => {
    const flow = { ...INITIAL_NEW_TASK_FLOW_STATE, draftKey: "new-task:other" };
    expect(resolveRouteDraft({ ...base, flow })).toEqual({ kind: "none" });
  });

  it("waits for hydration, and for projects while none have loaded", () => {
    expect(resolveRouteDraft({ ...base, draftsLoaded: false, stamp: undefined })).toEqual({
      kind: "pending",
    });
    expect(resolveRouteDraft({ ...base, projects: [] })).toEqual({ kind: "pending" });
  });

  it("reports a draft that is gone or whose project is gone", () => {
    expect(resolveRouteDraft({ ...base, stamp: undefined })).toEqual({ kind: "missing" });
    expect(
      resolveRouteDraft({ ...base, projects: [{ environmentId, id: ProjectId.make("other") }] }),
    ).toEqual({ kind: "missing" });
  });
});

describe("resolveRouteProject", () => {
  const environmentId = EnvironmentId.make("env");
  const project = { environmentId, id: ProjectId.make("project") };
  const other = { environmentId, id: ProjectId.make("other") };
  const base = {
    flow: INITIAL_NEW_TASK_FLOW_STATE,
    routeProject: { environmentId: "env", projectId: "project" },
    draftKey: "new-task:route-1",
    projects: [project, other],
  };
  const opened = (projectKey: string) => ({
    kind: "open",
    flow: {
      ...INITIAL_NEW_TASK_FLOW_STATE,
      environmentId,
      projectKey,
      draftKey: "new-task:route-1",
    },
  });

  it("binds the route's project to the route's draft", () => {
    expect(resolveRouteProject(base)).toEqual(opened("env:project"));
  });

  it("sends a route with no project to choose, or a gone project, to the picker", () => {
    expect(resolveRouteProject({ ...base, routeProject: undefined })).toEqual({
      kind: "missing",
    });
    expect(
      resolveRouteProject({ ...base, routeProject: { environmentId: "env", projectId: "gone" } }),
    ).toEqual({ kind: "missing" });
  });

  it("waits for projects to load before calling the route's project gone", () => {
    expect(resolveRouteProject({ ...base, projects: [] })).toEqual({ kind: "pending" });
  });

  it("leaves a flow the user already chose alone", () => {
    const flow = { ...INITIAL_NEW_TASK_FLOW_STATE, environmentId, projectKey: "env:other" };
    expect(resolveRouteProject({ ...base, flow })).toEqual({ kind: "none" });
  });
});

describe("routeNewTaskDraftKey", () => {
  it("is not mistaken for a legacy new-task:<env>:<project> key on hydration", () => {
    const route = { key: "route-link", name: "Thread", params: { draft: { requestId: "link" } } };
    expect(parseLegacyNewTaskDraftKey(routeNewTaskDraftKey(newTaskFlowKey(route)!))).toBeNull();
  });
});
