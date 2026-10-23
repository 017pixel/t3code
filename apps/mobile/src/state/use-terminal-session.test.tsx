import { EMPTY_TERMINAL_BUFFER_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  attach: {},
  metadata: {},
  output: vi.fn(() => "retained output"),
}));
vi.mock("./session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./terminal", () => ({
  terminalEnvironment: {
    attach: () => mocks.attach,
    metadata: () => mocks.metadata,
  },
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === mocks.attach
        ? {
            ...EMPTY_TERMINAL_BUFFER_STATE,
            version: 1,
            output: {
              ...EMPTY_TERMINAL_BUFFER_STATE.output,
              retainedBytes: 15,
              nextOffset: 15,
              chunks: [
                {
                  startOffset: 0,
                  byteLength: 15,
                  get data() {
                    return mocks.output();
                  },
                },
              ],
            },
          }
        : [],
    error: null,
  }),
}));

import { useAttachedTerminalSession } from "./use-terminal-session";

it.each([false, true])(
  "only materializes retained history for legacy surfaces (%s)",
  (materializeBuffer) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.output.mockClear();
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
    const root = createRoot(container as unknown as HTMLElement);
    const input = {
      environmentId: EnvironmentId.make("environment"),
      terminal: { threadId: ThreadId.make("thread"), terminalId: "term-1" },
      materializeBuffer,
    };
    const displayed = vi.fn();
    function Probe() {
      const { buffer } = useAttachedTerminalSession(input);
      useEffect(() => {
        displayed(buffer);
      }, [buffer]);
      return null;
    }
    try {
      act(() => root.render(<Probe />));
      expect(displayed).toHaveBeenLastCalledWith(materializeBuffer ? "retained output" : "");
      expect(mocks.output).toHaveBeenCalledTimes(materializeBuffer ? 1 : 0);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
