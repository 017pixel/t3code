import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { threadHandoffNotice } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentThreadShells } from "../../state/threads";
import { threadHandoffEnvironment } from "../../state/threadHandoff";

export function ThreadHandoffCard({ thread }: { thread: EnvironmentThreadShell }) {
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
  const canRetry = useAtomValue(
    threadHandoffEnvironment.start.permissionAtom(thread.environmentId),
  );
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const sourceConnected = presentations.get(thread.environmentId)?.connection.phase === "connected";
  const navigation = useNavigation();
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
    const live = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref))?.handoff;
    return alive.current && live?.handoffId === handoff.handoffId && live.state === handoff.state;
  };
  const act = async (action: "cancel" | "retry" | "abandon") => {
    if (!current() || working.current) return;
    const command =
      action === "retry" ? threadHandoffEnvironment.start : threadHandoffEnvironment.cancel;
    if (!appAtomRegistry.get(command.permissionAtom(thread.environmentId))) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
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
    } finally {
      if (alive.current) {
        working.current = false;
        setBusy(false);
      }
    }
  };
  const abandon = () =>
    Dialog.confirm({
      title: "Continue here?",
      message:
        "The move outcome is unknown. The destination may already have a copy or finish accepting it later. Continue working here anyway?",
      confirmText: "Continue here",
      destructive: true,
      onConfirm: () => {
        if (current()) void act("abandon");
      },
    });
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <Text className="font-t3-medium">{notice.title}</Text>
      <Text className="text-sm text-foreground-muted">{notice.detail}</Text>
      {handoff.state === "pending" ? (
        <Button
          label="Cancel move"
          disabled={!canCancel || !sourceConnected || busy}
          onPress={() => void act("cancel")}
        />
      ) : null}
      {handoff.state === "departing" ? (
        <>
          <Button
            label="Retry move"
            disabled={!canRetry || !sourceConnected || busy}
            onPress={() => void act("retry")}
          />
          <Button
            label="Continue here…"
            tone="text"
            disabled={!canCancel || !sourceConnected || busy}
            onPress={abandon}
          />
        </>
      ) : null}
      {handoff.state === "departed" &&
      presentations.get(handoff.environmentId)?.connection.phase === "connected" ? (
        <Button
          label={`Open on ${handoff.label}`}
          onPress={() => {
            if (
              !current() ||
              appAtomRegistry.get(environmentPresentations.presentationAtom(handoff.environmentId))
                ?.connection.phase !== "connected"
            )
              return;
            navigation.navigate("Thread", {
              environmentId: handoff.environmentId,
              threadId: handoff.threadId,
            });
          }}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
