import { describe, expect, it } from "vite-plus/test";

import {
  formatSnapShotShortcutLabel,
  parseDesktopSnapShotShortcut,
  snapShotShortcutKeyLabels,
} from "./snapShotShortcut";

describe("window capture shortcut labels", () => {
  it.each([
    [
      "MacIntel",
      { kind: "both-shift-keys" } as const,
      "Left Shift + Right Shift",
      ["Left ⇧", "Right ⇧"],
    ],
    [
      "MacIntel",
      { kind: "modifier-pair", modifier: "meta" } as const,
      "Left Command + Right Command",
      ["Left ⌘", "Right ⌘"],
    ],
    [
      "Win32",
      { kind: "modifier-pair", modifier: "meta" } as const,
      "Left Super + Right Super",
      ["Left ⊞", "Right ⊞"],
    ],
  ])("names both physical sides of a modifier pair on %s", (platform, shortcut, label, keys) => {
    expect(formatSnapShotShortcutLabel(shortcut, platform)).toBe(label);
    expect(snapShotShortcutKeyLabels(shortcut, platform)).toEqual(keys);
  });

  it("keeps ordinary chords unsided", () => {
    const shortcut = parseDesktopSnapShotShortcut("Ctrl+Shift+2")!;
    expect(snapShotShortcutKeyLabels(shortcut, "Linux")).toEqual(["Ctrl", "⇧", "2"]);
    expect(formatSnapShotShortcutLabel(shortcut, "Linux")).not.toMatch(/Left|Right/);
  });
});

describe("desktop-approved window capture shortcut labels", () => {
  it.each([
    ["Press <Shift><Control>2", ["Ctrl", "⇧", "2"]],
    ["Ctrl+Shift+8", ["Ctrl", "⇧", "8"]],
    ["Meta+F12", ["Super", "F12"]],
    ["<Primary><Alt>Return", ["Ctrl", "Alt", "Enter"]],
    ["<Super>Left", ["Super", "Left"]],
    ["<Control>space", ["Ctrl", "Space"]],
    ["<Control>plus", ["Ctrl", "+"]],
    ["Ctrl++", ["Ctrl", "+"]],
  ])("formats %s using the shared keycap labels", (label, expected) => {
    const shortcut = parseDesktopSnapShotShortcut(label);
    expect(shortcut).not.toBeNull();
    expect(snapShotShortcutKeyLabels(shortcut!, "Linux")).toEqual(expected);
  });

  it.each([
    "",
    "Ctrl+",
    "Press the shortcut configured in your desktop",
    "<Unknown>2",
    "<Control>UnknownKey",
  ])("does not guess keys from an unrecognized description: %s", (label) => {
    expect(parseDesktopSnapShotShortcut(label)).toBeNull();
  });
});
