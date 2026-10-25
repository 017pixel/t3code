import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

import { readEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const ORCHESTRATION_OPERATE_DENIED_MESSAGE =
  "This connection cannot change threads or projects.";

function operateDenied<A>(
  environmentId: EnvironmentId,
): AtomCommandResult<A, EnvironmentAuthorizationError> | null {
  return readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: ORCHESTRATION_OPERATE_DENIED_MESSAGE,
          }),
        ),
      );
}

export function useOrchestrationCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> {
  const run = useAtomCommand(command, options);
  return async (value: W): Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> =>
    operateDenied<A>(value.environmentId) ?? run(value);
}

/** For callers that outlive the component that started them. */
export async function runOrchestrationCommand<
  W extends { readonly environmentId: EnvironmentId },
  A,
  E,
>(
  command: AtomCommand<W, A, E>,
  value: W,
  options?: AtomCommandOptions,
): Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> {
  return (
    operateDenied<A>(value.environmentId) ??
    runAtomCommand(appAtomRegistry, command, value, options)
  );
}
