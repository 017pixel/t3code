import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";

export const KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS = 2_000;

export type KeybindingsUpdateToastDecision =
  | { readonly _tag: "Success" }
  | { readonly _tag: "InvalidConfiguration"; readonly message: string };

export interface KeybindingsUpdateToastController {
  readonly handle: (event: ServerConfigStreamEvent | null) => KeybindingsUpdateToastDecision | null;
}

interface KeybindingsUpdate {
  readonly keybindingsChanged: boolean;
  /** The config's issues, when the event carries them. */
  readonly issues: ServerConfig["issues"] | null;
}

/**
 * A keybindings reload, as a `keybindingsUpdated` event or, from a server
 * that sends config deltas, as a delta that changes the keybindings or the
 * issues (a malformed file leaves the bindings as they were).
 */
function keybindingsUpdateFromEvent(
  event: ServerConfigStreamEvent | null,
): KeybindingsUpdate | null {
  if (event?.type === "keybindingsUpdated") {
    return { keybindingsChanged: true, issues: event.payload.issues };
  }
  if (event?.type !== "configDelta") return null;
  const { keybindings, issues } = event.changes;
  if (keybindings === undefined && issues === undefined) return null;
  return { keybindingsChanged: keybindings !== undefined, issues: issues ?? null };
}

export function createKeybindingsUpdateToastController(input: {
  readonly now?: () => number;
}): KeybindingsUpdateToastController {
  const now = input.now ?? Date.now;
  let lastSuccessToastAt: number | null = null;
  // A delta that only changes other issues must not repeat a standing warning.
  let reportedIssueMessage: string | null = null;

  return {
    handle: (event) => {
      const update = keybindingsUpdateFromEvent(event);
      if (update === null) {
        return null;
      }

      if (update.issues !== null) {
        const issue = update.issues.find((entry) => entry.kind.startsWith("keybindings."));
        const repeated = !update.keybindingsChanged && issue?.message === reportedIssueMessage;
        reportedIssueMessage = issue?.message ?? null;
        if (issue && !repeated) {
          return {
            _tag: "InvalidConfiguration",
            message: issue.message,
          };
        }
        if (issue) {
          return null;
        }
      }
      if (!update.keybindingsChanged) {
        return null;
      }

      const currentTime = now();
      if (
        lastSuccessToastAt !== null &&
        currentTime - lastSuccessToastAt < KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS
      ) {
        return null;
      }

      lastSuccessToastAt = currentTime;
      return { _tag: "Success" };
    },
  };
}
