import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ module: null as { outputRevision?: number } | null }));
vi.mock("expo", () => ({
  requireNativeView: () => () => null,
  requireOptionalNativeModule: () => mocks.module,
}));

import { supportsNativeTerminalOutput } from "./nativeTerminalModule";

it.each([null, {}, { outputRevision: 0 }, { outputRevision: 1 }])(
  "requires an explicit installed native output capability (%j)",
  (module) => {
    mocks.module = module;
    const expo = Object.getOwnPropertyDescriptor(globalThis, "expo");
    Object.defineProperty(globalThis, "expo", {
      configurable: true,
      value: { getViewConfig: () => ({}) },
    });
    try {
      expect(supportsNativeTerminalOutput()).toBe(module?.outputRevision === 1);
    } finally {
      if (expo) Object.defineProperty(globalThis, "expo", expo);
      else Reflect.deleteProperty(globalThis, "expo");
    }
  },
);
