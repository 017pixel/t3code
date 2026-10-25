import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { handleDesktopAppActivationRequest } from "../../desktopAppActivation";
import { createNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import type { AppRouter } from "../../router";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProjects, waitForProject } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { projectEnvironment } from "../../state/projects";
import { environmentShell } from "../../state/shell";
import { whileFirstRunAppOpen } from "../onboarding/firstRunGateStore";

const primaryActivationReadyAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return false;
  const presentation = get(environmentPresentations.presentationAtom(environmentId));
  return (
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig !== null &&
    get(environmentShell.hasSnapshotAtom(environmentId))
  );
}).pipe(Atom.withLabel("web-desktop-app-activation-ready"));

function readActivationTarget() {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(environmentId),
  );
  if (presentation?.connection.phase !== "connected" || presentation.serverConfig === null) {
    return null;
  }
  return { environmentId, platform: presentation.serverConfig.environment.platform.os };
}

/**
 * Answers the desktop shell's "open this folder" requests while the primary environment can
 * take them, and tells the shell when it can.
 */
export function startDesktopAppActivation(router: AppRouter): () => void {
  const activation = window.desktopBridge?.appActivation;
  if (activation === undefined) return () => {};
  const openThread = createNewThreadHandler(router);

  const processRequest = (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: readActivationTarget,
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const command = projectEnvironment.create;
        const result = await runAtomCommand(
          appAtomRegistry,
          command,
          {
            environmentId,
            input: {
              projectId,
              title: inferProjectTitleFromPath(workspaceRoot),
              workspaceRoot,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          },
          { label: command.label, reportFailure: false, reportDefect: true },
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => openThread(projectRef),
    });

  // One queue for the service's life: a request still in flight when readiness drops
  // finishes before the next one starts.
  let queue = Promise.resolve();
  return whileFirstRunAppOpen(() => {
    const unsubscribe = activation.onRequest((request) => {
      queue = queue
        .then(async () => {
          const response = await processRequest(request);
          await activation.complete(response);
        })
        .catch(() => undefined);
    });
    void activation.setReady(true).catch(() => undefined);
    return () => {
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, primaryActivationReadyAtom);
}
