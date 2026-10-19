import {
  AuthFilesystemReadScope,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { readProject, readThreadShells } from "~/state/entities";
import { environmentSession, readEnvironmentScope } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
} from "./chatThreadActions";

export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}

export async function completeDraftWorkspaceDefaults(draftId: DraftId): Promise<void> {
  const store = useComposerDraftStore.getState();
  const draft = store.getDraftSession(draftId);
  if (!draft?.workspaceDefaultsPending || draft.promotedTo) return;
  const projectRef = scopeProjectRef(draft.environmentId, draft.projectId);
  const project = readProject(projectRef);
  const sessionConfig = appAtomRegistry.get(
    environmentSession.initialConfigValueAtom(draft.environmentId),
  );
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(draft.environmentId));
  if (project === null || sessionConfig === null || config === null) return;
  const projectFile =
    !draft.workspaceSelectionExplicit &&
    resolveProjectSettings(config.settings, project.id, project).settings.defaultThreadEnvMode ===
      null &&
    readEnvironmentScope(draft.environmentId, AuthFilesystemReadScope)
      ? await readT3ProjectFile(project.environmentId, project.workspaceRoot).catch(() => null)
      : null;
  const current = store.getDraftSession(draftId);
  const currentProject = readProject(projectRef);
  const currentConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(draft.environmentId));
  if (
    !current?.workspaceDefaultsPending ||
    current.promotedTo ||
    current.environmentId !== draft.environmentId ||
    current.projectId !== draft.projectId ||
    currentProject === null ||
    currentProject.workspaceRoot !== project.workspaceRoot ||
    currentConfig === null
  )
    return;
  const projectSettings = resolveProjectSettings(
    currentConfig.settings,
    currentProject.id,
    currentProject,
    projectFile,
  );
  // Re-read choices after the file lookup: the composer stays editable while it runs.
  if (!hasExplicitComposerModelSelection(store.getComposerDraft(draftId))) {
    store.applyStickyState(draftId);
    if (projectSettings.settings.defaultModelSelection) {
      store.setModelSelection(draftId, projectSettings.settings.defaultModelSelection, {
        replaceOptions: true,
      });
    }
  }
  const envMode = resolveNewThreadEnvMode({
    projectSettings,
    workspaceRoot: currentProject.workspaceRoot,
    newProjectsRoot: currentConfig.newProjectsRoot,
    projectHasThreads: readThreadShells().some(
      (thread) =>
        thread.environmentId === draft.environmentId && thread.projectId === draft.projectId,
    ),
  });
  store.setDraftThreadContext(draftId, {
    ...(!current.workspaceSelectionExplicit
      ? {
          envMode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode,
            newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
          }),
        }
      : {}),
    workspaceDefaultsPending: false,
  });
}
