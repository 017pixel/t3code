import type { AnyRouter } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  projectCloneDisplayName,
  projectCloneProgressSummary,
  type EnvironmentId,
  type ProjectCloneSnapshot,
  type ProjectId,
} from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { createNewThreadHandler } from "../hooks/useHandleNewThread";
import { createRemoveClonedProject } from "../hooks/useRemoveClonedProject";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import {
  environmentProjectClonesAtom,
  isProjectCloneToastSilenced,
  silenceProjectCloneToasts,
} from "../state/projectClones";
import { sourceControlEnvironment } from "../state/sourceControl";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { toastManager } from "./ui/toast";
import { stackedThreadToast } from "./ui/toastHelpers";

interface TrackedToast {
  readonly toastId: ReturnType<typeof toastManager.add>;
  readonly renderedKey: string;
  readonly phase: ProjectCloneSnapshot["phase"];
}

function renderKey(clone: ProjectCloneSnapshot): string {
  return `${clone.phase}:${clone.stage}:${clone.percent ?? ""}:${clone.detail ?? ""}:${clone.stalled === true}:${clone.error ?? ""}`;
}

async function runCloneAction(
  title: string,
  action: () => Promise<AtomCommandResult<unknown, unknown>>,
) {
  const result = await action();
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

interface CloneToastActions {
  readonly viewedDraft: () => { environmentId: EnvironmentId; projectId: ProjectId } | null;
  readonly openProject: (environmentId: EnvironmentId, projectId: ProjectId) => void;
  readonly removeClonedProject: ReturnType<typeof createRemoveClonedProject>;
}

function reconcileCloneToasts(
  environmentId: EnvironmentId,
  clones: ReadonlyArray<ProjectCloneSnapshot>,
  toasts: Map<ProjectId, TrackedToast>,
  actions: CloneToastActions,
) {
  const viewedDraft = actions.viewedDraft();
  const seen = new Set<ProjectId>();
  for (const clone of clones) {
    seen.add(clone.projectId);
    const key = renderKey(clone);
    const tracked = toasts.get(clone.projectId);
    const name = projectCloneDisplayName(clone);
    const closeToast = () => {
      const current = toasts.get(clone.projectId);
      if (!current) return;
      toastManager.close(current.toastId);
      toasts.delete(clone.projectId);
    };
    const ref = { environmentId, projectId: clone.projectId };
    if (viewedDraft?.environmentId === environmentId && viewedDraft.projectId === clone.projectId) {
      silenceProjectCloneToasts(ref);
      closeToast();
      continue;
    }
    if (tracked?.renderedKey === key) continue;
    if (isProjectCloneToastSilenced(ref) && (clone.phase === "running" || clone.phase === "done")) {
      closeToast();
      continue;
    }

    if (clone.phase === "running") {
      const options = stackedThreadToast({
        type: "loading",
        title: `Cloning ${name}`,
        description: projectCloneProgressSummary(clone),
        timeout: 0,
        actionProps: {
          children: "Cancel",
          onClick: () => {
            void runCloneAction("Failed to cancel clone", () =>
              runAtomCommand(
                appAtomRegistry,
                sourceControlEnvironment.cancelProjectClone,
                { environmentId, input: { projectId: clone.projectId } },
                { reportFailure: false },
              ),
            );
          },
        },
        data: { hideCopyButton: true },
      });
      if (tracked) {
        toastManager.update(tracked.toastId, options);
        toasts.set(clone.projectId, { ...tracked, renderedKey: key, phase: "running" });
      } else {
        const toastId = toastManager.add(options);
        toasts.set(clone.projectId, { toastId, renderedKey: key, phase: "running" });
      }
      continue;
    }

    if (clone.phase === "done") {
      const options = stackedThreadToast({
        type: "success",
        title: `Cloned ${name}`,
        description: clone.destinationPath,
        timeout: 8_000,
        actionProps: {
          children: "Open project",
          onClick: () => {
            closeToast();
            actions.openProject(environmentId, clone.projectId);
          },
        },
        data: { hideCopyButton: true },
      });
      if (tracked) {
        toastManager.update(tracked.toastId, options);
        toasts.set(clone.projectId, { ...tracked, renderedKey: key, phase: "done" });
      } else {
        const toastId = toastManager.add(options);
        toasts.set(clone.projectId, { toastId, renderedKey: key, phase: "done" });
      }
      continue;
    }

    const cancelled = clone.phase === "cancelled";
    const options = stackedThreadToast({
      type: cancelled ? "info" : "error",
      title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
      description: cancelled ? clone.destinationPath : (clone.error ?? "The clone failed."),
      timeout: 0,
      actionProps: {
        children: "Retry",
        onClick: () => {
          void runCloneAction("Failed to retry clone", () =>
            runAtomCommand(
              appAtomRegistry,
              sourceControlEnvironment.retryProjectClone,
              { environmentId, input: { projectId: clone.projectId } },
              { reportFailure: false },
            ),
          );
        },
      },
      data: {
        ...(cancelled ? { hideCopyButton: true } : {}),
        secondaryActionProps: {
          children: "Remove project",
          onClick: () => {
            void actions.removeClonedProject({ environmentId, projectId: clone.projectId });
          },
        },
      },
    });
    if (tracked) {
      toastManager.update(tracked.toastId, options);
      toasts.set(clone.projectId, { ...tracked, renderedKey: key, phase: clone.phase });
    } else {
      const toastId = toastManager.add(options);
      toasts.set(clone.projectId, { toastId, renderedKey: key, phase: clone.phase });
    }
  }

  for (const [projectId, tracked] of toasts) {
    if (seen.has(projectId)) continue;
    if (tracked.phase !== "done") toastManager.close(tracked.toastId);
    toasts.delete(projectId);
  }
}

interface EnvironmentCloneToasts {
  readonly toasts: Map<ProjectId, TrackedToast>;
  readonly unsubscribe: () => void;
}

/**
 * One toast per tracked clone on every environment, silenced while the user is looking at
 * the cloned project's draft.
 */
export function startProjectCloneToasts(router: AnyRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);
  const actions: CloneToastActions = {
    viewedDraft: () => {
      const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      if (target?.kind !== "draft") return null;
      const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
      return draft ? { environmentId: draft.environmentId, projectId: draft.projectId } : null;
    },
    openProject: (environmentId, projectId) => {
      void handleNewThread(scopeProjectRef(environmentId, projectId));
    },
    removeClonedProject: createRemoveClonedProject(router),
  };
  const byEnvironment = new Map<EnvironmentId, EnvironmentCloneToasts>();

  const stopEnvironment = (environmentId: EnvironmentId) => {
    const entry = byEnvironment.get(environmentId);
    if (!entry) return;
    entry.unsubscribe();
    for (const tracked of entry.toasts.values()) toastManager.close(tracked.toastId);
    byEnvironment.delete(environmentId);
  };

  const unsubscribeEnvironments = appAtomRegistry.subscribe(
    environmentSummaries.environmentIdsAtom,
    (environmentIds) => {
      for (const environmentId of byEnvironment.keys()) {
        if (!environmentIds.includes(environmentId)) stopEnvironment(environmentId);
      }
      for (const environmentId of environmentIds) {
        if (byEnvironment.has(environmentId)) continue;
        const toasts = new Map<ProjectId, TrackedToast>();
        const unsubscribe = appAtomRegistry.subscribe(
          environmentProjectClonesAtom(environmentId),
          (clones) => reconcileCloneToasts(environmentId, clones, toasts, actions),
          { immediate: true },
        );
        byEnvironment.set(environmentId, { toasts, unsubscribe });
      }
    },
    { immediate: true },
  );

  // Opening a cloned project's draft silences its toast.
  const unsubscribeRoute = router.subscribe("onResolved", () => {
    for (const [environmentId, { toasts }] of byEnvironment) {
      reconcileCloneToasts(
        environmentId,
        appAtomRegistry.get(environmentProjectClonesAtom(environmentId)),
        toasts,
        actions,
      );
    }
  });

  return () => {
    unsubscribeRoute();
    unsubscribeEnvironments();
    for (const environmentId of [...byEnvironment.keys()]) stopEnvironment(environmentId);
  };
}
