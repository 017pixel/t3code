import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../test/render";
import {
  shortcutModifierStateAfterKeyboardEvent,
  type ShortcutModifierState,
  useShortcutModifierState,
} from "./shortcutModifierState";

function HeldModifiers() {
  const raw = useShortcutModifierState();
  const outsideEditable = useShortcutModifierState(true);
  return (
    <>
      <input aria-label="field" />
      <output aria-label="raw">{raw.metaKey ? "meta" : "none"}</output>
      <output aria-label="outside editable">{outsideEditable.metaKey ? "meta" : "none"}</output>
    </>
  );
}

function dispatchKey(target: EventTarget, type: "keydown" | "keyup", key: string) {
  return act(() => {
    target.dispatchEvent(
      new KeyboardEvent(type, { key, metaKey: type === "keydown", bubbles: true }),
    );
  });
}

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // Synthetic dictation paste can poison later real key events with metaKey=true.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it("clears a held modifier when a non-modifier key reports it released", () => {
    const heldMeta: ShortcutModifierState = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const state = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike("keydown", { key: "a", metaKey: false }),
    );
    expect(state).toEqual(emptyState());
  });

  it("ignores modifiers typed into an editable only for consumers that ask", async () => {
    // A hook-only test: the router adds nothing to a window-level store.
    await using screen = await render(<HeldModifiers />, { router: false });
    const field = screen.getByLabelText("field").element();

    await dispatchKey(window, "keydown", "Meta");
    await expect.element(screen.getByLabelText("raw")).toHaveTextContent("meta");
    await expect.element(screen.getByLabelText("outside editable")).toHaveTextContent("meta");

    await act(() => (field as HTMLInputElement).focus());
    await expect.element(screen.getByLabelText("raw")).toHaveTextContent("meta");
    await expect.element(screen.getByLabelText("outside editable")).toHaveTextContent("none");

    await dispatchKey(field, "keyup", "Meta");
    await expect.element(screen.getByLabelText("raw")).toHaveTextContent("none");
  });
});
