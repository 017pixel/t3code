import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isPaused = Schema.is(SourceControlRateLimitPausedError);
const isPullRequestProviderError = Schema.is(PullRequestProviderError);

// Forge errors arrive wrapped, so walk the cause chain for a typed pause. Only a cause whose
// single failure is a pause counts; a defect or a second failure beside it still warns.
// Not every forge reports a reset time, so a rate-limited error without one is still a pause.
function rateLimitPause(cause: Cause.Cause<unknown>): { readonly retryAt?: number } | undefined {
  if (cause.reasons.length !== 1 || !Cause.isFailReason(cause.reasons[0]!)) return undefined;
  let error: unknown = cause.reasons[0].error;
  let pause: { readonly retryAt?: number } | undefined;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (isPaused(error)) return { retryAt: error.retryAt };
    if (isPullRequestProviderError(error) && error.reason === "rate-limited") {
      if (error.retryAt !== undefined) return { retryAt: error.retryAt };
      pause ??= {};
    }
    error = error.cause;
  }
  return pause;
}

/**
 * A quota pause repeats on every sweep until the reset time, so it logs as a single Info line
 * (the pretty console logger spreads structured fields over several lines) instead of a Warn stack.
 */
export function logThreadPullRequestFailure(
  message: string,
  cause: Cause.Cause<unknown>,
  context: { readonly threadId: string } | { readonly threadIds: ReadonlyArray<string> },
) {
  const pause = rateLimitPause(cause);
  if (pause === undefined) {
    return Effect.logWarning(message, { ...context, cause: Cause.pretty(cause) });
  }
  const threadIds = "threadId" in context ? [context.threadId] : context.threadIds;
  const until =
    pause.retryAt === undefined
      ? ""
      : ` until ${DateTime.formatIso(DateTime.makeUnsafe(pause.retryAt))}`;
  return Effect.logInfo(`${message}: rate limited${until} (threads: ${threadIds.join(", ")})`);
}
