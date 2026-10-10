let suspendedLimit: number | undefined;

/**
 * Effect captures a definition-site stack for every module-level `Effect.fn`
 * and labeled atom, which costs tens of milliseconds while the app graph
 * evaluates. Those stacks only enrich debugging output, and Effect skips them
 * when `Error.stackTraceLimit` is 0. Production boots evaluate the app graph
 * without them; call sites keep their runtime stacks once the limit is back.
 */
export function suspendStackTracesForAppImport(): void {
  if (!import.meta.env.PROD || suspendedLimit !== undefined) return;
  suspendedLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
}

/** Restores stack traces; main calls this before its own startup code runs. */
export function restoreStackTraces(): void {
  if (suspendedLimit === undefined) return;
  Error.stackTraceLimit = suspendedLimit;
  suspendedLimit = undefined;
}
