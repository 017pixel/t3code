import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { threadHandoffNotice } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { threadHandoffEnvironment } from "../state/threadHandoff";
import { readLocalApi } from "../localApi";
import { Button } from "./ui/button";

export function ThreadHandoffBanner({ thread }: { thread: EnvironmentThreadShell }) {
  return thread.handoff ? (
    <Notice
      key={`${thread.environmentId}:${thread.id}:${thread.handoff.handoffId}`}
      thread={thread}
    />
  ) : null;
}
function Notice({ thread }: { thread: EnvironmentThreadShell }) {
  const handoff = thread.handoff!;
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const notice = threadHandoffNotice(handoff)!;
  const canCancel = useAtomValue(
    threadHandoffEnvironment.cancel.permissionAtom(thread.environmentId),
  );
  const canStart = useAtomValue(
    threadHandoffEnvironment.start.permissionAtom(thread.environmentId),
  );
  const connected = useConnectedEnvironmentIds();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => {
    const live = readThreadShell(ref)?.handoff;
    return alive.current && live?.handoffId === handoff.handoffId && live.state === handoff.state;
  };
  const act = async (action: "cancel" | "retry" | "abandon") => {
    if (working.current || !current()) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const run = async () => {
      if (action === "abandon") {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          "The move outcome is unknown. The destination may already have a copy or finish accepting it later. Continue working here anyway?",
          { variant: "destructive" },
        );
        if (!confirmed || !current()) return;
      }
      const command =
        action === "retry" ? threadHandoffEnvironment.start : threadHandoffEnvironment.cancel;
      if (!current() || !appAtomRegistry.get(command.permissionAtom(thread.environmentId))) return;
      const result =
        action === "retry"
          ? await threadHandoffEnvironment.start.run(appAtomRegistry, {
              environmentId: thread.environmentId,
              input: {
                threadId: thread.id,
                environmentId: handoff.environmentId,
                projectId: handoff.projectId,
                handoffId: handoff.handoffId,
                isCurrent: current,
              },
            })
          : await threadHandoffEnvironment.cancel.run(appAtomRegistry, {
              environmentId: thread.environmentId,
              input: {
                threadId: thread.id,
                handoffId: handoff.handoffId,
                isCurrent: current,
                ...(action === "abandon" ? { abandon: true } : {}),
              },
            });
      if (current() && result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "Could not update the move. Try again.",
        );
      }
    };
    await run().finally(() => {
      if (alive.current) {
        working.current = false;
        setBusy(false);
      }
    });
  };
  return (
    <div
      role="status"
      className="pointer-events-auto mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 rounded-lg border bg-background p-4"
    >
      <p className="text-sm font-medium">{notice.title}</p>
      <p className="text-sm text-muted-foreground">{notice.detail}</p>
      <div className="flex flex-wrap gap-2">
        {handoff.state === "pending" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !canCancel || !connected.includes(thread.environmentId)}
            onClick={() => void act("cancel")}
          >
            Cancel move
          </Button>
        ) : null}
        {handoff.state === "departing" ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canStart || !connected.includes(thread.environmentId)}
              onClick={() => void act("retry")}
            >
              Retry move
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !canCancel || !connected.includes(thread.environmentId)}
              onClick={() => void act("abandon")}
            >
              Continue here…
            </Button>
          </>
        ) : null}
        {handoff.state === "departed" && connected.includes(handoff.environmentId) ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (
                !current() ||
                appAtomRegistry.get(
                  environmentPresentations.presentationAtom(handoff.environmentId),
                )?.connection.phase !== "connected"
              )
                return;
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: handoff.environmentId, threadId: handoff.threadId },
              });
            }}
          >
            Open on {handoff.label}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
