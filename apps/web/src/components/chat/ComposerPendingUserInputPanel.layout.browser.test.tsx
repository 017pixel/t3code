import "../../index.css";

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

async function renderPanel(
  header: string,
  run: (
    container: HTMLDivElement,
    rerender: (answers: Record<string, PendingUserInputDraftAnswer>) => Promise<void>,
  ) => Promise<void>,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  container.style.width = "320px";
  document.body.append(container);
  const root = createRoot(container);
  const rerender = (answers: Record<string, PendingUserInputDraftAnswer>) =>
    act(async () =>
      root.render(
        <ComposerPendingUserInputPanel
          pendingUserInputs={[
            {
              requestId: RuntimeRequestId.make("long-header"),
              createdAt: "2026-10-20T00:00:00.000Z",
              dismissible: true,
              responseCapability: "live",
              questions: [
                {
                  id: "strategy",
                  header,
                  question: "Pick one.",
                  options: [{ label: "Rolling", description: "One node at a time" }],
                  multiSelect: false,
                },
              ],
            },
          ]}
          cwd="/repo"
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={answers}
          questionIndex={0}
          onToggleOption={() => {}}
          onAdvance={() => {}}
          onDismiss={() => {}}
        />,
      ),
    );
  try {
    await rerender({});
    await run(container, rerender);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}

it("keeps a long question header inside the trigger row", async () => {
  const header = "Which of these deployment strategies should the extension use? ".repeat(4);
  await renderPanel(header, async (container) => {
    const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
    const headerElement = [...trigger.querySelectorAll("span")].find(
      (element) => element.textContent === header,
    )!;
    expect(headerElement.getBoundingClientRect().right).toBeLessThanOrEqual(
      trigger.getBoundingClientRect().right,
    );
    expect(trigger.scrollWidth).toBeLessThanOrEqual(trigger.clientWidth);
  });
});

it("selects an option without resizing its row or keycap", async () => {
  await renderPanel("Strategy", async (container, rerender) => {
    const measure = () => {
      const row = container.querySelector<HTMLElement>("button[aria-pressed]")!;
      const key = row.querySelector("[data-pending-user-input-option-key]")!;
      return {
        row: row.getBoundingClientRect().toJSON(),
        key: key.getBoundingClientRect().toJSON(),
      };
    };
    const unselected = measure();
    await rerender({ strategy: { selectedOptionValues: ["Rolling"] } });
    expect(container.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(measure()).toEqual(unselected);
  });
});
