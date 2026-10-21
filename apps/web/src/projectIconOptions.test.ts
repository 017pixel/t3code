import { AlarmClockCheck, ArrowDown01, Layers3 } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { lucideIconByName } from "./lib/lucideIconByName";
import {
  filterProjectIconNames,
  firstEmoji,
  normalizeProjectMonogramInput,
} from "./projectIconOptions";

describe("projectIconOptions", () => {
  it("resolves every offered icon name, including saved legacy spellings", () => {
    for (const name of filterProjectIconNames("")) expect(lucideIconByName(name)).toBeDefined();
    expect(lucideIconByName("layers-3")).toBe(Layers3);
    expect(lucideIconByName("arrow-down-01")).toBe(ArrowDown01);
    expect(lucideIconByName("arrow-down-0-1")).toBe(ArrowDown01);
    expect(lucideIconByName("alarm-check")).toBe(AlarmClockCheck);
    expect(lucideIconByName("create-lucide-icon")).toBeUndefined();
  });

  it("limits typed or pasted monograms after normalization and uppercase expansion", () => {
    expect(normalizeProjectMonogramInput("abc")).toBe("AB");
    expect(normalizeProjectMonogramInput("  ａｂｃ  ")).toBe("AB");
    expect(normalizeProjectMonogramInput("ßa")).toBe("SS");
    expect(normalizeProjectMonogramInput("㍿")).toBe("株式");
    expect(normalizeProjectMonogramInput("ab")).toBe("AB");
  });

  it("keeps complete monogram graphemes and leaves invalid characters for validation", () => {
    expect(normalizeProjectMonogramInput("a\u0301\u0323bc")).toBe("Ạ\u0301B");
    expect(normalizeProjectMonogramInput("𐐨bc")).toBe("𐐀B");
    expect(normalizeProjectMonogramInput("  ")).toBe("");
    expect(normalizeProjectMonogramInput("a!")).toBe("A!");
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
  });
});
