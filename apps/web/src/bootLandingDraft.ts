import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import {
  landingDraftContext,
  readPendingLandingDraft,
  setPendingLandingDraft,
} from "./bootLanding";
import { readBootSnapshot } from "./bootSnapshot";
import { sortScopedProjectsForSidebar } from "./components/Sidebar.logic";
import {
  composerDraftHasUserContent,
  type DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "./composerDraftStore";
import { resolveNewDraftStartFromOrigin } from "./lib/chatThreadActions";
import { newDraftId, newThreadId } from "./lib/utils";
import { ensureClientSettingsHydrated, getClientSettings } from "./hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "./logicalProject";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readProjects, readThreadShell } from "./state/entities";
import { allEnvironmentShellsBootstrappedAtom } from "./state/shell";
import { environmentThreadShells } from "./state/threads";

/**
 * The draft the index route can open right away, or null when it must wait
 * for the server: no boot snapshot or no project yet. Like the new-thread
 * handler, it reuses the most recent project's empty draft or mints one; a
 * minted draft starts from the cached settings until the real defaults land.
 */
export async function resolveLandingDraft(): Promise<DraftId | null> {
  const pending = readPendingLandingDraft();
  if (pending !== null) return pending.draftId;
  if (readBootSnapshot() === null || !appAtomRegistry.get(allEnvironmentShellsBootstrappedAtom)) {
    return null;
  }
  const project =
    sortScopedProjectsForSidebar(
      readProjects(),
      appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
      "updated_at",
    )[0] ?? null;
  if (project === null) return null;
  // The draft is keyed by the user's project grouping.
  await ensureClientSettingsHydrated().catch(() => undefined);
  const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
    project,
    selectProjectGroupingSettings(getClientSettings()),
  );
  const projectRef = scopeProjectRef(project.environmentId, project.id);
  const store = useComposerDraftStore.getState();
  const stored = store.getDraftSessionByLogicalProjectKey(logicalProjectKey);
  const storedRef = stored ? scopeThreadRef(stored.environmentId, stored.threadId) : null;
  const storedPromoted = storedRef !== null && readThreadShell(storedRef) !== null;
  if (storedRef !== null && stored?.promotedTo == null && storedPromoted) {
    markPromotedDraftThreadByRef(storedRef);
  }
  let draftId: DraftId;
  if (
    stored !== null &&
    stored.promotedTo == null &&
    !storedPromoted &&
    !composerDraftHasUserContent(store.getComposerDraft(stored.draftId))
  ) {
    draftId = stored.draftId;
  } else {
    // A draft with typed text stays where it is; a new one opens beside it.
    const settings = resolveProjectSettings(
      readBootSnapshot()?.serverConfigs.get(project.environmentId)?.settings ??
        DEFAULT_SERVER_SETTINGS,
      project.id,
      project,
      null,
    ).settings;
    draftId = newDraftId();
    store.setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
      threadId: newThreadId(),
      createdAt: new Date().toISOString(),
      branch: null,
      worktreePath: null,
      envMode: settings.defaultThreadEnvMode,
      startFromOrigin: resolveNewDraftStartFromOrigin({
        envMode: settings.defaultThreadEnvMode,
        newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
      }),
      runtimeMode: settings.defaultRuntimeMode,
    });
    store.applyStickyState(draftId);
  }
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  if (draft === null) return null;
  setPendingLandingDraft({ draftId, projectRef, openedWith: landingDraftContext(draft) });
  return draftId;
}
