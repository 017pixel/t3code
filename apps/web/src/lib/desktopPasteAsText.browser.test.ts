import { describe, expect, it } from "vite-plus/test";

import { armPasteAsText, consumePasteAsText, isPasteAsTextArmed } from "./desktopPasteAsText";

function composerWith(child: HTMLElement): Disposable & { form: HTMLFormElement } {
  const form = document.createElement("form");
  form.append(child);
  document.body.append(form);
  return { form, [Symbol.dispose]: () => form.remove() };
}

describe("paste-as-text arm", () => {
  it("covers one paste into the composer the shortcut was pressed in", () => {
    const editor = document.createElement("div");
    using composer = composerWith(editor);
    armPasteAsText("shortcut", editor, 0);
    expect(isPasteAsTextArmed(composer.form, 500)).toBe(true);
    expect(consumePasteAsText(composer.form, 500)).toBe(true);
    expect(consumePasteAsText(composer.form, 600)).toBe(false);
  });

  it("expires, and ignores a shortcut pressed outside the composer", () => {
    const editor = document.createElement("div");
    using composer = composerWith(editor);
    armPasteAsText("shortcut", editor, 0);
    expect(consumePasteAsText(composer.form, 1_001)).toBe(false);
    armPasteAsText("shortcut", document.body, 0);
    expect(consumePasteAsText(composer.form, 10)).toBe(false);
  });

  it("lets the menu reach the composer unless another field holds focus", () => {
    using composer = composerWith(document.createElement("div"));
    armPasteAsText("menu", document.body, 0);
    expect(consumePasteAsText(composer.form, 10)).toBe(true);
    const input = document.createElement("input");
    document.body.append(input);
    armPasteAsText("menu", input, 0);
    expect(consumePasteAsText(composer.form, 10)).toBe(false);
    input.remove();
  });

  it("is disarmed by a paste the composer did not handle", () => {
    using composer = composerWith(document.createElement("div"));
    armPasteAsText("menu", document.body);
    document.body.dispatchEvent(new Event("paste", { bubbles: true }));
    expect(isPasteAsTextArmed(composer.form)).toBe(false);
  });
});
