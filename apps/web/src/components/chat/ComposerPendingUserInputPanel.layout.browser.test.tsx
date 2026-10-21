import "../../index.css";

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

it("keeps a long question header inside the trigger row", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const header = "Which of these deployment strategies should the extension use? ".repeat(4);
  const container = document.createElement("div");
  container.style.width = "320px";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
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
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />,
    ),
  );

  const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
  const headerElement = [...trigger.querySelectorAll("span")].find(
    (element) => element.textContent === header,
  )!;
  expect(headerElement.getBoundingClientRect().right).toBeLessThanOrEqual(
    trigger.getBoundingClientRect().right,
  );
  expect(trigger.scrollWidth).toBeLessThanOrEqual(trigger.clientWidth);

  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
