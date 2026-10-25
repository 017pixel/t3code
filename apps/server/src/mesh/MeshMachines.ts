// EXPERIMENTAL mesh v1: the machine a tool's `machine` argument names.
import { type MeshMachineRef, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as MeshServices from "./Services.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/**
 * Resolves a `machine` argument: an environment id, else a label in any case. None is this
 * machine. Refuses a member agents cannot use now: offline, or on an older T3 Code.
 */
export const resolveMachine = Effect.fn("MeshMachines.resolveMachine")(function* (
  membership: MeshServices.MeshMembership["Service"],
  machine: string,
) {
  const snapshot = yield* membership.snapshot;
  if (Option.isNone(snapshot)) {
    const status = yield* membership.status;
    return yield* failure(
      "mesh_unavailable",
      `This machine is not in a mesh (${status.unavailableReason ?? "off"}), so it cannot run on ${machine}.`,
    );
  }
  const { members, selfEnvironmentId } = snapshot.value;
  const query = machine.trim();
  if (query === selfEnvironmentId) return Option.none<MeshMachineRef>();
  const byId = members.filter((member) => member.environmentId === query);
  const matches =
    byId.length > 0
      ? byId
      : members.filter((member) => member.label.trim().toLowerCase() === query.toLowerCase());
  const [match] = matches;
  if (match === undefined) {
    return yield* failure(
      "machine_not_found",
      `No mesh machine is named ${query}. Machines: ${members.map((member) => member.label).join(", ") || "none"}.`,
    );
  }
  if (matches.length > 1) {
    return yield* failure(
      "machine_ambiguous",
      `More than one mesh machine is labeled ${query}: ${matches.map((member) => member.environmentId).join(", ")}. Pass its environment id.`,
    );
  }
  if (match.environmentId === selfEnvironmentId) return Option.none<MeshMachineRef>();
  if (match.capabilities.meshAgents !== true) {
    return yield* failure(
      "machine_unreachable",
      `${match.label} runs a T3 Code version that agents on other machines cannot reach.`,
    );
  }
  if (!match.online) return yield* failure("machine_offline", `${match.label} is offline.`);
  return Option.some<MeshMachineRef>({ environmentId: match.environmentId, label: match.label });
});
