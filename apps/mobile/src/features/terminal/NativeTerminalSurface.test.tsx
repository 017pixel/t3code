import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
  terminalOutputText,
} from "@t3tools/client-runtime/state/terminal";
import { act, useImperativeHandle, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { NativeSyntheticEvent } from "react-native";
import { expect, it, vi } from "vite-plus/test";

import type { NativeTerminalSurfaceProps } from "./nativeTerminalModule";

const mocks = vi.hoisted(() => ({
  revision: 0,
  initialBuffers: [] as string[],
  write: vi.fn(async (_data: string, _reset: boolean) => {}),
}));

function RawView({ ref: nativeRef, initialBuffer, onResize }: NativeTerminalSurfaceProps) {
  useImperativeHandle(nativeRef, () => ({ writeOutput: mocks.write }));
  useLayoutEffect(() => {
    mocks.initialBuffers.push(initialBuffer);
  }, [initialBuffer]);
  useLayoutEffect(() => {
    onResize?.({ nativeEvent: { cols: 80, rows: 24 } } as NativeSyntheticEvent<{
      cols: number;
      rows: number;
    }>);
  }, [onResize]);
  return null;
}

vi.mock("expo", () => ({
  requireNativeView: () => RawView,
  requireOptionalNativeModule: () => ({ outputRevision: mocks.revision }),
}));
vi.mock("react-native", () => ({ View: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../lib/typography", () => ({ MOBILE_TYPOGRAPHY: { label: { fontSize: 10 } } }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark", themeId: "default" }),
}));
vi.mock("./terminalTheme", () => ({
  buildGhosttyThemeConfig: () => "theme",
  getMobileTerminalTheme: () => ({}),
}));

import { TerminalSurface } from "./NativeTerminalSurface";

function setup(revision: number) {
  mocks.revision = revision;
  mocks.initialBuffers = [];
  mocks.write.mockClear();
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("expo", { getViewConfig: () => ({}) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(container as unknown as HTMLElement);
  return {
    async render(
      state: typeof EMPTY_TERMINAL_BUFFER_STATE,
      terminalKey = "environment:thread:term-1",
    ) {
      await act(async () => {
        root.render(
          <TerminalSurface
            terminalKey={terminalKey}
            output={state.version === 0 ? null : state.output}
            buffer={
              state.version === 0 ? null : revision >= 1 ? "" : terminalOutputText(state.output)
            }
            isRunning
            onInput={() => {}}
            onResize={() => {}}
          />,
        );
      });
    },
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it.each([0, 1])(
  "uses append/reset only on capable installed binaries (revision %s)",
  async (revision) => {
    await using harness = setup(revision);
    let state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: "thread",
        terminalId: "term-1",
        data: "retained",
      },
      8,
    );
    await harness.render(state);
    state = applyTerminalAttachStreamEvent(
      state,
      {
        type: "output",
        threadId: "thread",
        terminalId: "term-1",
        data: "-new",
      },
      8,
    );
    await harness.render(state);
    await harness.render(EMPTY_TERMINAL_BUFFER_STATE);
    if (revision === 1) {
      expect(mocks.initialBuffers).toEqual([""]);
      expect(mocks.write.mock.calls).toEqual([
        ["retained", true],
        ["-new", false],
      ]);
      await harness.render(state, "another-environment:thread:term-1");
      expect(mocks.write).toHaveBeenLastCalledWith("ined-new", true);
    } else {
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.initialBuffers).toEqual(["retained", "ined-new"]);
    }
  },
);
