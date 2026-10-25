import type { ChatComposerProps } from "./ChatComposer";
import { type ComposerCommandItem } from "./ComposerCommandMenu";
import {
  type ComposerDispatchMode,
  resolveComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import {
  type ComposerPromptHistoryPosition,
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
} from "./composerPromptHistory";
import {
  type ComposerSubmissionIntent,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  composerSubmissionIntentForKey,
} from "../../composer-logic";
import { type PendingUserInput } from "../../session-logic";
import { type PreviewAnnotationPayload } from "@t3tools/contracts";
import { type ReviewCommentContext } from "../../reviewCommentContext";
import { type ComposerThreadDraftState, composerTargetKey } from "../../composerDraftStore";
import { listContinuationForEnter, listIndentForTab } from "../../composer-list-continuation";
import type { Dispatch, RefObject, SetStateAction } from "react";

/**
 * The composer's key handling inside the editor: send shortcuts, the slash/mention menu,
 * prompt history on ArrowUp/ArrowDown, plan-mode toggle, and list continuation.
 * Returns whether the key was handled.
 */
export function handleComposerCommandKey(
  input: {
    readonly keybindings: ChatComposerProps["keybindings"];
    readonly sendShortcut: ChatComposerProps["settings"]["sendShortcut"];
    readonly routeKind: ChatComposerProps["routeKind"];
    readonly phase: ChatComposerProps["phase"];
    readonly isCompacting: boolean;
    readonly followUpBehavior: ChatComposerProps["settings"]["followUpBehavior"];
    readonly isSoftwareKeyboardOpen: boolean;
    readonly planModeUiEnabled: boolean;
    readonly isLiteralPendingAnswer: boolean;
    readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
    readonly promptHistoryMessages: ChatComposerProps["promptHistoryMessages"];
    readonly promptHistoryPositionRef: RefObject<{
      targetKey: string;
      position: ComposerPromptHistoryPosition;
    } | null>;
    readonly composerDraftTarget: ChatComposerProps["composerDraftTarget"];
    readonly readPrompt: () => string;
    readonly readAttachmentDraft: () => Pick<ComposerThreadDraftState, "images" | "files">;
    readonly readTerminalContexts: () => ComposerThreadDraftState["terminalContexts"];
    readonly composerPreviewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
    readonly composerReviewComments: ReadonlyArray<ReviewCommentContext>;
    readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
    readonly composerMenuOpen: boolean;
    readonly composerMenuItems: ReadonlyArray<ComposerCommandItem>;
    readonly activeComposerMenuItem: ComposerCommandItem | null;
    readonly setComposerDraftPrompt: (
      target: ChatComposerProps["composerDraftTarget"],
      prompt: string,
    ) => void;
    readonly setComposerCursor: Dispatch<SetStateAction<number>>;
    readonly setComposerTrigger: (trigger: ComposerTrigger | null) => void;
    readonly setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
    readonly dismissComposerTrigger: (trigger: ComposerTrigger | null) => void;
    readonly toggleInteractionMode: () => void;
    readonly nudgeComposerMenuHighlight: (key: "ArrowDown" | "ArrowUp") => void;
    readonly onSelectComposerItem: (item: ComposerCommandItem) => void;
    readonly resolveActiveComposerTrigger: () => { trigger: ComposerTrigger | null };
    readonly readComposerSnapshot: () => { value: string };
    readonly applyPromptReplacement: (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expandedCursorAfterReplace?: number },
    ) => boolean;
    readonly submitComposer: (
      event: undefined,
      dispatchMode: ComposerDispatchMode,
      submissionIntent: ComposerSubmissionIntent,
    ) => void;
  },
  key: string,
  event: KeyboardEvent,
  isTaskItem = false,
): boolean {
  const {
    keybindings,
    sendShortcut,
    routeKind,
    phase,
    isCompacting,
    followUpBehavior,
    isSoftwareKeyboardOpen,
    planModeUiEnabled,
    isLiteralPendingAnswer,
    pendingUserInputs,
    promptHistoryMessages,
    promptHistoryPositionRef,
    composerDraftTarget,
    readPrompt,
    readAttachmentDraft,
    readTerminalContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    composerEditorRef,
    composerMenuOpen,
    composerMenuItems,
    activeComposerMenuItem,
    setComposerDraftPrompt,
    setComposerCursor,
    setComposerTrigger,
    setComposerHighlightedItemId,
    dismissComposerTrigger,
    toggleInteractionMode,
    nudgeComposerMenuHighlight,
    onSelectComposerItem,
    resolveActiveComposerTrigger,
    readComposerSnapshot,
    applyPromptReplacement,
    submitComposer,
  } = input;
  // The composer persists across threads. A recall from thread A must not
  // be treated as active in thread B, where the text-match fallback could
  // otherwise turn B's own draft into a browsing position.
  const promptHistoryTargetKey = composerTargetKey(composerDraftTarget);

  const replacePromptFromHistory = (nextPrompt: string) => {
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    setComposerTrigger(null);
    setComposerHighlightedItemId(null);
  };

  const navigatePromptHistory = (
    direction: "backward" | "forward",
    event: KeyboardEvent,
  ): boolean => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
      return false;
    }
    if (pendingUserInputs.length > 0) return false;
    const attachmentDraft = readAttachmentDraft();
    if (
      attachmentDraft.images.length > 0 ||
      attachmentDraft.files.length > 0 ||
      readTerminalContexts().length > 0 ||
      composerPreviewAnnotations.length > 0 ||
      composerReviewComments.length > 0
    ) {
      return false;
    }
    const recalled = promptHistoryPositionRef.current;
    const position = recalled?.targetKey === promptHistoryTargetKey ? recalled.position : null;
    if (position === null && readPrompt().length > 0) {
      return false;
    }
    const editor = composerEditorRef.current;
    if (!editor?.isCaretOnVisualEdge(direction === "backward" ? "start" : "end")) {
      return false;
    }
    const step = stepComposerPromptHistory({
      direction,
      // Built on the keypress, not per render: the timeline changes on every streamed delta and
      // ArrowUp is rare.
      entries: buildComposerPromptHistoryEntries(promptHistoryMessages),
      position,
      currentPrompt: readPrompt(),
    });
    if (!step) return false;
    promptHistoryPositionRef.current = step.position
      ? { targetKey: promptHistoryTargetKey, position: step.position }
      : null;
    replacePromptFromHistory(step.prompt);
    return true;
  };

  const submissionIntent = composerSubmissionIntentForKey({
    event,
    keybindings,
    isSoftwareKeyboardOpen,
    isDraftThread: routeKind === "draft",
    isRunning: phase === "running",
    sendShortcut,
    prompt: readPrompt(),
  });
  if (key === "Tab" && event.shiftKey && submissionIntent === null) {
    if (!planModeUiEnabled) return false;
    toggleInteractionMode();
    return true;
  }
  const { trigger } = resolveActiveComposerTrigger();
  const menuIsActive = !isLiteralPendingAnswer && (composerMenuOpen || trigger !== null);
  if (key === "Escape") {
    if (!menuIsActive || event.isComposing || event.keyCode === 229) return false;
    dismissComposerTrigger(trigger);
    return true;
  }
  if (menuIsActive && (submissionIntent === null || submissionIntent === "foreground")) {
    const currentItems = composerMenuItems;
    const selectedItem = activeComposerMenuItem ?? currentItems[0];
    if (key === "ArrowDown" && currentItems.length > 0) {
      nudgeComposerMenuHighlight("ArrowDown");
      return true;
    }
    if (key === "ArrowUp" && currentItems.length > 0) {
      nudgeComposerMenuHighlight("ArrowUp");
      return true;
    }
    if ((key === "Enter" || key === "Tab") && selectedItem) {
      onSelectComposerItem(selectedItem);
      return true;
    }
  }
  if ((key === "ArrowUp" || key === "ArrowDown") && submissionIntent === null) {
    return navigatePromptHistory(key === "ArrowUp" ? "backward" : "forward", event);
  }
  if (submissionIntent) {
    submitComposer(
      undefined,
      resolveComposerDispatchMode({
        running: phase === "running",
        alternateModifier: submissionIntent === "alternate",
        activeTurnDefault: followUpBehavior,
        canSteer: !isCompacting,
      }),
      submissionIntent,
    );
    return true;
  }
  if (key === "Enter" && isTaskItem) return false;
  if (
    !isLiteralPendingAnswer &&
    !event.isComposing &&
    (key === "Enter" || (key === "Tab" && !event.shiftKey))
  ) {
    const selection = composerEditorRef.current?.readSelectionRange();
    const snapshot = readComposerSnapshot();
    if (selection && selection.start === selection.end && snapshot.value === readPrompt()) {
      const edit =
        key === "Enter"
          ? listContinuationForEnter(snapshot.value, selection.start)
          : listIndentForTab(snapshot.value, selection.start, selection.end);
      if (
        edit &&
        applyPromptReplacement(edit.start, edit.end, edit.replacement, {
          expandedCursorAfterReplace: edit.cursorAfter,
        })
      ) {
        return true;
      }
    }
  }
  return false;
}
