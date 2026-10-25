// EXPERIMENTAL mesh v1. Helpers for tool calls that run on another mesh member.
import { type MeshMachineRef, OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";

import type * as MeshForwarding from "../mesh/MeshForwarding.ts";
import type * as MeshServices from "../mesh/Services.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpMeshLaunch from "./McpMeshLaunch.ts";
import { type Caller, unavailable } from "./threadAccess.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";

/** The Connect edge drops requests idle for about 100 s, so a forwarded wait goes in pieces. */
export const FORWARDED_WAIT_CHUNK_MS = 50_000;

/** The caller's modes and identity, sent with every forwarded call. */
export const meshCallOptions = (caller: Caller): MeshServices.MeshToolCallOptions => ({
  modeLimit: caller.limits,
  caller:
    caller.scope.thread !== undefined
      ? { kind: "thread", threadId: caller.scope.thread.threadId }
      : { kind: "client", access: caller.scope.client?.access ?? "read-only" },
});

/** `machine` picks where a call runs; the handler that runs it never sees it. */
export const withoutMachine = <P>(params: P): P => {
  if (typeof params !== "object" || params === null || !("machine" in params)) return params;
  const { machine: _machine, ...rest } = params;
  return rest as P;
};

export interface ToolCodecs<P, A> {
  readonly encodeParameters: (params: P) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decodeSuccess: (raw: unknown) => Effect.Effect<A, Schema.SchemaError>;
}

/** Advertised codecs, the same ones `/mcp` decodes arguments and encodes results with. */
export const toolCodecs = <T extends Tool.Any>(
  tool: T,
): ToolCodecs<Tool.Parameters<T>, Tool.Success<T>> => ({
  encodeParameters: Schema.encodeUnknownEffect(Schema.toCodecJson(tool.parametersSchema)) as (
    params: Tool.Parameters<T>,
  ) => Effect.Effect<unknown, Schema.SchemaError>,
  decodeSuccess: Schema.decodeUnknownEffect(tool.successSchema) as (
    raw: unknown,
  ) => Effect.Effect<Tool.Success<T>, Schema.SchemaError>,
});

const objectArguments = (encoded: unknown): Readonly<Record<string, unknown>> =>
  typeof encoded === "object" && encoded !== null ? { ...encoded } : {};

/** Runs `name` on `machine` with params minus `machine`, and decodes its result. */
export const forwardWith = Effect.fn("McpMeshRouting.forward")(function* <P, A>(
  mesh: MeshForwarding.MeshForwarding["Service"],
  name: string,
  codecs: ToolCodecs<P, A>,
  machine: MeshMachineRef,
  params: P,
  options: MeshServices.MeshToolCallOptions,
) {
  const args = yield* codecs
    .encodeParameters(withoutMachine(params))
    .pipe(Effect.mapError(unavailable));
  const raw = yield* mesh.callTool(machine, name, objectArguments(args), options);
  return yield* codecs.decodeSuccess(raw).pipe(Effect.mapError(unavailable));
});

/**
 * The member keys retries by the calling machine alone, so a caller's `clientRequestId` goes out
 * as `MeshForwarding.requestKey`: two callers here never share a key there.
 */
export const withForwardedRequestKey = <P>(
  mesh: MeshForwarding.MeshForwarding["Service"],
  scope: McpInvocationContext.McpInvocationScope,
  params: P,
): Effect.Effect<P> => {
  if (
    typeof params !== "object" ||
    params === null ||
    !("clientRequestId" in params) ||
    typeof params.clientRequestId !== "string"
  ) {
    return Effect.succeed(params);
  }
  return mesh
    .requestKey(scope, params.clientRequestId)
    .pipe(Effect.map((key) => ({ ...params, clientRequestId: key })));
};

/** Like {@link forwardTool}, decoding the answer with `success`, such as a list's plain result. */
export const forwardToolAs = <T extends Tool.Any, A>(
  mesh: MeshForwarding.MeshForwarding["Service"],
  tool: T,
  success: Schema.Codec<A, unknown>,
  machine: MeshMachineRef,
  params: Tool.Parameters<T>,
  options: MeshServices.MeshToolCallOptions,
): Effect.Effect<A, OrchestratorMcpFailure> =>
  forwardWith(
    mesh,
    tool.name,
    {
      encodeParameters: toolCodecs(tool).encodeParameters,
      decodeSuccess: Schema.decodeUnknownEffect(success),
    },
    machine,
    params,
    options,
  );

export const forwardTool = <T extends Tool.Any>(
  mesh: MeshForwarding.MeshForwarding["Service"],
  tool: T,
  machine: MeshMachineRef,
  params: Tool.Parameters<T>,
  options: MeshServices.MeshToolCallOptions,
): Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure> =>
  forwardWith(mesh, tool.name, toolCodecs(tool), machine, params, options);

export interface MeshSection<A> {
  readonly machine: MeshMachineRef;
  readonly online: boolean;
  readonly result?: A;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * One section per machine for `machine: "all"`. Offline members are listed without a call; a
 * member's failure stays in its own section.
 */
export const machineSections = Effect.fn("McpMeshRouting.machineSections")(function* <A, RL, RR>(
  mesh: MeshForwarding.MeshForwarding["Service"],
  local: Effect.Effect<A, OrchestratorMcpFailure, RL>,
  remote: (machine: MeshMachineRef) => Effect.Effect<A, OrchestratorMcpFailure, RR>,
) {
  const machines = yield* mesh.machines;
  const section = <R>(
    machine: MeshMachineRef,
    online: boolean,
    run: Effect.Effect<A, OrchestratorMcpFailure, R>,
  ): Effect.Effect<MeshSection<A>, never, R> =>
    run.pipe(
      Effect.map((result) => ({ machine, online, result })),
      Effect.catch((error) =>
        Effect.succeed({ machine, online, error: { code: error.code, message: error.message } }),
      ),
    );
  if (machines.length === 0) {
    return yield* new OrchestratorMcpFailure({
      code: "mesh_unavailable",
      message: 'This machine is not in a mesh, so machine "all" has nothing to list.',
    });
  }
  return yield* Effect.forEach(
    machines,
    ({ online, self, ...machine }): Effect.Effect<MeshSection<A>, never, RL | RR> =>
      self
        ? section(machine, true, local)
        : online
          ? section(machine, true, remote(machine))
          : Effect.succeed({ machine, online: false } satisfies MeshSection<A>),
    { concurrency: "unbounded" },
  );
});

/** A member to call, with the caller's modes and identity. */
export interface MemberCall {
  readonly mesh: MeshForwarding.MeshForwarding["Service"];
  readonly machine: MeshMachineRef;
  readonly options: MeshServices.MeshToolCallOptions;
}

/** Every project on a member, read through its own `t3_project_list`. */
const memberProjects = (call: MemberCall) =>
  McpMeshLaunch.listMemberProjects(({ cursor, limit }) =>
    forwardTool(
      call.mesh,
      ProjectToolkit.tools.t3_project_list,
      call.machine,
      { cursor, limit },
      call.options,
    ),
  );

/** This machine's project and the member's projects for the same repository. */
export const memberProjectsForRepository = Effect.fn("McpMeshRouting.memberProjectsForRepository")(
  function* (call: MemberCall, projectId: ProjectId) {
    const projects = yield* ProjectService.ProjectService;
    const local = Option.getOrUndefined(
      yield* projects.getById(projectId).pipe(Effect.mapError(unavailable)),
    );
    const key = local === undefined ? null : McpMeshLaunch.projectRepositoryKey(local);
    const remote = key === null ? [] : yield* memberProjects(call);
    return {
      local,
      key,
      matches: remote.filter((project) => McpMeshLaunch.projectRepositoryKey(project) === key),
      remote,
    };
  },
);

/**
 * The member's project for a project here, matched by repository. A project id this machine does
 * not have is taken as the member's own. Refuses with candidates when there is not exactly one.
 */
export const memberProjectFor = Effect.fn("McpMeshRouting.memberProjectFor")(function* (
  call: MemberCall,
  projectId: ProjectId,
) {
  const projects = yield* ProjectService.ProjectService;
  const local = Option.getOrUndefined(
    yield* projects.getById(projectId).pipe(Effect.mapError(unavailable)),
  );
  if (local === undefined) return projectId;
  const key = McpMeshLaunch.projectRepositoryKey(local);
  const remote = yield* memberProjects(call);
  const match: McpMeshLaunch.RepositoryProjectMatch =
    key === null
      ? {
          _tag: "refused",
          reason: `Project ${local.title} has no repository remote, so it has no match on ${call.machine.label}. ${McpMeshLaunch.memberProjectsSummary(remote)}`,
        }
      : McpMeshLaunch.matchRepositoryProject(call.machine.label, key, remote);
  if (match._tag === "found") return match.projectId;
  return yield* new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `${match.reason} Pass projectId with one of ${call.machine.label}'s projects.`,
  });
});
