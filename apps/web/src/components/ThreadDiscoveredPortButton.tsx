import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Globe2Icon } from "lucide-react";
import type { MouseEvent } from "react";

import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { previewEnvironment } from "../state/preview";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Opens the first local server the thread's terminal or agent started in its preview. */
export function ThreadDiscoveredPortButton(props: {
  threadRef: ScopedThreadRef;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { threadRef, onThreadActivate } = props;
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const port = discoveredPorts[0];
  if (!canOperatePreview || port === undefined) return null;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onThreadActivate(threadRef);
    void (async () => {
      const result = await openDiscoveredPort({ threadRef, port, openPreview });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open preview",
          description: error instanceof Error ? error.message : "The preview could not be opened.",
        }),
      );
    })();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Open localhost:${port.port}`}
            className="inline-flex shrink-0 cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={handleClick}
          />
        }
      >
        <Globe2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        Open localhost:{port.port}
        {discoveredPorts.length > 1 ? ` (+${discoveredPorts.length - 1})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
