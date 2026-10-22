import { createElement as h, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { makeThreadProjectionFixture } from "/src/test-fixtures.ts";
import { useComposerDraftStore } from "/src/composerDraftStore.ts";
import { usePendingThreadRequests } from "/src/components/chat/usePendingThreadRequests.ts";
import fixture from "./issue-8963.json" with { type: "json" };

// This is the navigation browser-test probe's projection boundary, not ChatView
// or a provider emulator. Its status buttons never call the server.
export function mountProbe(scenario) {
  if (!["R4", "R6", "R8"].includes(scenario)) throw new Error("Unknown scenario");
  const environmentId = `proof-probe-${scenario}`;
  const threadId = `proof-thread-${scenario}`;
  const target = { environmentId, threadId };
  const ids = scenario === "R6" ? fixture.r6.requestIds : [`proof-${scenario}`];
  const template = makeThreadProjectionFixture();
  const initial = {
    ...template,
    thread: { ...template.thread, id: threadId, title: "Proof A" },
    runtimeRequests: ids.map((id) => ({
      id,
      nodeId: id,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: template.updatedAt,
      resolvedAt: null,
    })),
    turnItems: ids.map((id, ordinal) => ({
      id,
      threadId,
      runId: null,
      nodeId: id,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: template.updatedAt,
      completedAt: template.updatedAt,
      updatedAt: template.updatedAt,
      type: "user_input_request",
      requestId: id,
      questions:
        scenario === "R4"
          ? fixture.r4.questions
          : [
              {
                id: "answer",
                header: id,
                question: "Type a custom answer",
                options: [],
                allowCustomAnswer: true,
              },
            ],
    })),
  };
  useComposerDraftStore.getState().clearComposerContent(target);
  function Probe() {
    const [projection, setProjection] = useState(initial);
    const [chosenRequest, setChosenRequest] = useState(ids[0]);
    const promptRef = useRef("");
    const composerRef = useRef(null);
    const ordered = {
      ...projection,
      runtimeRequests: [...projection.runtimeRequests].sort(
        (a, b) => Number(b.id === chosenRequest) - Number(a.id === chosenRequest),
      ),
    };
    const state = usePendingThreadRequests({
      environmentId,
      activeThreadId: threadId,
      activeThread: projection.thread,
      serverProjection: ordered,
      supportsQuestionAttachments: false,
      composerDraftTarget: target,
      setComposerDraftPrompt: (destination, prompt) =>
        useComposerDraftStore.getState().setPrompt(destination, prompt),
      promptRef,
      composerRef,
      setThreadError: () => {},
    });
    const draft = useComposerDraftStore((store) => store.getComposerDraft(target)?.prompt ?? "");
    const progress = state.activePendingProgress;
    const question = progress?.activeQuestion;
    const close = () => {
      setChosenRequest(ids[0]);
      setProjection({
        ...projection,
        runtimeRequests: projection.runtimeRequests.map((request) => ({
          ...request,
          status: scenario === "R8" ? "expired" : "cancelled",
          resolvedAt: template.updatedAt,
        })),
      });
    };
    return h(
      "main",
      { style: { background: "#111", color: "#eee", minHeight: "100vh" } },
      h("h1", { style: { color: "#fff" } }, `${scenario} · CLIENT HOOK PROBE`),
      h(
        "p",
        null,
        "Synthetic projections · usePendingThreadRequests · native textarea · not ChatView · no backend proof",
      ),
      h("p", null, `Environment ${environmentId}; thread ${threadId}`),
      scenario === "R6"
        ? h(
            "nav",
            { "aria-label": "Fixture request navigation" },
            ids.map((id) => h("button", { key: id, onClick: () => setChosenRequest(id) }, id)),
          )
        : null,
      question
        ? h(
            "section",
            null,
            h("h2", null, `${question.header}: ${question.question}`),
            h("textarea", {
              "aria-label": "Custom answer",
              value: progress.customAnswer,
              disabled: question.allowCustomAnswer === false,
              onChange: (event) =>
                state.onChangeActivePendingUserInputCustomAnswer(question.id, event.target.value),
            }),
            question.options.map((option) =>
              h(
                "button",
                {
                  key: option.label,
                  onClick: () =>
                    state.onSelectActivePendingUserInputOption(question.id, option.label),
                },
                option.label,
              ),
            ),
            !progress.isLastQuestion
              ? h("button", { onClick: state.onAdvanceActivePendingUserInput }, "Next question")
              : null,
          )
        : h("p", null, "Question closed"),
      h("button", { onClick: close }, scenario === "R8" ? "Project expired" : "Project cancelled"),
      h("h2", null, "Ordinary thread draft"),
      h("textarea", { "aria-label": "Ordinary draft", value: draft, readOnly: true }),
      h(
        "pre",
        null,
        JSON.stringify(
          { statuses: projection.runtimeRequests.map((r) => r.status), draft },
          null,
          2,
        ),
      ),
    );
  }
  const host = document.createElement("div");
  const style = document.createElement("style");
  style.textContent =
    "body{margin:0;background:#111;color:#eee;font:16px system-ui}main{padding:32px;max-width:1000px;margin:auto}h1{font-size:24px}h2{font-size:18px}textarea{display:block;box-sizing:border-box;width:100%;height:120px;padding:12px;background:#222;color:#fff;border:1px solid #777;font:16px monospace}button{padding:10px 16px;margin:12px 12px 12px 0;background:#eee;color:#111;border:0;border-radius:6px}pre{white-space:pre-wrap}";
  document.head.append(style);
  document.body.replaceChildren(host);
  createRoot(host).render(h(Probe));
}
