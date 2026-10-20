import {
  WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type OrchestrationV2ThreadHandoff,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  EnvironmentRpcUnavailableError,
  requestGuarded,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import { canStartThreadHandoff } from "./threadCommands.ts";

export function createThreadHandoffEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  source: {
    readonly threadAtom: (ref: ScopedThreadRef) => Atom.Atom<OrchestrationV2ThreadShell | null>;
    readonly connectedAtom: (id: EnvironmentId) => Atom.Atom<boolean>;
    readonly supportedAtom: (id: EnvironmentId) => Atom.Atom<boolean>;
    readonly hasLocalWorkAtom: (ref: ScopedThreadRef) => Atom.Atom<boolean>;
  },
) {
  const options = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "thread-handoff:options",
    tag: WS_METHODS.threadHandoffOptions,
    staleTimeMs: 0,
  });
  const start = createEnvironmentRpcCommand<
    R,
    E,
    typeof WS_METHODS.threadHandoffStart,
    EnvironmentRpcInput<typeof WS_METHODS.threadHandoffStart> & {
      readonly isCurrent?: () => boolean;
    }
  >(runtime, {
    label: "thread-handoff:start",
    tag: WS_METHODS.threadHandoffStart,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
    },
    execute: (
      input: EnvironmentRpcInput<typeof WS_METHODS.threadHandoffStart> & {
        readonly isCurrent?: () => boolean;
      },
      registry,
      environmentId,
    ) => {
      const { isCurrent, ...payload } = input;
      const ref = { environmentId, threadId: input.threadId };
      const validate = Effect.suspend(() => {
        const thread = registry.get(source.threadAtom(ref));
        const available =
          registry.get(source.connectedAtom(environmentId)) &&
          registry.get(source.supportedAtom(environmentId));
        const handoff = thread?.handoff;
        const retry =
          input.handoffId !== undefined &&
          handoff != null &&
          handoff.handoffId === input.handoffId &&
          (handoff.state === "departing" || handoff.state === "departed") &&
          handoff.environmentId === input.environmentId &&
          (input.projectId === undefined || input.projectId === handoff.projectId);
        return isCurrent?.() !== false &&
          available &&
          (input.handoffId !== undefined
            ? retry
            : canStartThreadHandoff({
                thread,
                connected: true,
                supported: true,
                hasLocalWork: registry.get(source.hasLocalWorkAtom(ref)),
              }))
          ? Effect.void
          : Effect.fail(
              new EnvironmentRpcUnavailableError({
                environmentId,
                message: "This thread can no longer move. Check its current state and try again.",
              }),
            );
      });
      return validate.pipe(
        Effect.andThen(requestGuarded(WS_METHODS.threadHandoffStart, payload, validate)),
      );
    },
  });
  const cancel = createEnvironmentRpcCommand<
    R,
    E,
    typeof WS_METHODS.threadHandoffCancel,
    EnvironmentRpcInput<typeof WS_METHODS.threadHandoffCancel> & {
      readonly isCurrent?: () => boolean;
    }
  >(runtime, {
    label: "thread-handoff:cancel",
    tag: WS_METHODS.threadHandoffCancel,
    execute: (
      input: EnvironmentRpcInput<typeof WS_METHODS.threadHandoffCancel> & {
        readonly isCurrent?: () => boolean;
      },
      registry,
      environmentId,
    ) => {
      const { isCurrent, ...payload } = input;
      const validate = Effect.suspend(() => {
        const handoff = registry.get(
          source.threadAtom({ environmentId, threadId: input.threadId }),
        )?.handoff;
        return isCurrent?.() !== false &&
          registry.get(source.connectedAtom(environmentId)) &&
          (handoff?.state === "pending" ||
            (handoff?.state === "departing" && input.abandon === true)) &&
          handoff.handoffId === input.handoffId
          ? Effect.void
          : Effect.fail(
              new EnvironmentRpcUnavailableError({
                environmentId,
                message: "That pending move is no longer current.",
              }),
            );
      });
      return validate.pipe(
        Effect.andThen(requestGuarded(WS_METHODS.threadHandoffCancel, payload, validate)),
      );
    },
  });
  const availability = Atom.family((key: string) => {
    const ref = JSON.parse(key) as ScopedThreadRef;
    return Atom.make(
      (get) =>
        get(start.permissionAtom(ref.environmentId)) &&
        canStartThreadHandoff({
          thread: get(source.threadAtom(ref)),
          connected: get(source.connectedAtom(ref.environmentId)),
          supported: get(source.supportedAtom(ref.environmentId)),
          hasLocalWork: get(source.hasLocalWorkAtom(ref)),
        }),
    );
  });
  return {
    options,
    start,
    cancel,
    availableAtom: (ref: ScopedThreadRef) => availability(JSON.stringify(ref)),
  };
}

export function threadHandoffNotice(handoff: OrchestrationV2ThreadHandoff | null | undefined) {
  if (!handoff) return null;
  switch (handoff.state) {
    case "pending":
      return {
        title: `Continuing on ${handoff.label} after this turn`,
        detail: "Send new instructions or cancel to keep working here.",
      };
    case "departing":
      return {
        title: `Moving to ${handoff.label}`,
        detail:
          "This thread is read-only while the move finishes. Retry if the connection was interrupted.",
      };
    case "departed":
      return {
        title: `This thread continues on ${handoff.label}`,
        detail: "Continue working in the destination thread.",
      };
    case "failed":
      return { title: `Could not continue on ${handoff.label}`, detail: handoff.lastError };
  }
}
