import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import type { EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useContext, useMemo } from "react";

import { serverEnvironment } from "../state/server";

interface EnvironmentResources {
  readonly environmentId: EnvironmentId;
  readonly resources: HostResourcesSnapshot | null;
  readonly receivedAt: number;
  readonly pending: boolean;
  readonly failed: boolean;
}

// Shared by every caller without candidates. A fresh atom per render would be
// read before it is subscribed and produce a new empty array, which makes
// React render the chat view again after it commits.
const NO_ENVIRONMENT_RESOURCES = Atom.make<ReadonlyArray<EnvironmentResources>>([]);

/** Only mounted for unresolved automatic drafts, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  const registry = useContext(RegistryContext);
  const refresh = useCallback(
    (ids: readonly EnvironmentId[]) => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
    },
    [registry],
  );
  const resourcesAtom = useMemo(
    () =>
      environmentIds.length === 0
        ? NO_ENVIRONMENT_RESOURCES
        : Atom.make((get): ReadonlyArray<EnvironmentResources> =>
            environmentIds.map((environmentId) => {
              const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
              return {
                environmentId,
                resources: result._tag === "Success" ? result.value : null,
                receivedAt: result._tag === "Success" ? result.timestamp : 0,
                pending: result._tag === "Initial" || result.waiting,
                failed: result._tag === "Failure",
              };
            }),
          ),
    [environmentIds],
  );
  const resources = useAtomValue(resourcesAtom);
  const pending = resources.some((resource) => resource.pending);
  const environmentId = chooseLoadBalancedEnvironment(
    resources.map((resource) => ({
      ...resource,
      weight: weights[resource.environmentId] ?? 50,
    })),
    Date.now(),
  ) as EnvironmentId | null;
  return {
    refresh,
    pending,
    environmentId,
    failed: !pending && environmentId === null && resources.some((resource) => resource.failed),
  };
}
