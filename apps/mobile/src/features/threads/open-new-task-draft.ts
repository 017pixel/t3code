import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { createNewTaskDraft } from "../../state/use-composer-drafts";
import { refreshNewTaskDraftBranches } from "./new-task-project-branches";
import { readOnlyNewTaskProject } from "./read-only-new-task-project";
import type { NewTaskDraftRouteParams } from "./thread-route-state";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * A new-task route that names a project, or opens while there is only one, gets
 * its own stamped draft before it is shown, so composer writes land in a draft
 * the home list can reopen. With no project and a choice, the picker decides.
 */
export function withOpenedNewTaskDraft<Params extends { readonly draft?: NewTaskDraftRouteParams }>(
  params: Params,
): Params {
  const draft = params.draft;
  if (draft === undefined || first(draft.draftId)) return params;
  const environmentId = first(draft.environmentId);
  const projectId = first(draft.projectId);
  const onlyProject = environmentId && projectId ? null : readOnlyNewTaskProject();
  const project =
    environmentId && projectId
      ? { environmentId: EnvironmentId.make(environmentId), projectId: ProjectId.make(projectId) }
      : onlyProject && { environmentId: onlyProject.environmentId, projectId: onlyProject.id };
  if (!project) return params;
  const draftId = createNewTaskDraft(project);
  // A project that has not loaded yet has no cached refs to go stale; its
  // first branch query reads them from the server.
  refreshNewTaskDraftBranches(draftId);
  return {
    ...params,
    draft: {
      ...draft,
      draftId,
      environmentId: String(project.environmentId),
      projectId: String(project.projectId),
    },
  };
}
