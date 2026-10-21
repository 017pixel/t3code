import "../../index.css";

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

async function renderPanel(
  { header, question = "Pick one." }: { header: string; question?: string },
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
        <ComposerBanner.Root>
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
                    question,
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
          />
        </ComposerBanner.Root>,
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
  await renderPanel({ header }, async (container) => {
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
  await renderPanel({ header: "Strategy" }, async (container, rerender) => {
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

it.each([
  ["mobile", 414],
  ["sm", 1024],
])("centers the question and options inside the banner surface at %s width", async (_, width) => {
  await page.viewport(width, 900);
  const longQuestion = "Explain which rollout you prefer and why it fits this service. ".repeat(40);
  for (const question of ["Pick one.", longQuestion]) {
    await renderPanel({ header: "Strategy", question }, async (container) => {
      const viewport = container.querySelector("[data-slot=scroll-area-viewport]")!;
      if (question === longQuestion) {
        await vi.waitFor(() => expect(viewport.hasAttribute("data-has-overflow-y")).toBe(true));
      } else {
        expect(viewport.hasAttribute("data-has-overflow-y")).toBe(false);
      }
      const surface = container.querySelector("[data-slot=composer-banner]")!;
      const bounds = surface.getBoundingClientRect();
      const gaps = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left - bounds.left, right: bounds.right - rect.right };
      };
      const row = gaps(container.querySelector("button[aria-pressed]")!);
      expect(row.left).toBeCloseTo(16, 0);
      expect(row.right).toBeCloseTo(row.left, 0);
      expect(gaps(container.querySelector("p")!)).toEqual(row);
    });
  }
});

it("drops a generic header from the trigger while keeping the toggle working", async () => {
  await renderPanel({ header: "Question" }, async (container) => {
    const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
    expect(trigger.dataset.pendingUserInputToggle).toBe("expanded");
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Hide the question and its options");
    expect(container.querySelector("p")?.textContent).toBe("Pick one.");

    await act(async () => trigger.click());
    expect(trigger.dataset.pendingUserInputToggle).toBe("collapsed");
    expect(trigger.textContent).toBe("Pick one.");

    await act(async () => trigger.click());
    expect(trigger.dataset.pendingUserInputToggle).toBe("expanded");
    expect(trigger.textContent).toBe("");
  });
});
