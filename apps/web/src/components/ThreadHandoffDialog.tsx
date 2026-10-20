import { useAtomValue } from "@effect/atom-react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  configureThreadHandoffActions,
  updateThreadHandoffSelection,
  isCurrentThreadHandoffRequest,
  threadHandoffRequest,
  type ThreadHandoffRequest,
} from "./threadHandoffAction";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadHandoffEnvironment } from "../state/threadHandoff";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

configureThreadHandoffActions((ref) =>
  appAtomRegistry.get(threadHandoffEnvironment.availableAtom(ref)),
);

export function ThreadHandoffDialogHost() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const router = useRouter();
  updateThreadHandoffSelection(pathname);
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", (event) =>
        updateThreadHandoffSelection(event.toLocation.pathname),
      ),
    [router],
  );
  const request = useStore(threadHandoffRequest, (state) => state.request);
  return request && isCurrentThreadHandoffRequest(request) ? (
    <ThreadHandoffDialog key={request.id} request={request} />
  ) : null;
}

function ThreadHandoffDialog({ request }: { request: ThreadHandoffRequest }) {
  const { ref } = request;
  const atom = threadHandoffEnvironment.options({
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId },
  });
  const options = useAtomValue(atom);
  const available = useAtomValue(threadHandoffEnvironment.availableAtom(ref));
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const current = () => isCurrentThreadHandoffRequest(request);
  const close = () => {
    if (current()) threadHandoffRequest.setState({ request: null });
  };
  const start = async (
    option: Extract<typeof options, { _tag: "Success" }>["value"]["options"][number],
  ) => {
    if (
      !current() ||
      sending.current ||
      option.reason !== null ||
      option.projectId === null ||
      !appAtomRegistry.get(threadHandoffEnvironment.availableAtom(ref))
    )
      return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await threadHandoffEnvironment.start.run(appAtomRegistry, {
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        environmentId: option.environmentId,
        projectId: option.projectId,
        isCurrent: current,
      },
    });
    if (!current()) return;
    sending.current = false;
    setBusy(false);
    if (AsyncResult.isSuccess(result)) close();
    else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not start the move. Try again.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Continue on…</DialogTitle>
          <DialogDescription>
            Move this conversation and Git working changes to a linked environment with the same
            repository. A fresh agent continues there.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {!available && !busy ? (
              <p>This thread can no longer move. Stop any work before trying again.</p>
            ) : null}
            {options.waiting || options._tag === "Initial" ? (
              <p>Finding linked environments…</p>
            ) : null}
            {AsyncResult.isFailure(options) ? (
              <div role="alert">
                <p>Could not load destinations.</p>
                <Button variant="outline" onClick={() => appAtomRegistry.refresh(atom)}>
                  Retry
                </Button>
              </div>
            ) : null}
            {AsyncResult.isSuccess(options) ? (
              options.value.options.length === 0 ? (
                <p>No linked environments found. Link an environment in Connections first.</p>
              ) : (
                options.value.options.map((option) => (
                  <div key={option.environmentId} className="flex flex-col gap-1">
                    <Button
                      variant="outline"
                      disabled={
                        !available || busy || option.reason !== null || option.projectId === null
                      }
                      onClick={() => void start(option)}
                    >
                      {option.label}
                    </Button>
                    {option.reason ? (
                      <p className="text-sm text-muted-foreground">{option.reason}</p>
                    ) : null}
                  </div>
                ))
              )
            ) : null}
            {busy ? <p>Starting the move…</p> : null}
            {error ? <p role="alert">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
