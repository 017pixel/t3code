import * as Dialog from "../../components/ui/Dialog";
import {
  StackActions,
  type NavigationState,
  type PartialState,
  type StackActionType,
} from "@react-navigation/native";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  findPromptLinkProject,
  findPromptLinkPullRequestThread,
  resolvePromptLinkModelSelection,
} from "@t3tools/client-runtime/prompt-links";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  parseNewThreadLink,
  type LinkedPrompt,
  type PromptLinkPullRequest,
  type PromptLinkRepository,
} from "@t3tools/shared/promptLinks";
import { Atom } from "effect/reactivity";

import { findLinkedRoute, updateLinkedRoute } from "../../lib/appLinking";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { composerPullRequests } from "../../state/pull-requests";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import {
  createNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { workspaceConnections, workspaceStateAtom } from "../../state/workspace";
import {
  INACTIVE_FLOW_KEY,
  newTaskFlowKey,
  readNewTaskFlowState,
} from "../threads/new-task-flow-state";
import { refreshNewTaskDraftBranches } from "../threads/new-task-project-branches";
import { isDraftThreadRoute } from "../threads/thread-route-state";
import { applyLinkedPromptToThreadDraft, showPromptLinkNotice } from "./prompt-link-actions";
import {
  promptLinkNotice,
  promptLinkRepositoryName,
  latestThreadEnvironmentIds,
  promptLinkScratchEnvironmentId,
  promptLinkSearchFromParams,
  stepPendingPromptLink,
  withoutPromptLinkParams,
  type PendingPromptLink,
} from "./prompt-link-model";

const NEW_TASK_ROUTES = ["NewTaskProject"];

type LinkedDraftRequest = {
  readonly prompt: LinkedPrompt | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly pullRequest: PromptLinkPullRequest | null;
};

// A cold launch from a link has no projects or threads yet. Matching then would offer to clone a
// repository the user already has.
const shellsSettledAtom = Atom.make((get) => {
  const workspace = get(workspaceStateAtom);
  return !(
    workspace.isLoadingConnections ||
    workspace.hasPendingShellSnapshot ||
    // A machine still connecting may hold the repository or thread. One that keeps failing to
    // reconnect has settled offline, and must not hold every link.
    workspace.connectingEnvironments.some(
      (environment) =>
        environment.connectionState === "connecting" || environment.connectionError === null,
    )
  );
}).pipe(Atom.withLabel("mobile:prompt-link-shells-settled"));

let pendingLink: PendingPromptLink | null = null;
let stopWaitingForShells: (() => void) | null = null;

/**
 * `new?prompt=…&repo=…` drops its params as it arrives, so the screen never sees them and each
 * opening resolves once. It resolves when its screen is on the stack and the shells have
 * settled; a newer link replaces one still waiting.
 */
export function takeNewTaskPromptLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  const route = findLinkedRoute(state, NEW_TASK_ROUTES);
  const search = promptLinkSearchFromParams(
    route?.params as Readonly<Record<string, unknown>> | undefined,
  );
  if (search === null) return state;
  pendingLink = { search, arrived: false };
  return updateLinkedRoute(state, NEW_TASK_ROUTES, (linked) => ({
    ...linked,
    params: withoutPromptLinkParams(linked.params),
  }));
}

/** Wired to the navigation container's state changes. */
export function resolvePendingNewTaskPromptLink(state: NavigationState | undefined): void {
  if (pendingLink === null) return;
  const step = stepPendingPromptLink(pendingLink, {
    screenOnStack: state?.routes.some((route) => route.name === "NewTaskProject") === true,
    shellsSettled: appAtomRegistry.get(shellsSettledAtom),
  });
  if (step.pending === null) dropPendingLink();
  else pendingLink = step.pending;
  if (step.resolve !== null) resolveLink(step.resolve);
  else if (step.pending?.arrived) {
    stopWaitingForShells ??= appAtomRegistry.subscribe(shellsSettledAtom, (settled) => {
      if (settled) resolvePendingNewTaskPromptLink(rootNavigationRef.getRootState());
    });
  }
}

function dropPendingLink(): void {
  pendingLink = null;
  stopWaitingForShells?.();
  stopWaitingForShells = null;
}

/** Dispatches as the new-task screen would, so `replace` swaps that screen out. */
function dispatchFromNewTask(action: StackActionType): void {
  const root = rootNavigationRef.getRootState();
  const source = root?.routes.findLast((route) => route.name === "NewTaskProject")?.key;
  rootNavigationRef.dispatch({
    ...action,
    ...(root ? { target: root.key } : {}),
    ...(source ? { source } : {}),
  });
}

function selectedEnvironmentId(): EnvironmentId | null {
  const root = rootNavigationRef.getRootState();
  const draftRoute = root?.routes.findLast(isDraftThreadRoute);
  const override = readNewTaskFlowState(
    (draftRoute && newTaskFlowKey(draftRoute)) ?? INACTIVE_FLOW_KEY,
  ).environmentId;
  const projects = appAtomRegistry.get(environmentProjects.projectsAtom);
  return override !== null && projects.some((project) => project.environmentId === override)
    ? override
    : (projects[0]?.environmentId ?? null);
}

function writeDraft(
  draftKey: string,
  environmentId: EnvironmentId,
  request: LinkedDraftRequest,
): boolean {
  if (request.prompt) setComposerDraftText(draftKey, request.prompt.text);
  if (request.provider === null) return false;
  const resolved = resolvePromptLinkModelSelection(
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.providers ?? [],
    { provider: request.provider, model: request.model },
  );
  if (resolved) updateComposerDraftSettings(draftKey, { modelSelection: resolved.selection });
  return resolved?.exact !== true;
}

async function openProjectDraft(project: EnvironmentProject, request: LinkedDraftRequest) {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Dialog.alert("Could not open link", "Drafts could not be loaded, so the prompt was not added.");
    return;
  }
  const draftKey = createNewTaskDraft({
    environmentId: project.environmentId,
    projectId: project.id,
  });
  let pullRequestUnavailable: number | null = null;
  if (request.pullRequest) {
    const detailAtom = composerPullRequests.detail({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        repository: promptLinkRepositoryName(request.pullRequest),
        number: request.pullRequest.number,
      },
    });
    const detail = await executeAtomQuery(appAtomRegistry, detailAtom, {
      label: detailAtom.label?.[0] ?? "atom query",
      reportFailure: false,
    });
    if (detail._tag === "Success") {
      updateComposerDraftSettings(draftKey, {
        workspaceSelection: {
          mode: "worktree",
          branch: detail.value.headBranch,
          worktreePath: null,
          startFromOrigin: false,
          pullRequestReference: detail.value.url,
        },
      });
    } else {
      pullRequestUnavailable = request.pullRequest.number;
    }
  }
  const modelUnavailable = writeDraft(draftKey, project.environmentId, request);
  refreshNewTaskDraftBranches(draftKey);
  dispatchFromNewTask(
    StackActions.push("Thread", {
      draft: {
        draftId: draftKey,
        title: request.pullRequest ? `PR #${request.pullRequest.number}` : project.title,
      },
    }),
  );
  if (request.prompt || pullRequestUnavailable !== null || modelUnavailable) {
    showPromptLinkNotice(
      promptLinkNotice({
        hiddenCharacters: request.prompt?.hiddenCharacters ?? 0,
        modelUnavailable,
        pullRequestUnavailable,
      }),
    );
  }
}

async function openScratchDraft(request: LinkedDraftRequest) {
  const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
  const environmentId = promptLinkScratchEnvironmentId(
    latestThreadEnvironmentIds(appAtomRegistry.get(environmentThreadShells.threadShellsAtom)),
    appAtomRegistry
      .get(workspaceConnections.environmentsAtom)
      .filter(
        (environment) =>
          availableScratchWorkspaceRoot(
            environment.connectionState,
            serverConfigs.get(environment.environmentId),
          ) !== null,
      )
      .map((environment) => environment.environmentId),
  );
  if (environmentId === null) {
    Dialog.alert(
      "Could not start without a project",
      "No connected environment offers threads without a project.",
    );
    return;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.openScratch,
    { environmentId, input: {} },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not start without a project",
        error instanceof Error
          ? error.message
          : "The folder for threads without a project could not be created.",
      );
    }
    return;
  }
  await openProjectDraft(result.value, { ...request, pullRequest: null });
}

function cloneRepository(repository: PromptLinkRepository, request: LinkedDraftRequest) {
  const environmentId =
    selectedEnvironmentId() ??
    appAtomRegistry.get(workspaceConnections.environmentsAtom)[0]?.environmentId ??
    null;
  if (environmentId === null) {
    Dialog.alert("Could not clone", "Connect an environment first.");
    return;
  }
  const prompt =
    request.pullRequest === null &&
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .projectCloneTracking === true
      ? request.prompt
      : null;
  const name = promptLinkRepositoryName(repository);
  dispatchFromNewTask(
    StackActions.push("AddProjectDestination", {
      environmentId,
      remoteUrl: `https://github.com/${name}.git`,
      repositoryTitle: name,
      repositoryName: repository.name,
      ...(prompt ? { prompt: prompt.text } : {}),
    }),
  );
  if (!request.prompt) return;
  showPromptLinkNotice(
    [
      promptLinkNotice({
        hiddenCharacters: request.prompt.hiddenCharacters,
        modelUnavailable: prompt !== null && request.provider !== null,
      }),
      prompt
        ? "The prompt opens in a new task once the clone starts."
        : "Open the link again after the clone to get the prompt.",
    ].join("\n\n"),
  );
}

function resolveLink(linkSearch: string) {
  const threads = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
  const parsed = parseNewThreadLink(linkSearch);
  if (!parsed.ok) {
    Dialog.alert("Could not open link", parsed.error);
    return;
  }
  const link = parsed.value;
  const request: LinkedDraftRequest =
    link.kind === "new"
      ? { prompt: link.prompt, provider: link.provider, model: link.model, pullRequest: null }
      : { prompt: link.prompt, provider: null, model: null, pullRequest: link.pullRequest };

  if (link.kind === "pull-request") {
    const thread = findPromptLinkPullRequestThread(threads, link.pullRequest);
    if (thread) {
      dispatchFromNewTask(
        StackActions.replace("Thread", {
          environmentId: String(thread.environmentId),
          threadId: String(thread.id),
        }),
      );
      if (link.prompt) {
        void applyLinkedPromptToThreadDraft(
          scopedThreadKey(thread.environmentId, thread.id),
          link.prompt,
          promptLinkNotice({ hiddenCharacters: link.prompt.hiddenCharacters }),
        );
      }
      return;
    }
  }

  const repository = link.kind === "new" ? link.repository : link.pullRequest;
  if (repository === null) {
    void openScratchDraft(request);
    return;
  }
  const lastActivity = new Map<string, string>();
  for (const thread of threads) {
    const key = `${thread.environmentId}:${thread.projectId}`;
    if (thread.updatedAt > (lastActivity.get(key) ?? "")) lastActivity.set(key, thread.updatedAt);
  }
  const activityOf = (project: EnvironmentProject) =>
    lastActivity.get(`${project.environmentId}:${project.id}`) ?? "";
  const project = findPromptLinkProject(
    [...appAtomRegistry.get(environmentProjects.projectsAtom)].sort((left, right) =>
      activityOf(right).localeCompare(activityOf(left)),
    ),
    repository,
  );
  if (project) {
    void openProjectDraft(project, request);
    return;
  }
  Dialog.alert(`You don't have ${promptLinkRepositoryName(repository)}`, undefined, [
    { text: "Cancel", style: "cancel" },
    ...(request.prompt
      ? [{ text: "Use without project", onPress: () => void openScratchDraft(request) }]
      : []),
    { text: "Clone", onPress: () => cloneRepository(repository, request) },
  ]);
}
