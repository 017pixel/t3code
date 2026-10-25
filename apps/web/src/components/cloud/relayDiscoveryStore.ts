import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  type ConnectionCatalogEntry,
  hasRelayRoute,
  orchestrationProtocolCompatibilityError,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { Discovery } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { environmentPresentations } from "~/state/presentation";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { toastManager } from "../ui/toast";

const EMPTY_DISCOVERY_REFRESH_INTERVAL_MS = 5_000;

type SavedComputers = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">;
    readonly connection: { readonly phase: string };
  }
>;

export function discoveredCompatibilityError(
  status: Option.Option<RelayEnvironmentStatusResponse> | undefined,
) {
  const descriptor = status === undefined ? undefined : Option.getOrNull(status)?.descriptor;
  return descriptor === undefined ? null : orchestrationProtocolCompatibilityError(descriptor);
}

function refreshRelayDiscovery(registry: AtomRegistry.AtomRegistry) {
  return runAtomCommand(registry, relayEnvironmentDiscovery.refresh, undefined, {
    reportFailure: false,
  });
}

/**
 * One per list instance: a shared atom would refresh only for the first of
 * several lists mounted at once, so a newly opened view could show a stale list.
 */
export function makeRelayDiscoveryRefreshAtom() {
  return Atom.make((get) => {
    void refreshRelayDiscovery(get.registry);
  }).pipe(Atom.withLabel("relay-discovery-refresh-on-view"));
}

/** Relay computers with an add or route request in flight, shared by every connect list. */
export const relayConnectingIdsAtom = Atom.make(
  new Set<EnvironmentId>() as ReadonlySet<EnvironmentId>,
).pipe(Atom.keepAlive, Atom.withLabel("relay-connecting-environment-ids"));

function savedWithoutRelay(saved: SavedComputers, environmentId: EnvironmentId) {
  const computer = saved.get(environmentId);
  return computer !== undefined && !hasRelayRoute(computer.entry);
}

export async function connectRelayEnvironment(
  registry: AtomRegistry.AtomRegistry,
  environment: RelayClientEnvironmentRecord,
): Promise<boolean> {
  const id = environment.environmentId;
  const discovered = registry.get(relayEnvironmentDiscovery.stateValueAtom).environments.get(id);
  if (discoveredCompatibilityError(discovered?.status) !== null) return false;
  const addsRoute = savedWithoutRelay(registry.get(environmentPresentations.presentationsAtom), id);
  registry.update(relayConnectingIdsAtom, (current) => new Set([...current, id]));
  const result = await runAtomCommand(
    registry,
    environmentCatalog.register,
    new RelayConnectionRegistration({
      target: new RelayConnectionTarget({ environmentId: id, label: environment.label }),
    }),
    { reportFailure: false },
  );
  registry.update(relayConnectingIdsAtom, (current) => {
    const next = new Set(current);
    next.delete(id);
    return next;
  });
  if (result._tag === "Success") {
    toastManager.add({
      type: "success",
      title: addsRoute ? "T3 Connect route added" : "Environment added",
      description: addsRoute
        ? `${environment.label} falls back to T3 Connect when its other routes are unreachable.`
        : `Connecting to ${environment.label} through T3 Connect.`,
    });
    return true;
  }
  if (isAtomCommandInterrupted(result)) return false;
  const cause = squashAtomCommandFailure(result);
  const message =
    cause instanceof Error ? cause.message : "Could not connect the T3 Connect environment.";
  const traceId = findErrorTraceId(cause);
  console.error("[t3-connect] Could not connect environment", { message, traceId, cause });
  toastManager.add({
    type: "error",
    title: "Could not connect environment",
    description: message,
    data: traceId
      ? {
          secondaryActionProps: {
            children: "Copy trace ID",
            onClick: () => void navigator.clipboard?.writeText(traceId),
          },
        }
      : undefined,
  });
  return false;
}

/**
 * A computer saved over another route already has its own selection row, and
 * selecting it must not add a T3 Connect route as a side effect.
 */
function isSelectableRelayComputer(saved: SavedComputers, environmentId: EnvironmentId) {
  return !savedWithoutRelay(saved, environmentId);
}

/** Explicit picks; anything without one falls back to its default. */
export type ComputerChoices = ReadonlyMap<EnvironmentId, boolean>;

/** Saved computers default to selected while enabled; relay computers only once chosen. */
export function resolveSelectedComputers(
  saved: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly entry: { readonly enabled: boolean };
  }>,
  choices: ComputerChoices,
): ReadonlySet<EnvironmentId> {
  const selected = new Set<EnvironmentId>();
  for (const { environmentId, entry } of saved) {
    if (choices.get(environmentId) ?? entry.enabled) selected.add(environmentId);
  }
  for (const [environmentId, chosen] of choices) {
    if (chosen) selected.add(environmentId);
  }
  return selected;
}

export interface RelayAutoSelection {
  readonly choices: ComputerChoices;
  readonly connect: ReadonlyArray<RelayClientEnvironmentRecord>;
}

/**
 * Picks each newly health-checked relay computer once and deselects ones this
 * client cannot use. Saved computers keep their own default.
 */
export function planRelayAutoSelection(
  discovery: Discovery.RelayEnvironmentDiscoveryState,
  saved: SavedComputers,
  choices: ComputerChoices,
  options: { readonly waitForHealthChecks: boolean },
): RelayAutoSelection {
  const discovered = [...discovery.environments.values()];
  if (
    options.waitForHealthChecks &&
    (discovered.length === 0 || discovered.some(({ availability }) => availability === "checking"))
  ) {
    return { choices, connect: [] };
  }
  const next = new Map(choices);
  const connect: RelayClientEnvironmentRecord[] = [];
  for (const { environment, status, availability } of discovered) {
    const id = environment.environmentId;
    if (!isSelectableRelayComputer(saved, id) || availability === "checking") continue;
    const savedComputer = saved.get(id);
    if (
      discoveredCompatibilityError(status) !== null ||
      savedComputer?.connection.phase === "unsupported"
    ) {
      next.set(id, false);
      continue;
    }
    if (savedComputer !== undefined || next.has(id)) continue;
    next.set(id, true);
    connect.push(environment);
  }
  const changed =
    next.size !== choices.size || [...next].some(([id, chosen]) => choices.get(id) !== chosen);
  return { choices: changed ? next : choices, connect };
}

function hasSelectableRelayComputer(
  discovery: Discovery.RelayEnvironmentDiscoveryState,
  saved: SavedComputers,
) {
  for (const { environment } of discovery.environments.values()) {
    if (isSelectableRelayComputer(saved, environment.environmentId)) return true;
  }
  return false;
}

export interface ComputerSelectionOptions {
  /** Auto-select only once every discovered computer has finished its health check. */
  readonly waitForHealthChecks: boolean;
  /** Refresh discovery on mount even while the tab is hidden. */
  readonly refreshWhileHidden: boolean;
}

export interface ComputerSelection {
  readonly choicesAtom: Atom.Writable<ComputerChoices>;
  /** True once the discovery refresh started by the current mount has settled. */
  readonly discoveryReadyAtom: Atom.Atom<boolean>;
  /**
   * Mount while the discovered computers are shown. It refreshes discovery,
   * auto-selects new computers as results arrive, and polls while none is listed.
   */
  readonly discoveryAtom: Atom.Atom<void>;
  readonly choose: (environmentId: EnvironmentId, selected: boolean) => void;
}

export function createComputerSelection(
  registry: AtomRegistry.AtomRegistry,
  options: ComputerSelectionOptions,
): ComputerSelection {
  const choicesAtom = Atom.make<ComputerChoices>(new Map());
  const discoveryReadyAtom = Atom.make(false);
  const choose = (environmentId: EnvironmentId, selected: boolean) =>
    registry.update(choicesAtom, (current) => new Map(current).set(environmentId, selected));

  const discoveryAtom = Atom.make((get) => {
    const readSaved = () => registry.get(environmentPresentations.presentationsAtom);
    const readDiscovery = () => registry.get(relayEnvironmentDiscovery.stateValueAtom);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let disposed = false;
    let activity = getDocumentActivity();

    // Discovery clears its list on refresh, so poll only until a computer appears.
    const waitingForComputer = () => {
      const discovery = readDiscovery();
      return !discovery.offline && !hasSelectableRelayComputer(discovery, readSaved());
    };
    const stopPolling = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      stopPolling();
      if (!disposed && getDocumentActivity().visible) {
        timer = setTimeout(() => void poll(), EMPTY_DISCOVERY_REFRESH_INTERVAL_MS);
      }
    };
    const poll = async () => {
      stopPolling();
      if (disposed || pending || !getDocumentActivity().visible || !waitingForComputer()) return;
      pending = true;
      const discovery = readDiscovery();
      if (!discovery.refreshing && !discovery.offline) await refreshRelayDiscovery(registry);
      pending = false;
      if (waitingForComputer()) schedule();
    };

    const autoSelect = () => {
      const plan = planRelayAutoSelection(
        readDiscovery(),
        readSaved(),
        registry.get(choicesAtom),
        options,
      );
      registry.set(choicesAtom, plan.choices);
      for (const environment of plan.connect) {
        void connectRelayEnvironment(registry, environment).then((connected) => {
          if (!connected) choose(environment.environmentId, false);
        });
      }
    };

    if (options.refreshWhileHidden || activity.visible) {
      // The refresh clears the discovered list, so readiness restarts with it.
      registry.set(discoveryReadyAtom, false);
      void refreshRelayDiscovery(registry).then(() => {
        if (!disposed) registry.set(discoveryReadyAtom, true);
      });
    }
    const onComputersChanged = () => {
      autoSelect();
      if (!waitingForComputer()) stopPolling();
      else if (timer === undefined && !pending) schedule();
    };
    get.subscribe(environmentPresentations.presentationsAtom, onComputersChanged);
    get.subscribe(relayEnvironmentDiscovery.stateValueAtom, onComputersChanged, {
      immediate: true,
    });
    const unsubscribeActivity = subscribeDocumentActivity(() => {
      const previous = activity;
      activity = getDocumentActivity();
      if (!activity.visible) stopPolling();
      else if (!previous.visible || (activity.focused && !previous.focused)) void poll();
    });
    get.addFinalizer(() => {
      disposed = true;
      stopPolling();
      unsubscribeActivity();
    });
  }).pipe(Atom.withLabel("relay-discovery-computer-selection"));

  return { choicesAtom, discoveryReadyAtom, discoveryAtom, choose };
}
