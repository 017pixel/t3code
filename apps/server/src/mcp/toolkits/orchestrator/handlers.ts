import {
  MESH_ALL_MACHINES,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Tool } from "effect/ai";

import * as MeshForwarding from "../../../mesh/MeshForwarding.ts";
import type * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../../../project/ProjectService.ts";
import { readCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpMeshRouting from "../../McpMeshRouting.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const byThread = <
  P extends { readonly threadId?: Parameters<typeof McpToolAccess.threadTarget>[0] },
>(
  params: P,
) => McpToolAccess.threadTarget(params.threadId);

type ThreadListToolResult = Tool.Success<typeof OrchestratorToolkit.tools.t3_thread_list>;

const listThreadsHere = Effect.fn("mcp.listThreadsHere")(function* (
  input: OrchestratorMcpThreadListInput,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  return yield* service.listThreads(scope, McpMeshRouting.withoutMachine(input));
});

/**
 * A member has no idea which of its projects is this caller's, so a list there without a
 * projectId uses its project for this caller's repository.
 */
const listThreadsOnMember = Effect.fn("mcp.listThreadsOnMember")(function* (
  input: OrchestratorMcpThreadListInput,
  call: McpMeshRouting.MemberCall,
  callerProjectId: Parameters<typeof McpMeshRouting.memberProjectFor>[1] | undefined,
) {
  const projectId =
    input.projectId ??
    (callerProjectId === undefined
      ? undefined
      : yield* McpMeshRouting.memberProjectFor(call, callerProjectId));
  return yield* McpMeshRouting.forwardToolAs(
    call.mesh,
    OrchestratorToolkit.tools.t3_thread_list,
    OrchestratorMcpThreadListResult,
    call.machine,
    { ...input, ...(projectId === undefined ? {} : { projectId }) },
    call.options,
  );
});

/** Forwards a long wait in pieces, all on the run the first piece picked. */
const waitOnMember = Effect.fn("mcp.waitOnMember")(function* (
  input: OrchestratorMcpThreadWaitInput,
  call: McpToolAccess.MeshRemoteCall<
    OrchestratorMcpThreadWaitInput,
    OrchestratorMcpThreadWaitResult
  >,
) {
  let remaining = Math.min(
    OrchestratorMcpService.MAX_WAIT_TIMEOUT_MS,
    Math.max(1, input.timeoutMs ?? OrchestratorMcpService.DEFAULT_WAIT_TIMEOUT_MS),
  );
  let runId = input.runId;
  while (true) {
    const timeoutMs = Math.min(remaining, McpMeshRouting.FORWARDED_WAIT_CHUNK_MS);
    const result = yield* call.forward({
      ...input,
      ...(runId === undefined ? {} : { runId }),
      timeoutMs,
    });
    remaining -= timeoutMs;
    if (!result.timedOut || remaining <= 0) return result;
    runId = result.runId ?? undefined;
  }
});

const handlers = {
  orchestrator_capabilities: McpToolAccess.routed(
    { machine: (input) => input.machine },
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope, input);
        const mesh = yield* Effect.serviceOption(MeshForwarding.MeshForwarding);
        const machines =
          scope.mesh === undefined && Option.isSome(mesh) ? yield* mesh.value.machines : [];
        return machines.length === 0 ? capabilities : { ...capabilities, machines };
      }),
    ),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  ),
  task_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  t3_workflow_stop: McpToolAccess.routed(
    { owner: byThread },
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const { threads } = yield* readCaller();
          return yield* threads.stopWorkflow(input).pipe(
            Effect.as({}),
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({
                  code:
                    cause.reason === "unavailable" || cause.reason === "stop-failed"
                      ? "orchestration_error"
                      : "invalid_request",
                  message: cause.message,
                }),
            ),
          );
        }),
    ),
  ),
  t3_background_wait: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "t3_background_wait");
      return yield* threads
        .awaitBackgroundTasks({
          threadId: caller.thread.threadId,
          taskIds: input.taskIds,
          awaited: input.waiting ?? true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code: cause.reason === "unsupported" ? "invalid_request" : "orchestration_error",
                message: cause.message,
              }),
          ),
        );
    }),
  ),
  schedule_task: McpToolAccess.startsThreads(
    () => ({}),
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.scheduleTask(scope, input);
      }),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  update_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  create_threads: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  t3_thread_list: McpToolAccess.routed(
    {
      owner: (input) => McpToolAccess.projectTarget(input.projectId),
      machine: (input) => (input.machine === MESH_ALL_MACHINES ? undefined : input.machine),
      remote: (input, call) => listThreadsOnMember(input, call, call.caller.caller?.projectId),
    },
    McpToolAccess.reads((input) =>
      Effect.gen(function* (): Effect.fn.Return<
        ThreadListToolResult,
        OrchestratorMcpFailure,
        | McpInvocationContext.McpInvocationContext
        | OrchestratorMcpService.OrchestratorMcpService
        | ThreadManagementService.ThreadManagementService
        | ProjectService.ProjectService
      > {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const mesh = yield* Effect.serviceOption(MeshForwarding.MeshForwarding);
        if (
          input.machine !== MESH_ALL_MACHINES ||
          input.projectId !== undefined ||
          scope.mesh !== undefined ||
          Option.isNone(mesh)
        ) {
          return yield* listThreadsHere(input);
        }
        const caller = yield* readCaller();
        const options = McpMeshRouting.meshCallOptions(caller);
        const sections = yield* McpMeshRouting.machineSections(
          mesh.value,
          listThreadsHere(input),
          (machine) =>
            listThreadsOnMember(
              input,
              { mesh: mesh.value, machine, options },
              caller.caller?.projectId,
            ),
        );
        return { sections };
      }),
    ),
  ),
  t3_thread_read: McpToolAccess.routed(
    { owner: byThread },
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.readThread(scope, input);
      }),
    ),
  ),
  t3_thread_update: McpToolAccess.routed(
    { owner: byThread },
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
          return yield* service.update(scope, input);
        }),
    ),
  ),
  t3_thread_send: McpToolAccess.routed(
    { owner: byThread },
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.sendToThread(scope, input);
        }),
    ),
  ),
  t3_thread_wait: McpToolAccess.routed(
    {
      owner: byThread,
      remote: waitOnMember,
    },
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.waitForThread(scope, input);
      }),
    ),
  ),
  t3_thread_interrupt: McpToolAccess.routed(
    { owner: byThread },
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.interruptThread(scope, input);
        }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
