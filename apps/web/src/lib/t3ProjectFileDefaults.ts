import {
  DEFAULT_SERVER_SETTINGS,
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
import { environmentSession } from "~/state/session";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";

/**
 * Read and decode the project's checked-in `t3.json`.
 *
 * Imperative counterpart to `useT3ProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
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

/** Finish a landing draft's workspace defaults without replacing its editor or content. */
export async function completeDraftWorkspaceDefaults(draftId: DraftId): Promise<void> {
  const store = useComposerDraftStore.getState();
  const draft = store.getDraftSession(draftId);
  if (!draft?.workspaceDefaultsPending) return;
  const project = readProject(scopeProjectRef(draft.environmentId, draft.projectId));
  if (project === null) return;
  const projectFile = await readT3ProjectFile(project.environmentId, project.workspaceRoot);
  const current = store.getDraftSession(draftId);
  if (
    !current?.workspaceDefaultsPending ||
    current.environmentId !== draft.environmentId ||
    current.projectId !== draft.projectId ||
    readProject(scopeProjectRef(draft.environmentId, draft.projectId)) === null
  )
    return;
  const config = appAtomRegistry.get(
    environmentSession.initialConfigValueAtom(draft.environmentId),
  );
  const projectSettings = resolveProjectSettings(
    config?.settings ?? DEFAULT_SERVER_SETTINGS,
    project.id,
    project,
    projectFile,
  );
  const envMode = resolveNewThreadEnvMode({
    projectSettings,
    workspaceRoot: project.workspaceRoot,
    newProjectsRoot: config?.newProjectsRoot,
    projectHasThreads: readThreadShells().some(
      (thread) =>
        thread.environmentId === draft.environmentId && thread.projectId === draft.projectId,
    ),
  });
  store.setDraftThreadContext(draftId, {
    envMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode,
      newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
    }),
    workspaceDefaultsPending: false,
  });
}
