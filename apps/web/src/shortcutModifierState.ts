import { useSyncExternalStore } from "react";
import { isEditableFocused } from "./lib/editableFocus";

export interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

interface ModifierSnapshots {
  readonly raw: ShortcutModifierState;
  /** Held modifiers, except while typing into an editable target. */
  readonly outsideEditable: ShortcutModifierState;
}

let snapshots: ModifierSnapshots = {
  raw: EMPTY_SHORTCUT_MODIFIER_STATE,
  outsideEditable: EMPTY_SHORTCUT_MODIFIER_STATE,
};
const listeners = new Set<() => void>();

function setSnapshots(raw: ShortcutModifierState, outsideEditable: ShortcutModifierState) {
  // Even a no-op dispatch costs work in the sidebar's large tree, so ordinary
  // typing must return before notifying React.
  const rawChanged = !areShortcutModifierStatesEqual(raw, snapshots.raw);
  const outsideEditableChanged = !areShortcutModifierStatesEqual(
    outsideEditable,
    snapshots.outsideEditable,
  );
  if (!rawChanged && !outsideEditableChanged) return;
  snapshots = {
    raw: rawChanged ? raw : snapshots.raw,
    outsideEditable: outsideEditableChanged ? outsideEditable : snapshots.outsideEditable,
  };
  for (const listener of listeners) listener();
}

function onKeyboardEvent(event: KeyboardEvent) {
  setSnapshots(
    shortcutModifierStateAfterKeyboardEvent(snapshots.raw, event),
    isEditableFocused(event.target)
      ? EMPTY_SHORTCUT_MODIFIER_STATE
      : shortcutModifierStateAfterKeyboardEvent(snapshots.outsideEditable, event),
  );
}

// Dictation tools can omit Meta keyup after synthetic paste, leaving jump hints stuck.
function onResetEvent() {
  setSnapshots(EMPTY_SHORTCUT_MODIFIER_STATE, EMPTY_SHORTCUT_MODIFIER_STATE);
}

function onFocusIn(event: FocusEvent) {
  if (isEditableFocused(event.target)) {
    setSnapshots(snapshots.raw, EMPTY_SHORTCUT_MODIFIER_STATE);
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyboardEvent, true);
    window.addEventListener("keyup", onKeyboardEvent, true);
    window.addEventListener("paste", onResetEvent, true);
    window.addEventListener("blur", onResetEvent);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("focusin", onFocusIn);
    window.removeEventListener("keydown", onKeyboardEvent, true);
    window.removeEventListener("keyup", onKeyboardEvent, true);
    window.removeEventListener("paste", onResetEvent, true);
    window.removeEventListener("blur", onResetEvent);
    // Keys released while nobody listened would otherwise read as still held.
    snapshots = {
      raw: EMPTY_SHORTCUT_MODIFIER_STATE,
      outsideEditable: EMPTY_SHORTCUT_MODIFIER_STATE,
    };
  };
}

const getRawSnapshot = () => snapshots.raw;
const getOutsideEditableSnapshot = () => snapshots.outsideEditable;
const getServerSnapshot = () => EMPTY_SHORTCUT_MODIFIER_STATE;

export function useShortcutModifierState(ignoreEditable = false): ShortcutModifierState {
  return useSyncExternalStore(
    subscribe,
    ignoreEditable ? getOutsideEditableSnapshot : getRawSnapshot,
    getServerSnapshot,
  );
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  let nextState: ShortcutModifierState;
  if (normalizedModifierKey) {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    };
  } else {
    // Dictation paste can poison real events with metaKey=true until a physical Meta press.
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    };
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
