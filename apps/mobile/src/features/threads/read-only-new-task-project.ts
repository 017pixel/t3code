import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping.logic";
import { environmentProjects } from "../../state/projects";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { onlyNewTaskProject } from "./new-task-project-selection";

/** The project a draft route naming none opens with, read at use time. */
export function readOnlyNewTaskProject(): EnvironmentProject | null {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  const { sidebarProjectGroupingMode } = AsyncResult.isSuccess(preferences)
    ? resolveMobileProjectGroupingSettings(preferences.value)
    : DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS;
  return onlyNewTaskProject(
    buildHomeProjectScopes({
      projects: appAtomRegistry.get(environmentProjects.projectsAtom),
      environmentId: null,
      projectGroupingMode: sidebarProjectGroupingMode,
    }),
  );
}
