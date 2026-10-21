import "../../index.css";

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text, className }: { text: string; className?: string }) => (
    <p className={className}>{text}</p>
  )) as never,
}));

import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

async function renderPanel(
  {
    header,
    question = "Pick one.",
    questionCount = 1,
  }: { header: string; question?: string; questionCount?: number },
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
                questions: Array.from({ length: questionCount }, (_, index) => ({
                  id: index === 0 ? "strategy" : `strategy-${index}`,
                  header,
                  question,
                  options: [{ label: "Rolling", description: "One node at a time" }],
                  multiSelect: false,
                })),
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

it("keeps a long question header inside the collapsed trigger row", async () => {
  const header = "Which of these deployment strategies should the extension use? ".repeat(4);
  await renderPanel({ header }, async (container) => {
    const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
    await act(async () => trigger.click());
    const headerElement = [...trigger.querySelectorAll("span")].find(
      (element) => element.textContent === header,
    )!;
    expect(headerElement.getBoundingClientRect().right).toBeLessThanOrEqual(
      trigger.getBoundingClientRect().right,
    );
    expect(trigger.scrollWidth).toBeLessThanOrEqual(trigger.clientWidth);
  });
});

it("selects an option by swapping its number for a check without resizing the row", async () => {
  await renderPanel({ header: "Strategy" }, async (container, rerender) => {
    const measure = () => {
      const row = container.querySelector<HTMLElement>("button[aria-pressed]")!;
      const key = row.querySelector("[data-pending-user-input-option-key]")!;
      return {
        row: row.getBoundingClientRect().toJSON(),
        key: key.getBoundingClientRect().toJSON(),
      };
    };
    const key = () => container.querySelector("[data-pending-user-input-option-key]")!;
    const unselected = measure();
    const rowRect = container.querySelector("button[aria-pressed]")!.getBoundingClientRect();
    // The indicator trails the label at the row's right edge.
    expect(unselected.key.left).toBeGreaterThan(rowRect.left + rowRect.width / 2);
    expect(key().textContent).toBe("1");
    await rerender({ strategy: { selectedOptionValues: ["Rolling"] } });
    expect(container.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(key().querySelector("svg")).not.toBeNull();
    expect(measure()).toEqual(unselected);
  });
});

it.each([
  ["mobile", 414],
  ["sm", 1024],
])(
  "aligns the title, question and options inside the banner surface at %s width",
  async (_, width) => {
    await page.viewport(width, 900);
    const longQuestion = "Explain which rollout you prefer and why it fits this service. ".repeat(
      40,
    );
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
        const [title, questionParagraph] = container.querySelectorAll("p");
        expect(gaps(title!)).toEqual(row);
        expect(gaps(questionParagraph!)).toEqual(row);
      });
    }
  },
);

it.each([
  ["generic", "Question", ["Pick one."], "Pick one."],
  ["distinct", "Strategy", ["Strategy", "Pick one."], "StrategyPick one."],
])(
  "leads with the %s header's content while expanded and summarizes it when collapsed",
  async (_, header, expandedLines, collapsedText) => {
    await renderPanel({ header }, async (container) => {
      const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
      const paragraphs = () => [...container.querySelectorAll("p")];
      expect(trigger.dataset.pendingUserInputToggle).toBe("expanded");
      expect(trigger.textContent).toBe("");
      expect(trigger.getAttribute("aria-label")).toBe("Hide the question and its options");
      expect(paragraphs().map((paragraph) => paragraph.textContent)).toEqual(expandedLines);
      // Whatever leads is set at the primary 14px size; a question under a title steps down.
      const [lead, ...rest] = paragraphs();
      expect(getComputedStyle(lead!).fontSize).toBe("14px");
      for (const paragraph of rest) {
        expect(paragraph.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          lead!.getBoundingClientRect().bottom,
        );
        expect(Number.parseFloat(getComputedStyle(paragraph).fontSize)).toBeLessThan(14);
      }

      await act(async () => trigger.click());
      expect(trigger.dataset.pendingUserInputToggle).toBe("collapsed");
      expect(trigger.textContent).toBe(collapsedText);

      await act(async () => trigger.click());
      expect(trigger.dataset.pendingUserInputToggle).toBe("expanded");
      expect(trigger.textContent).toBe("");
    });
  },
);

it.each([
  ["generic header", "mobile", 414],
  ["generic header", "sm", 1024],
  ["title", "mobile", 414],
  ["title", "sm", 1024],
])(
  "starts the leading %s beside the actions without overlapping them at %s width",
  async (lead, _, width) => {
    await page.viewport(width, 900);
    // One unbreakable run fills every line, so only the first line's width reflects the actions.
    const run = "x".repeat(200);
    await renderPanel(
      lead === "title"
        ? { header: run, question: "Pick one.", questionCount: 3 }
        : { header: "Question", question: run, questionCount: 3 },
      async (container) => {
        const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
        const actions = trigger.querySelector("[data-slot=composer-banner-actions]")!;
        const paragraph = container.querySelector("p")!;
        expect(paragraph.textContent).toBe(run);
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const [firstLine, secondLine] = range.getClientRects();
        const actionsRect = actions.getBoundingClientRect();
        const paragraphRect = paragraph.getBoundingClientRect();
        // The old header strip pushed the content below the whole trigger row.
        expect(paragraphRect.top).toBeLessThan(trigger.getBoundingClientRect().bottom);
        const firstLineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
        expect(paragraphRect.top + firstLineHeight / 2).toBeCloseTo(
          actionsRect.top + actionsRect.height / 2,
          0,
        );
        expect(firstLine!.right).toBeLessThanOrEqual(actionsRect.left);
        expect(secondLine!.right).toBeGreaterThan(actionsRect.left);

        const count = [...actions.querySelectorAll("span")].find(
          (element) => element.textContent === "1/3",
        )!;
        const caret = actions.querySelector("svg")!;
        const countToCaret =
          caret.getBoundingClientRect().left - count.getBoundingClientRect().right;
        expect(countToCaret).toBeGreaterThanOrEqual(0);
        expect(countToCaret).toBeLessThanOrEqual(4);
      },
    );
  },
);
