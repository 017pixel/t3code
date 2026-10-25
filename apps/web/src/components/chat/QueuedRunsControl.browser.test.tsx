import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

vi.mock(import("../../state/turnDeliveries"), async () => {
  const { createTurnDeliveries } = await import("@t3tools/client-runtime/state/turn-delivery");
  const { useSyncExternalStore } = await import("react");
  const Cause = await import("effect/Cause");
  const { AsyncResult } = await import("effect/reactivity");
  const turnDeliveries = createTurnDeliveries<unknown, unknown, unknown>({
    send: async () =>
      AsyncResult.failure(Cause.fail({ _tag: "RpcClientError", message: "SocketCloseError" })),
    // A thread that never resyncs keeps a lost send waiting.
    observeThread: (_environmentId, _threadId, listener) => {
      listener({ status: "live" } as never);
      return () => undefined;
    },
    observeShell: () => () => undefined,
    releaseDisplay: () => undefined,
  });
  return {
    turnDeliveries,
    usePendingTurnDeliveries: (environmentId: string, threadId: string) =>
      useSyncExternalStore(turnDeliveries.subscribe, turnDeliveries.getSnapshot).filter(
        (delivery) => delivery.environmentId === environmentId && delivery.threadId === threadId,
      ),
  } as never;
});

import { render as renderUi } from "../../../test/render";
import { turnDeliveries } from "../../state/turnDeliveries";
import { QueuedRunsControl } from "./QueuedRunsControl";

function setup() {
  state.projection = null;
  state.workflow = null;
  for (const delivery of turnDeliveries.getSnapshot()) turnDeliveries.cancel(delivery.key);
  expect(turnDeliveries.getSnapshot()).toEqual([]);
}

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />);
}

it("previews assistant quotes as readable text and preserves the citation when editing", async () => {
  setup();
  const quotedText = "Cache the parsed config per worktree.";
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
    ],
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await renderQueue({ onEditQueuedRun });

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Edit queued message", exact: true }).nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  );
});

it("cancels a queued send that is waiting on a reconnect", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = { activeRun: { id: "run:active" }, canPromoteToSteer: true, queuedRuns: [] };
  const message = {
    id: MessageId.make("message:queued"),
    inputIntent: "queued_turn" as const,
    text: "Run the tests next",
    attachments: [],
  };
  const outcome = await turnDeliveries.deliver(
    baseProps.environmentId,
    {
      commandId: CommandId.make("command:queued"),
      threadId: baseProps.threadId,
      message: { messageId: message.id, role: "user", text: message.text, attachments: [] },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    () => message as never,
  );
  expect(outcome.type).toBe("waiting");
  await using _screen = await renderQueue({ optimisticMessages: [message] });

  await page.getByRole("button", { name: "Cancel waiting queued message", exact: true }).click();

  expect(outcome.type === "waiting" && (await outcome.settled)).toEqual({ type: "cancelled" });
  expect(turnDeliveries.getSnapshot()).toEqual([]);
});
