import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { refreshBranchList } from "../../state/queries";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";

// Choosing a project re-reads its refs so the picker and defaults never start
// from a list cached before the user's last checkout.
export function refreshChosenProjectBranches(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): void {
  if (project.workspaceRoot === "") return;
  setPendingConnectionError(null);
  refreshBranchList({ environmentId: project.environmentId, cwd: project.workspaceRoot });
}

/**
 * Opening an existing new-task draft chooses its stamped project, so handlers
 * that navigate to a draft route call this alongside the navigation.
 */
export function refreshNewTaskDraftBranches(draftKey: string): void {
  const stamp = getComposerDraftSnapshot(draftKey).project;
  if (stamp === undefined) return;
  const project = appAtomRegistry
    .get(environmentProjects.projectsAtom)
    .find(
      (candidate) =>
        candidate.environmentId === stamp.environmentId && candidate.id === stamp.projectId,
    );
  if (project !== undefined) refreshChosenProjectBranches(project);
}
