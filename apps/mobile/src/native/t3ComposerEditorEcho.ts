import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
import type { ComposerEditorSelection } from "./T3ComposerEditor.types";

/**
 * Per-editor bookkeeping for the controlled native editor protocol, shared by the iOS and
 * Android editors. Native events land here synchronously, ahead of the React render that
 * echoes them back, so this is mutable and lives in a ref rather than in state.
 */
export interface ComposerEditorEcho {
  /** Newest native revision accepted, which can run ahead of the rendered one. */
  latestEventCount: number;
  snapshots: ComposerNativeEventSnapshot[];
}

export function createComposerEditorEcho(): ComposerEditorEcho {
  // The native editor mounts empty, so the snapshot history starts empty: the
  // first controlled payload must be a non-echo so a restored draft (or a
  // recycled native view) is applied rather than skipped.
  return { latestEventCount: 0, snapshots: [] };
}

/** Accepts a native event, or returns null when it is older than one already accepted. */
export function acceptComposerNativeEvent(
  echo: ComposerEditorEcho,
  event: {
    readonly eventCount: number;
    readonly value: string;
    readonly selection: ComposerEditorSelection;
  },
): number | null {
  const acknowledgedEventCount = acknowledgeComposerNativeEvent(
    echo.latestEventCount,
    event.eventCount,
  );
  if (acknowledgedEventCount === null) return null;
  echo.latestEventCount = acknowledgedEventCount;
  echo.snapshots.push({
    eventCount: acknowledgedEventCount,
    value: event.value,
    selection: event.selection,
  });
  return acknowledgedEventCount;
}

export function resolveComposerControlledDocument(
  echo: ComposerEditorEcho,
  input: {
    readonly value: string;
    readonly selection: ComposerEditorSelection | null;
    readonly tokensJson: string;
    /** The acknowledged revision this render was scheduled for. */
    readonly renderedEventCount: number;
  },
) {
  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  const controlledEventCount = resolveComposerControlledEventCount(
    input.value,
    input.selection,
    input.renderedEventCount,
    echo.snapshots,
  );
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    input.value,
    input.selection,
    input.renderedEventCount,
    echo.snapshots,
  );
  const isNativeEcho =
    controlledEventCount === input.renderedEventCount && acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value: input.value,
    selection: isNativeEcho ? null : input.selection,
    tokensJson: input.tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });
  return {
    controlledDocumentJson,
    controlledEventCount,
    acknowledgesLatestNativeEvent,
    isNativeEcho,
  };
}

/** Commit phase only: a render that never commits must not drop history it acknowledged. */
export function pruneComposerEditorEcho(echo: ComposerEditorEcho, renderedEventCount: number) {
  echo.snapshots = pruneAcknowledgedComposerNativeEvents(echo.snapshots, renderedEventCount);
}

/** Commit phase only: records a non-echo payload sent to native as the state it now holds. */
export function assumeComposerControlledDocument(
  echo: ComposerEditorEcho,
  controlledEventCount: number,
  value: string,
) {
  // A native event that arrived after this render was committed moves the
  // acknowledged revision forward; the editor rejects this payload, so the
  // snapshot history must not assume it applied.
  if (controlledEventCount !== echo.latestEventCount) return;
  echo.snapshots = assumeComposerControlledState(echo.snapshots, controlledEventCount, value);
}
