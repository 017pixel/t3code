import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useScratchProject() {
  const { environments } = useEnvironments();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  const scratchWorkspaceRootFor = (environmentId: EnvironmentId | null): string | null => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    return availableScratchWorkspaceRoot(environment?.connection.phase, environment?.serverConfig);
  };

  const offeringEnvironments = () =>
    environments.filter((entry) => scratchWorkspaceRootFor(entry.environmentId) !== null);

  const scratchEnvironmentId = (current: EnvironmentId | null): EnvironmentId | null => {
    if (current !== null && scratchWorkspaceRootFor(current) !== null) return current;
    // When the current machine can't take it, fall back only to an unambiguous one.
    const offering = offeringEnvironments();
    return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
  };

  // Explains a null scratchEnvironmentId: no machine can take it, or several can and we won't guess.
  const scratchUnavailableReason = () =>
    offeringEnvironments().length > 1
      ? "Several of your machines can start a thread without a project. Open a thread on the one you want first."
      : "None of your machines can start a thread without a project right now.";

  const openScratchProject = async (
    environmentId: EnvironmentId,
    failureTitle = "Could not start without a project",
  ): Promise<EnvironmentProject | null> => {
    const result = await openScratch({ environmentId, input: {} });
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
    }
    return null;
  };

  const startScratchThread = async (environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      reportScratchFailure(
        "Could not start without a project",
        new Error(scratchUnavailableReason()),
      );
      return;
    }
    const project = await openScratchProject(environmentId);
    if (project) {
      await handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
        (error: unknown) => reportScratchFailure("Could not start without a project", error),
      );
    }
  };

  return {
    scratchWorkspaceRootFor,
    scratchEnvironmentId,
    scratchUnavailableReason,
    openScratchProject,
    startScratchThread,
  };
}
