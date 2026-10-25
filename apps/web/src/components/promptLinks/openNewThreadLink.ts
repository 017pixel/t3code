import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { getCloneDestinationPath } from "@t3tools/client-runtime/operations/projects";
import {
  findPromptLinkProject,
  findPromptLinkPullRequestThread,
  resolvePromptLinkModelSelection,
} from "@t3tools/client-runtime/prompt-links";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type NewThreadLink,
  type PromptLinkRepository,
  parseNewThreadLink,
  promptLinkPullRequestUrl,
} from "@t3tools/shared/promptLinks";
import { useSyncExternalStore } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { createNewThreadHandler } from "~/hooks/useHandleNewThread";
import { createRouterScratchProject } from "~/hooks/useScratchProject";
import { newProjectId } from "~/lib/utils";
import type { AppRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects, readThreadShells, waitForProject } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { allReachableShellsLiveAtom } from "~/state/shell";
import { sourceControlEnvironment } from "~/state/sourceControl";

import { getFirstRunGateView, subscribeFirstRunGate } from "../onboarding/firstRunGateStore";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  isHostedPromptLinkLandingShowing,
  subscribeHostedPromptLinkLanding,
} from "./HostedPromptLinkLanding";
import { placeLinkedPrompt, warnAboutHiddenCharacters } from "./linkedPrompt";

export type NewThreadLinkState =
  | { readonly status: "opening" }
  | { readonly status: "opened" }
  | { readonly status: "failed"; readonly message: string; readonly title?: string }
  | { readonly status: "missing-repository"; readonly repository: PromptLinkRepository }
  | { readonly status: "pull-request-checkout"; readonly project: EnvironmentProject };

export type NewThreadLinkDecision =
  | { readonly kind: "thread"; readonly thread: EnvironmentThreadShell }
  | { readonly kind: "scratch" }
  | { readonly kind: "draft"; readonly project: EnvironmentProject }
  | { readonly kind: "missing-repository"; readonly repository: PromptLinkRepository }
  | { readonly kind: "pull-request-checkout"; readonly project: EnvironmentProject };

/** Where a link opens, from the workspace as it stands once every reachable shell is live. */
function decideNewThreadLink(
  link: NewThreadLink,
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): NewThreadLinkDecision {
  if (link.kind === "pull-request") {
    const thread = findPromptLinkPullRequestThread(threads, link.pullRequest);
    if (thread !== undefined) return { kind: "thread", thread };
  }
  const repository = link.kind === "new" ? link.repository : link.pullRequest;
  if (repository === null) return { kind: "scratch" };
  const recentProjects = sortScopedProjectsForSidebar(
    projects.filter((project) => project.isScratch !== true),
    threads,
    "updated_at",
  );
  const project = findPromptLinkProject(recentProjects, repository);
  if (project === undefined) return { kind: "missing-repository", repository };
  return link.kind === "pull-request"
    ? { kind: "pull-request-checkout", project }
    : { kind: "draft", project };
}

// Keyed by history entry, so returning to a link that already opened says so instead of
// opening it twice.
const states = new Map<string, NewThreadLinkState>();
const listeners = new Set<() => void>();
const OPENING: NewThreadLinkState = { status: "opening" };

function setLinkState(locationKey: string, next: NewThreadLinkState | null): void {
  if (next === null) states.delete(locationKey);
  else states.set(locationKey, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNewThreadLinkState(locationKey: string): NewThreadLinkState {
  const read = () => states.get(locationKey) ?? OPENING;
  return useSyncExternalStore(subscribe, read, read);
}

export function newThreadLinkLocationKey(location: {
  readonly href: string;
  readonly state: { readonly __TSR_key?: string };
}): string {
  return location.state.__TSR_key ?? location.href;
}

interface NewThreadLinkActions {
  readonly reopen: (locationKey: string) => void;
  readonly openWithoutProject: (locationKey: string, link: NewThreadLink) => void;
  readonly cloneRepository: (
    locationKey: string,
    link: NewThreadLink,
    repository: PromptLinkRepository,
  ) => void;
}

let actions: NewThreadLinkActions | null = null;

export function reopenNewThreadLink(locationKey: string): void {
  actions?.reopen(locationKey);
}

export function openNewThreadLinkWithoutProject(locationKey: string, link: NewThreadLink): void {
  actions?.openWithoutProject(locationKey, link);
}

export function cloneNewThreadLinkRepository(
  locationKey: string,
  link: NewThreadLink,
  repository: PromptLinkRepository,
): void {
  actions?.cloneRepository(locationKey, link, repository);
}

/**
 * Opens a /new link once per history entry, as soon as the app shell shows it and every
 * reachable shell is live. A link never starts the pull-request checkout on its own: that runs
 * the project's setup script on the pull request's code, so the page asks first.
 */
export function startNewThreadLinks(router: AppRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);
  const scratch = createRouterScratchProject(router);

  const lastActiveEnvironmentId = () => {
    let latest: EnvironmentThreadShell | undefined;
    for (const thread of readThreadShells()) {
      if (latest === undefined || thread.updatedAt > latest.updatedAt) latest = thread;
    }
    return latest?.environmentId ?? appAtomRegistry.get(primaryEnvironmentIdAtom);
  };

  const openDraft = async (
    key: string,
    link: NewThreadLink,
    project: EnvironmentProject,
    extraPrompt?: string,
  ) => {
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      replace: true,
    }).catch(() => null);
    if (opened === null) {
      setLinkState(key, { status: "failed", message: "T3 Code could not open a new thread." });
      return;
    }
    setLinkState(key, { status: "opened" });
    const notes: Array<string> = [];
    if (link.kind === "new" && link.provider !== null) {
      const providers =
        appAtomRegistry
          .get(environmentPresentations.providersByEnvironmentAtom)
          .get(project.environmentId) ?? [];
      const resolved = resolvePromptLinkModelSelection(providers, {
        provider: link.provider,
        model: link.model,
      });
      if (resolved !== null) {
        useComposerDraftStore.getState().setModelSelection(opened.draftId, resolved.selection, {
          explicit: true,
          replaceOptions: true,
        });
      }
      if (resolved === null || !resolved.exact) {
        notes.push(
          resolved === null
            ? `The link asked for ${link.provider}, which is not set up here, so your default model is used.`
            : `The link asked for ${link.model}, which ${link.provider} does not offer here, so its default model is used.`,
        );
      }
    }
    const text = [link.prompt?.text, extraPrompt].filter(Boolean).join("\n\n");
    if (text.length === 0) return;
    placeLinkedPrompt(
      opened.draftId,
      { text, hiddenCharacters: link.prompt?.hiddenCharacters ?? 0 },
      notes,
    );
  };

  const openScratchDraft = async (key: string, link: NewThreadLink) => {
    const environmentId =
      scratch.scratchEnvironmentId(lastActiveEnvironmentId()) ?? scratch.scratchEnvironmentId(null);
    const project = environmentId === null ? null : await scratch.openScratchProject(environmentId);
    if (project === null) {
      setLinkState(key, {
        status: "failed",
        message: "None of your machines can start a thread without a project right now.",
      });
      return;
    }
    await openDraft(
      key,
      link,
      project,
      link.kind === "pull-request" ? promptLinkPullRequestUrl(link.pullRequest) : undefined,
    );
  };

  const cloneRepository = async (
    key: string,
    link: NewThreadLink,
    repository: PromptLinkRepository,
  ) => {
    const environmentId = lastActiveEnvironmentId();
    const serverConfig =
      environmentId === null
        ? null
        : (appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)
            ?.serverConfig ?? null);
    const newProjectsRoot = serverConfig?.newProjectsRoot ?? null;
    if (
      environmentId === null ||
      newProjectsRoot === null ||
      serverConfig?.environment.capabilities.projectCloneTracking !== true
    ) {
      setLinkState(key, {
        status: "failed",
        message:
          "This machine cannot clone from a link. Update T3 Code on it, or clone the repository from the command palette.",
      });
      return;
    }
    setLinkState(key, OPENING);
    const projectId = newProjectId();
    const command = sourceControlEnvironment.startProjectClone;
    const result = await runAtomCommand(
      appAtomRegistry,
      command,
      {
        environmentId,
        input: {
          projectId,
          title: repository.name,
          createdAt: new Date().toISOString(),
          remoteUrl: `https://github.com/${repository.owner}/${repository.name}.git`,
          destinationPath: getCloneDestinationPath(newProjectsRoot, repository.name),
        },
      },
      { label: command.label, reportFailure: false },
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      setLinkState(key, { status: "missing-repository", repository });
      return;
    }
    const project = await waitForProject(scopeProjectRef(environmentId, projectId), 5_000).catch(
      () => null,
    );
    if (project === null) {
      setLinkState(key, {
        status: "failed",
        message: "The clone started, but its project did not appear.",
      });
      return;
    }
    if (link.kind === "pull-request") {
      setLinkState(key, {
        status: "failed",
        title: `Cloning ${repository.owner}/${repository.name}`,
        message: "Open this link again when the clone finishes.",
      });
      return;
    }
    await openDraft(key, link, project);
  };

  const launch = (key: string, link: NewThreadLink) => {
    const decision = decideNewThreadLink(link, readProjects(), readThreadShells());
    switch (decision.kind) {
      case "thread": {
        setLinkState(key, { status: "opened" });
        const { thread } = decision;
        if (link.prompt !== null) {
          placeLinkedPrompt(scopeThreadRef(thread.environmentId, thread.id), link.prompt);
        }
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
          replace: true,
        });
        return;
      }
      case "scratch":
        void openScratchDraft(key, link);
        return;
      case "draft":
        void openDraft(key, link, decision.project);
        return;
      case "missing-repository":
        setLinkState(key, { status: "missing-repository", repository: decision.repository });
        return;
      case "pull-request-checkout":
        if (link.prompt !== null) warnAboutHiddenCharacters(link.prompt);
        setLinkState(key, { status: "pull-request-checkout", project: decision.project });
    }
  };

  // Entries that have started; a state alone cannot say so, since "opening" also covers a
  // launch that is still waiting for the workspace.
  const started = new Set<string>();

  const sync = () => {
    const location = router.state.location;
    if (location.pathname !== "/new") return;
    const key = newThreadLinkLocationKey(location);
    if (started.has(key) || states.has(key)) return;
    const gate = getFirstRunGateView().kind;
    if (gate !== "app" && gate !== "wizard") return;
    const hosted = router.state.matches[0]?.context.authGateState?.status === "hosted-static";
    if (isHostedPromptLinkLandingShowing(hosted, location.href)) return;
    if (!appAtomRegistry.get(allReachableShellsLiveAtom)) return;
    const parsed = parseNewThreadLink(location.searchStr);
    if (!parsed.ok) return;
    started.add(key);
    launch(key, parsed.value);
  };

  actions = {
    reopen: (key) => {
      started.delete(key);
      setLinkState(key, null);
      sync();
    },
    openWithoutProject: (key, link) => {
      setLinkState(key, OPENING);
      void openScratchDraft(key, link);
    },
    cloneRepository: (key, link, repository) => void cloneRepository(key, link, repository),
  };

  const unsubscribers = [
    router.subscribe("onResolved", sync),
    subscribeFirstRunGate(sync),
    subscribeHostedPromptLinkLanding(sync),
    appAtomRegistry.subscribe(allReachableShellsLiveAtom, sync),
  ];
  sync();
  return () => {
    actions = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
