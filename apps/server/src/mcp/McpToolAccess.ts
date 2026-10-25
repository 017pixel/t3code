import {
  type MeshMachineRef,
  type MeshOwnsRequest,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as MeshForwarding from "../mesh/MeshForwarding.ts";
import type * as MeshServices from "../mesh/Services.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpMeshRouting from "./McpMeshRouting.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

/** Private constructors only enforce types; the token also blocks runtime construction. */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

type Access = "read" | "write";

let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
  access: Access,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

let routeDeclaration: <P, A, E, R, RR>(
  declaration: Declaration<(params: P) => Effect.Effect<A, E, R>>,
  route: MeshRoute<P, A, RR>,
) => Declaration<
  (params: P) => Effect.Effect<A, E | OrchestratorMcpFailure, R | RR | CallerServices>
>;

let bindDeclaration: <Handler>(declaration: Declaration<Handler>, tool: Tool.Any) => Handler;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/**
 * EXPERIMENTAL mesh v1. Where a call runs when this machine is in a mesh (PLAN §8.3). A tool
 * without a route always runs here. Calls from another member always run here too.
 */
export interface MeshRoute<P, A, R = never> {
  /** The id the call acts on; its owner runs it. No id means the caller's own: here. */
  readonly owner?: (params: P) => MeshOwnsRequest | undefined;
  /** A creation or capability tool's `machine` argument. It takes precedence over `owner`. */
  readonly machine?: (params: P) => string | undefined;
  /** Replaces the plain forward for a call that runs elsewhere, such as a chunked wait. */
  readonly remote?: (
    params: P,
    call: MeshRemoteCall<P, A>,
  ) => Effect.Effect<A, OrchestratorMcpFailure, R>;
  /** Threads that must all be here: a thread on another machine is refused, never forwarded. */
  readonly localThreads?: (params: P) => ReadonlyArray<ThreadId | undefined>;
}

export interface MeshRemoteCall<P, A> {
  readonly machine: MeshMachineRef;
  readonly caller: Caller;
  readonly mesh: MeshForwarding.MeshForwarding["Service"];
  readonly options: MeshServices.MeshToolCallOptions;
  /** Sends the params, minus `machine`, to the member and decodes its answer. */
  readonly forward: (params: P) => Effect.Effect<A, OrchestratorMcpFailure>;
}

type CallerServices = Effect.Services<ReturnType<typeof readCaller>>;

/** t3code/no-raw-mcp-registration confines Effect's unchecked registration API to McpHttpServer. */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  readonly #access: Access;
  /** Routed declarations bind to their tool when `toLayer` learns which tool they serve. */
  readonly #bind: ((tool: Tool.Any) => Handler) | undefined;
  private constructor(
    token: typeof builtHere,
    handle: Handler,
    access: Access,
    bind: ((tool: Tool.Any) => Handler) | undefined,
  ) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
    this.#access = access;
    this.#bind = bind;
  }
  static {
    declare = (handle, access) => new Declaration(builtHere, handle, access, undefined);
    routeDeclaration = (declaration, route) => {
      const local = declaration.#handle;
      const access = declaration.#access;
      return new Declaration(builtHere, local, access, (tool) =>
        routedHandler(tool, local, access, route),
      );
    };
    bindDeclaration = (declaration, tool) =>
      declaration.#bind === undefined ? declaration.#handle : declaration.#bind(tool);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

/** Gives a declaration its mesh route (PLAN §8.3). */
export const routed = <P, A, E, R, RR = never>(
  route: MeshRoute<P, A, RR>,
  declaration: Declaration<(params: P) => Effect.Effect<A, E, R>>,
) => routeDeclaration(declaration, route);

export const threadTarget = (threadId: ThreadId | undefined): MeshOwnsRequest | undefined =>
  threadId === undefined ? undefined : { kind: "thread", id: threadId };

export const projectTarget = (projectId: string | undefined): MeshOwnsRequest | undefined =>
  projectId === undefined ? undefined : { kind: "project", id: projectId };

const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    McpInvocationContext.isReadOnlyCaller(scope)
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
);

const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params), "read");

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))), "read");

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.flatMap(() => writingCaller),
        Effect.flatMap(() => handle(params)),
      ),
    "write",
  );

export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))), "write");

/** Requires handler capability checks, not thread control. */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))), "write");

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        for (const threadId of threads(params)) {
          if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
          const target = yield* caller.threads
            .getThreadShell(threadId)
            .pipe(Effect.mapError(unavailable));
          if (target !== null && target.deletedAt === null) {
            yield* assertTargetWithinLimits(caller.limits, target);
          }
        }
        // Modes can rise after this check; the orchestrator rechecks under lock and records refusal before handlers wrap errors.
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        return yield* handle(params).pipe(
          Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
          Effect.catch((error) =>
            Effect.flatMap(Ref.get(refused), (refusal) =>
              Effect.fail<E | OrchestratorMcpFailure>(
                refusal === undefined ? error : escalationDenied(refusal),
              ),
            ),
          ),
        );
      }),
    "write",
  );

const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        const { limits } = yield* writingCaller;
        const requested = modes(params);
        const started: StartedModes = {
          runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
          interactionMode: yield* resolveInteractionMode(
            limits.interactionMode,
            requested.interactionMode,
          ),
        };
        return yield* handle(params, started);
      }),
    "write",
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/** Recheck after waits before writing; caller modes may have changed. */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare((params: P) => check.pipe(Effect.flatMap(() => handle(params, check))), "write");
};

type CheckServices = Effect.Services<typeof orchestratingCaller>;

type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

type NotCallable = { readonly call?: never } & { readonly apply?: never };

export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const localThreadRefused = (threadId: ThreadId, machine: MeshMachineRef) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `Thread ${threadId} is on ${machine.label}. This tool works only on threads on this machine.`,
  });

/**
 * Runs a routed tool here or on its owner. Calls that arrived from another member run here
 * only, so a call is forwarded at most once.
 */
const routedHandler =
  <P, A, E, R, RR>(
    tool: Tool.Any,
    local: (params: P) => Effect.Effect<A, E, R>,
    access: Access,
    route: MeshRoute<P, A, RR>,
  ) =>
  (params: P) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const mesh = yield* Effect.serviceOption(MeshForwarding.MeshForwarding);
      if (scope.mesh !== undefined || Option.isNone(mesh)) {
        return yield* local(McpMeshRouting.withoutMachine(params));
      }
      for (const threadId of route.localThreads?.(params) ?? []) {
        if (threadId === undefined) continue;
        const placement = yield* mesh.value.resolveOwner({ kind: "thread", id: threadId });
        if (placement._tag === "remote") {
          return yield* localThreadRefused(threadId, placement.machine);
        }
      }
      const machine = route.machine?.(params);
      const target = machine === undefined ? route.owner?.(params) : undefined;
      const placement =
        machine !== undefined
          ? yield* mesh.value.resolveMachine(machine)
          : target !== undefined
            ? yield* mesh.value.resolveOwner(target)
            : undefined;
      if (placement === undefined || placement._tag === "local") {
        // A `machine` the route did not take, such as "all", is the handler's to read.
        return yield* local(machine === undefined ? params : McpMeshRouting.withoutMachine(params));
      }
      // Writes refuse a read-only outside agent before anything leaves this machine.
      const caller = access === "write" ? yield* orchestratingCaller : yield* readCaller();
      const options = McpMeshRouting.meshCallOptions(caller);
      const codecs = McpMeshRouting.toolCodecs(tool);
      const call: MeshRemoteCall<P, A> = {
        machine: placement.machine,
        caller,
        mesh: mesh.value,
        options,
        // The tool's own schemas decode what it answers, so the result is this handler's `A`.
        forward: (forwarded) =>
          McpMeshRouting.withForwardedRequestKey(mesh.value, scope, forwarded).pipe(
            Effect.flatMap((keyed) =>
              McpMeshRouting.forwardWith(
                mesh.value,
                tool.name,
                codecs as McpMeshRouting.ToolCodecs<P, A>,
                placement.machine,
                keyed,
                options,
              ),
            ),
          ),
      };
      return yield* route.remote === undefined ? call.forward(params) : route.remote(params, call);
    });

const checkedHandlers = <Handlers>(
  tools: Record<string, Tool.Any>,
  declarations: Declarations<Handlers>,
): Handlers => {
  const handlers = Struct.map(declarations, checkedHandler);
  const byName: Record<string, unknown> = handlers;
  for (const [name, declaration] of Object.entries<Declaration<unknown>>(declarations)) {
    const tool = tools[name];
    if (tool !== undefined) byName[name] = bindDeclaration(declaration, tool);
  }
  return handlers;
};

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build)
        ? Effect.map(build, (declarations) =>
            checkedHandlers<Toolkit.HandlersFrom<Tools>>(toolkit.tools, declarations),
          )
        : checkedHandlers(toolkit.tools, build),
    ),
  );
