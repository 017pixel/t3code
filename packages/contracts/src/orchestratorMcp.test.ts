import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2Command } from "./orchestrationV2.ts";
import {
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadImportInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
} from "./orchestratorMcp.ts";

const decodeCreateThreadsInput = Schema.decodeUnknownSync(OrchestratorMcpCreateThreadsInput);
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadImportInput = Schema.decodeUnknownSync(OrchestratorMcpThreadImportInput);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeThreadImportInputResult = Schema.decodeUnknownResult(OrchestratorMcpThreadImportInput);
const decodeCommandResult = Schema.decodeUnknownResult(OrchestrationV2Command);
const decodeThreadInterruptInput = Schema.decodeUnknownSync(OrchestratorMcpThreadInterruptInput);
const decodeThreadListInput = Schema.decodeUnknownSync(OrchestratorMcpThreadListInput);
const decodeThreadReadInput = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeThreadSendInput = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
const decodeThreadWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);

describe("orchestrator MCP contracts", () => {
  it.each(["malformed timestamp", "total text over 2,000,000 characters"])(
    "rejects imported history with %s at MCP and native command boundaries",
    (violation) => {
      const text = "x".repeat(200_000);
      const messages = Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text,
        createdAt: `2026-10-06T10:0${index}:00.000Z`,
      }));
      const request = {
        source: {
          environmentId: "environment:source",
          threadId: "thread:source",
          handoffId: "handoff:one",
        },
        projectId: "project:import",
        title: "Continue the investigation",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        messages,
      };
      const command = {
        type: "thread.create",
        commandId: "command:import",
        threadId: "thread:import",
        projectId: request.projectId,
        title: request.title,
        modelSelection: request.modelSelection,
        createdBy: "agent",
        creationSource: "mcp",
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        importedConversation: { messages },
      };

      expect(decodeThreadImportInput(request).messages).toEqual(messages);
      expect(decodeCommand(command)).toMatchObject({ importedConversation: { messages } });

      const invalidMessages =
        violation === "malformed timestamp"
          ? [{ role: "user", text: "Earlier question", createdAt: "not-a-date" }]
          : [...messages, { role: "user", text: "x", createdAt: "2026-10-06T10:10:00.000Z" }];
      const mcp = decodeThreadImportInputResult({
        ...request,
        messages: invalidMessages,
      });
      const native = decodeCommandResult({
        ...command,
        importedConversation: { messages: invalidMessages },
      });

      expect({ mcp: mcp._tag, native: native._tag }).toEqual({
        mcp: "Failure",
        native: "Failure",
      });
    },
  );

  it.each([
    { field: "handoffId", invalid: ["../../escape", "handoff:unsafe"] },
    { field: "branch", invalid: ["feature/../escape"] },
    { field: "tip", invalid: ["abc1234", "g".repeat(40)] },
    { field: "snapshot", invalid: ["abc1234", "g".repeat(64)] },
  ])("rejects malformed bundle $field at the import wire boundary", ({ field, invalid }) => {
    const request = {
      source: {
        environmentId: "environment:source",
        threadId: "thread:source",
        handoffId: "handoff-one",
      },
      projectId: "project:import",
      title: "Continue the investigation",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      messages: [{ role: "user", text: "Earlier question", createdAt: "2026-10-06T10:00:00.000Z" }],
      bundle: {
        attachmentId: "pending/handoff-one.bundle",
        branch: "feature/continue",
        tip: "a".repeat(40),
        snapshot: "b".repeat(64),
        repository: { canonicalKey: null, sourceRoot: "/source/repo" },
      },
    };
    expect(decodeThreadImportInput(request)).toEqual(request);
    expect(
      decodeThreadImportInput({
        ...request,
        bundle: { ...request.bundle, branch: null, tip: "a".repeat(64), snapshot: "b".repeat(40) },
      }).bundle?.branch,
    ).toBeNull();
    for (const value of invalid) {
      const malformed =
        field === "handoffId"
          ? { ...request, source: { ...request.source, handoffId: value } }
          : { ...request, bundle: { ...request.bundle, [field]: value } };
      expect(decodeThreadImportInputResult(malformed)._tag, field + ": " + value).toBe("Failure");
    }
  });

  it("accepts explicit worktree isolation and keeps shared delegation as the default", () => {
    expect(decodeDelegateTaskInput({ task: "Review changes" }).isolation).toBeUndefined();
    expect(
      decodeDelegateTaskInput({ task: "Review changes", isolation: "worktree" }).isolation,
    ).toBe("worktree");
    expect(() => decodeDelegateTaskInput({ task: "Review changes", isolation: "copy" })).toThrow();
  });
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
  });

  it("decodes target model options in canonical and shorthand shapes", () => {
    const canonical = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: [{ id: "reasoning", value: "low" }],
      },
    });
    const shorthand = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: { reasoning: "low", fastMode: true },
      },
    });

    expect(canonical.target?.options).toEqual([{ id: "reasoning", value: "low" }]);
    expect(shorthand.target?.options).toEqual([
      { id: "reasoning", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("rejects target model options that are not strings or booleans", () => {
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: { reasoning: 3 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: [{ id: "reasoning", value: null }],
        },
      }),
    ).toThrow();
  });

  it("decodes mixed prompted and empty thread batches", () => {
    const request = decodeCreateThreadsInput({
      clientRequestId: "threads-1",
      threads: [
        { title: "Inherited empty thread" },
        {
          prompt: "Review the API.",
          target: { driverKind: "claudeAgent" },
          runtimeMode: "approval-required",
        },
      ],
    });

    expect(request.threads).toHaveLength(2);
    expect(request.threads[0]?.prompt).toBeUndefined();
    expect(request.threads[1]?.target?.driverKind).toBe("claudeAgent");
  });

  it("decodes project-scoped thread orchestration requests", () => {
    expect(
      decodeThreadListInput({
        statuses: ["running", "completed"],
        includeSubagents: false,
        limit: 25,
      }).statuses,
    ).toEqual(["running", "completed"]);
    expect(
      decodeThreadReadInput({
        threadId: "thread-loop-1",
        view: "activity",
        afterPosition: 10,
      }).afterPosition,
    ).toBe(10);
    expect(
      decodeThreadSendInput({
        threadId: "thread-loop-1",
        message: "Continue with the next iteration.",
        mode: "steer",
        clientRequestId: "send-loop-2",
      }).mode,
    ).toBe("steer");
    expect(
      decodeThreadWaitInput({
        threadId: "thread-loop-1",
        runId: "run-loop-2",
        timeoutMs: 5_000,
      }).runId,
    ).toBe("run-loop-2");
    expect(
      decodeThreadInterruptInput({
        threadId: "thread-loop-1",
        reason: "Loop converged.",
      }).reason,
    ).toBe("Loop converged.");
  });
});
