import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { currentClientMetadata } from "~/connection/platform";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

const CLI_COMMAND = "npx t3 triage";

const copyCliCommandAction = {
  children: "Copy command",
  onClick: () => void writeTextToClipboard(CLI_COMMAND, "command"),
};

/**
 * In-app `t3 triage`: the server writes the session files and clones the
 * matching source, then a No project draft opens with the prompt filled in.
 * The user picks the provider in the composer and describes the problem.
 */
export function useStartTriage() {
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const prepare = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });

  return async (environmentId: EnvironmentId) => {
    const toastId = toastManager.add({
      type: "loading",
      title: "Preparing triage…",
      description: "Getting the T3 Code source for this version.",
    });
    const fail = (description: string) =>
      toastManager.update(
        toastId,
        stackedThreadToast({
          type: "error",
          title: "Could not start triage",
          description: `${description} Run ${CLI_COMMAND} in a terminal instead.`,
          timeout: 0,
          actionProps: copyCliCommandAction,
        }),
      );

    if (scratchWorkspaceRootFor(environmentId) === null) {
      fail("This environment cannot start threads without a project.");
      return;
    }
    const prepared = await prepare({
      environmentId,
      input: { client: currentClientMetadata() },
    });
    if (prepared._tag === "Failure") {
      if (isAtomCommandInterrupted(prepared)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(prepared);
      fail(error instanceof Error ? error.message : "The server could not prepare triage.");
      return;
    }
    const project = await openScratchProject(environmentId, "Could not start triage");
    if (project === null) {
      // openScratchProject already reported why.
      toastManager.close(toastId);
      return;
    }
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
      () => null,
    );
    if (opened === null) {
      fail("T3 Code could not open a new thread.");
      return;
    }
    useComposerDraftStore.getState().setPrompt(opened.draftId, prepared.value.prompt);
    toastManager.update(toastId, {
      type: "info",
      title: "Describe what went wrong, then send",
      description: `Pick any provider. If triage does not work here, run ${CLI_COMMAND} in a terminal.`,
      timeout: 10_000,
      actionProps: copyCliCommandAction,
    });
  };
}
