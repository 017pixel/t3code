// EXPERIMENTAL mesh v1. Where an agent tool call runs, and the call to another member when it is
// not here. McpToolAccess routes tools through this; without this service every tool is local.
import {
  type MeshMachineRef,
  type MeshOwnsRequest,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";

import * as MeshMachines from "./MeshMachines.ts";
import * as MeshMcpClient from "./MeshMcpClient.ts";
import * as MeshOwners from "./MeshOwners.ts";
import * as MeshServices from "./Services.ts";

export interface MeshMachine extends MeshMachineRef {
  readonly online: boolean;
  readonly self: boolean;
}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const isFailureCode = Schema.is(OrchestratorMcpFailure.fields.code);

/** Keeps the remote refusal code so the agent sees why, and says which machine refused. */
const meshCallFailure = (
  machine: MeshMachineRef,
  error: MeshServices.MeshCredentialsError | MeshServices.MeshRemoteToolError,
): OrchestratorMcpFailure => {
  switch (error._tag) {
    case "MeshRemoteToolError":
      return failure(
        isFailureCode(error.code) ? error.code : "orchestration_error",
        `On ${machine.label}: ${error.message}`,
      );
    case "MeshUnavailableError":
      return failure("mesh_unavailable", error.message);
    case "MeshNotMemberError":
      return failure("machine_not_found", `${machine.label} is not a reachable mesh machine.`);
    case "MeshMemberOfflineError":
      return failure("machine_offline", `${machine.label} is offline.`);
    case "MeshMemberUnreachableError":
    case "MeshGrantRefusedError":
    case "MeshSessionRefusedError":
      return failure(
        "machine_unreachable",
        `${machine.label} could not be reached: ${error.message}`,
      );
  }
};

export class MeshForwarding extends Context.Service<
  MeshForwarding,
  {
    /** This machine and the members agents can reach. Empty when not in a mesh. */
    readonly machines: Effect.Effect<ReadonlyArray<MeshMachine>>;
    /** Resolves a `machine` argument: an environment id, else a label. This machine is local. */
    readonly resolveMachine: (
      machine: string,
    ) => Effect.Effect<MeshOwners.MeshPlacement, OrchestratorMcpFailure>;
    readonly resolveOwner: (
      target: MeshOwnsRequest,
    ) => Effect.Effect<MeshOwners.MeshPlacement, OrchestratorMcpFailure>;
    /**
     * The retry key a forwarded call carries: the same caller here retrying the same request
     * always sends the same key, whatever session reaches the member.
     */
    readonly requestKey: (
      scope: { readonly environmentId: string; readonly requestNamespace: string },
      clientRequestId: string,
    ) => Effect.Effect<string>;
    /** Runs a tool on a member and returns its undecoded structured result. */
    readonly callTool: (
      machine: MeshMachineRef,
      toolName: string,
      args: Readonly<Record<string, unknown>>,
      options: MeshServices.MeshToolCallOptions,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/mesh/MeshForwarding") {}

const makeRequestKey =
  (crypto: Crypto.Crypto): MeshForwarding["Service"]["requestKey"] =>
  (scope, clientRequestId) =>
    crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          [scope.environmentId, scope.requestNamespace, clientRequestId].join("\u0000"),
        ),
      )
      .pipe(
        Effect.map((digest) => `mesh:${Base64Url.encode(digest)}`),
        Effect.orDie,
      );

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const membership = yield* MeshServices.MeshMembership;
  const owners = yield* MeshOwners.MeshOwners;
  const client = yield* MeshServices.MeshMcpClient;

  const machines = membership.snapshot.pipe(
    Effect.map(
      Option.match({
        onNone: () => [],
        onSome: (snapshot): ReadonlyArray<MeshMachine> => {
          const self = snapshot.members.find(
            (member) => member.environmentId === snapshot.selfEnvironmentId,
          );
          return [
            ...(self === undefined
              ? []
              : [{ ...MeshOwners.machineRef(self), online: true, self: true }]),
            ...MeshOwners.agentMembers(snapshot).map((member) => ({
              ...MeshOwners.machineRef(member),
              online: member.online,
              self: false,
            })),
          ];
        },
      }),
    ),
  );

  const resolveMachine = (machine: string) =>
    MeshMachines.resolveMachine(membership, machine).pipe(
      Effect.map(
        Option.match({
          onNone: () => MeshOwners.localPlacement,
          onSome: (ref): MeshOwners.MeshPlacement => ({ _tag: "remote", machine: ref }),
        }),
      ),
    );

  const callTool = Effect.fn("MeshForwarding.callTool")(function* (
    machine: MeshMachineRef,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    options: MeshServices.MeshToolCallOptions,
  ) {
    return yield* client
      .callTool(machine.environmentId, toolName, args, options)
      .pipe(Effect.mapError((error) => meshCallFailure(machine, error)));
  });

  return MeshForwarding.of({
    machines,
    resolveMachine,
    resolveOwner: owners.resolve,
    requestKey: makeRequestKey(crypto),
    callTool,
  });
});

export const layer = Layer.effect(MeshForwarding, make);

/** A server without the mesh layers: every tool runs here and `machine` is refused. */
const layerUnavailable = Layer.effect(
  MeshForwarding,
  Effect.map(Crypto.Crypto, (crypto) =>
    MeshForwarding.of({
      machines: Effect.succeed([]),
      resolveMachine: (machine) =>
        Effect.fail(
          failure(
            "mesh_unavailable",
            `This machine is not in a mesh, so it cannot run on ${machine}.`,
          ),
        ),
      resolveOwner: () => Effect.succeed(MeshOwners.localPlacement),
      requestKey: makeRequestKey(crypto),
      callTool: () => Effect.fail(failure("mesh_unavailable", "This machine is not in a mesh.")),
    }),
  ),
);

/** The live mesh tool path when the server runs the mesh layers, else {@link layerUnavailable}. */
export const layerWhenMeshAvailable = Layer.unwrap(
  Effect.gen(function* () {
    const membership = yield* Effect.serviceOption(MeshServices.MeshMembership);
    const credentials = yield* Effect.serviceOption(MeshServices.MeshCredentials);
    if (Option.isNone(membership) || Option.isNone(credentials)) return layerUnavailable;
    return layer.pipe(
      Layer.provide(Layer.mergeAll(MeshOwners.layer, MeshMcpClient.layer)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(MeshServices.MeshMembership, membership.value),
          Layer.succeed(MeshServices.MeshCredentials, credentials.value),
        ),
      ),
    );
  }),
);
