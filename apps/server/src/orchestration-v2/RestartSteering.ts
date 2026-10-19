import type {
  MessageId,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";

/**
 * Keep steering across continuations cut before delivery. As with restart
 * background notes, only a completed turn proves acceptance across adapters.
 */
export function restartPendingMessageIds(
  source: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  attempts: ReadonlyArray<OrchestrationV2RunAttempt>,
): ReadonlyArray<MessageId> {
  const completedAttempts = new Set(
    providerTurns.filter((turn) => turn.status === "completed").map((turn) => turn.runAttemptId),
  );
  const completedRuns = new Set(
    attempts.filter((attempt) => completedAttempts.has(attempt.id)).map((attempt) => attempt.runId),
  );
  let current = source;
  const visited = new Set([current.id]);
  const pending = [...(current.restartPendingMessageIds ?? [])];
  while (
    current.restartContinuationOfRunId !== undefined &&
    !completedRuns.has(current.id) &&
    !(current.activeAttemptId !== null && completedAttempts.has(current.activeAttemptId))
  ) {
    const previous = runs.find((run) => run.id === current.restartContinuationOfRunId);
    if (previous === undefined || visited.has(previous.id)) break;
    visited.add(previous.id);
    current = previous;
    pending.unshift(...(current.restartPendingMessageIds ?? []));
  }
  // A sibling may already own this input. Keep its live work, proven acceptance,
  // and explicit stop separate from the ambiguous delivery of the cut chain.
  return [...new Set(pending)].filter(
    (id) =>
      !runs.some(
        (run) =>
          run.userMessageId === id &&
          !visited.has(run.id) &&
          (completedRuns.has(run.id) ||
            (run.activeAttemptId !== null && completedAttempts.has(run.activeAttemptId)) ||
            run.status === "queued" ||
            run.status === "preparing" ||
            run.status === "starting" ||
            run.status === "running" ||
            run.status === "waiting" ||
            run.status === "interrupted"),
      ),
  );
}
