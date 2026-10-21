import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { htmlRenderShortcutsMessage, injectHtmlRenderBootstrap } from "./htmlRender.ts";
import { matchesKeybindingShortcut, parseKeybindingShortcut } from "./keybindings.ts";

function frame(platform: string) {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const messages: unknown[] = [];
  const parent = { postMessage: (message: unknown) => messages.push(message) };
  const window = {
    parent,
    addEventListener(type: string, listener: (event: never) => void) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const html = injectHtmlRenderBootstrap("<p>Keyboard fixture</p>");
  const start = html.indexOf("<script>") + "<script>".length;
  const script = html.slice(start, html.indexOf("</script>", start));
  NodeVM.runInNewContext(script, {
    window,
    navigator: { platform },
    document: { getElementById: () => ({}), addEventListener() {} },
    location: { hash: "" },
    // Cleanup timers do not take part in key dispatch; the late listener removes itself.
    setTimeout() {},
  });
  return {
    messages,
    configure(
      shortcuts: Parameters<typeof htmlRenderShortcutsMessage>[0],
      blocked: Parameters<typeof htmlRenderShortcutsMessage>[1] = [],
    ) {
      for (const listener of listeners.get("message") ?? []) {
        listener({ source: parent, data: htmlRenderShortcutsMessage(shortcuts, blocked) } as never);
      }
    },
    press(
      input: {
        key: string;
        code?: string;
        metaKey: boolean;
        ctrlKey: boolean;
        altKey: boolean;
        shiftKey: boolean;
      },
      altGraph = false,
    ) {
      const event = {
        ...input,
        isTrusted: true,
        isComposing: false,
        defaultPrevented: false,
        getModifierState: () => altGraph,
        composedPath: () => [{ tagName: "DIV" }],
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      // Set iteration includes the listener installed during the capture phase,
      // just as the later window bubble phase does in a real key dispatch.
      for (const listener of listeners.get("keydown") ?? []) listener(event as never);
      return event.defaultPrevented;
    },
  };
}

const fixtures = [
  { name: "German plus", key: "+", code: "BracketRight", binding: "mod+]", expected: false },
  { name: "German plus remap", key: "+", code: "BracketRight", binding: "mod++", expected: true },
  { name: "German hash", key: "#", code: "Backslash", binding: "mod+\\", expected: false },
  { name: "German umlaut", key: "ü", code: "BracketLeft", binding: "mod+[", expected: false },
  {
    name: "German slash",
    key: "/",
    code: "Digit7",
    shiftKey: true,
    binding: "mod+shift+7",
    expected: false,
  },
  {
    name: "German slash remap",
    key: "/",
    code: "Digit7",
    shiftKey: true,
    binding: "mod+shift+/",
    expected: true,
  },
  { name: "AZERTY ampersand", key: "&", code: "Digit1", binding: "mod+1", expected: false },
  {
    name: "AZERTY digit",
    key: "1",
    code: "Digit1",
    shiftKey: true,
    binding: "mod+shift+1",
    expected: true,
  },
  {
    name: "AZERTY accented number row",
    key: "é",
    code: "Digit2",
    binding: "mod+2",
    expected: false,
  },
  { name: "AZERTY zero position", key: "à", code: "Digit0", binding: "mod+0", expected: false },
  { name: "AZERTY A", key: "a", code: "KeyQ", binding: "mod+a", expected: true },
  { name: "AZERTY Q position", key: "a", code: "KeyQ", binding: "mod+q", expected: false },
  { name: "AZERTY M", key: "m", code: "Semicolon", binding: "mod+m", expected: true },
  { name: "AZERTY comma", key: ",", code: "KeyM", binding: "mod+m", expected: false },
  {
    name: "US shifted bracket",
    key: "}",
    code: "BracketRight",
    shiftKey: true,
    binding: "mod+shift+]",
    expected: false,
  },
  {
    name: "US shifted bracket remap",
    key: "}",
    code: "BracketRight",
    shiftKey: true,
    binding: "mod+shift+}",
    expected: true,
  },
  {
    name: "US shifted number",
    key: "!",
    code: "Digit1",
    shiftKey: true,
    binding: "mod+shift+1",
    expected: false,
  },
  {
    name: "Option glyph",
    key: "∫",
    code: "KeyB",
    altKey: true,
    binding: "mod+alt+b",
    expected: false,
  },
  { name: "non-Latin letter", key: "и", code: "KeyB", binding: "mod+b", expected: false },
  { name: "missing punctuation", key: "", code: "BracketRight", binding: "mod+]", expected: true },
  {
    name: "unidentified letter",
    key: "Unidentified",
    code: "KeyB",
    binding: "mod+b",
    expected: true,
  },
  { name: "dead punctuation", key: "Dead", code: "Quote", binding: "mod+'", expected: true },
  {
    name: "named key with conflicting code",
    key: "Enter",
    code: "BracketRight",
    binding: "mod+]",
    expected: false,
  },
  {
    name: "unknown code",
    key: "Unidentified",
    code: "constructor",
    binding: "mod+]",
    expected: false,
  },
  { name: "escape alias", key: "Esc", code: "Escape", binding: "mod+esc", expected: true },
];

describe.each(["MacIntel", "Win32", "Linux"])("HTML frame keybindings on %s", (platform) => {
  it.each(fixtures)("matches $name identically in the frame and host", (fixture) => {
    const shortcut = parseKeybindingShortcut(fixture.binding)!;
    const input = {
      key: fixture.key,
      code: fixture.code,
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
      altKey: fixture.altKey ?? false,
      shiftKey: fixture.shiftKey ?? false,
    };
    const hostMatches = matchesKeybindingShortcut(input, shortcut, platform);
    const page = frame(platform);
    page.configure([{ ...shortcut, metaKey: input.metaKey, ctrlKey: input.ctrlKey }]);
    expect(hostMatches).toBe(fixture.expected);
    expect(page.press(input)).toBe(fixture.expected);
    expect(page.messages).toHaveLength(fixture.expected ? 1 : 0);
    if (fixture.expected) expect(page.messages[0]).toMatchObject({ params: input });
  });

  it("uses the host AltGraph policy for layout characters", () => {
    const shortcut = parseKeybindingShortcut("mod+alt+€")!;
    const modifiers = {
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
      altKey: true,
      shiftKey: false,
    };
    const input = { ...modifiers, key: "€", code: "KeyE" };
    const page = frame(platform);
    page.configure([{ ...modifiers, key: "€" }]);
    const expected = platform === "MacIntel";
    expect(
      matchesKeybindingShortcut({ ...input, getModifierState: () => true }, shortcut, platform),
    ).toBe(expected);
    expect(page.press(input, true)).toBe(expected);
  });

  it("does not block a printable key because another binding claims its physical position", () => {
    const page = frame(platform);
    const modifiers = {
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
      shiftKey: false,
      altKey: false,
    };
    page.configure([{ ...modifiers, key: "+" }], [{ ...modifiers, key: "]" }]);
    expect(page.press({ ...modifiers, key: "+", code: "BracketRight" })).toBe(true);
    page.configure([{ ...modifiers, key: "+" }], [{ ...modifiers, key: "+" }]);
    expect(page.press({ ...modifiers, key: "+", code: "BracketRight" })).toBe(false);
  });
});
