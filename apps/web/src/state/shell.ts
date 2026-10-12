import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentCatalogState,
  enabledEnvironmentIds,
} from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { readBootSnapshot } from "../bootSnapshot";
import {
  bootHoldAtom,
  environmentCatalog,
  readBootCatalogState,
  startBootCatalogRecorder,
} from "../connection/catalog";
import { primaryEnvironmentMissingAtom } from "../connection/platform";
import { connectionAtomRuntime } from "../connection/runtime";
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
const liveEnvironmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);

function readBootShell(environmentId: EnvironmentId): OrchestrationV2ShellSnapshot | null {
  return readBootSnapshot()?.shells.get(environmentId) ?? null;
}

const bootOverlays = new Map<
  EnvironmentId,
  WeakMap<EnvironmentShellState, EnvironmentShellState>
>();

/**
 * Until the live state holds a snapshot (from IndexedDB or the server), the
 * boot snapshot stands in as cached data, keeping the live status and error.
 */
function withBootShell(
  environmentId: EnvironmentId,
  live: EnvironmentShellState,
): EnvironmentShellState {
  if (Option.isSome(live.snapshot) || live.status === "live") return live;
  const boot = readBootShell(environmentId);
  if (boot === null) return live;
  let overlays = bootOverlays.get(environmentId);
  if (overlays === undefined) {
    overlays = new WeakMap();
    bootOverlays.set(environmentId, overlays);
  }
  let overlay = overlays.get(live);
  if (overlay === undefined) {
    overlay = {
      snapshot: Option.some(boot),
      status: live.status === "empty" ? "cached" : live.status,
      error: live.error,
    };
    overlays.set(live, overlay);
  }
  return overlay;
}

const EMPTY_LIVE_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};
const bootStateResults = new WeakMap<
  EnvironmentShellState,
  AsyncResult.AsyncResult<EnvironmentShellState, never>
>();

function bootStateResult(state: EnvironmentShellState) {
  let result = bootStateResults.get(state);
  if (result === undefined) {
    result = AsyncResult.success(state);
    bootStateResults.set(state, result);
  }
  return result;
}

/** Shell state with the boot snapshot standing in until live data arrives. */
export const environmentShell = {
  stateAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (get(bootHoldAtom)) {
        const held = withBootShell(environmentId, EMPTY_LIVE_SHELL_STATE);
        if (held !== EMPTY_LIVE_SHELL_STATE) return bootStateResult(held);
      }
      const live = get(liveEnvironmentShell.stateAtom(environmentId));
      if (AsyncResult.isFailure(live)) return live;
      const liveState = Option.getOrElse(AsyncResult.value(live), () => EMPTY_LIVE_SHELL_STATE);
      const shown = withBootShell(environmentId, liveState);
      return shown === liveState ? live : bootStateResult(shown);
    }).pipe(Atom.withLabel(`web-environment-shell-state:${environmentId}`)),
  ),
  stateValueAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (get(bootHoldAtom)) {
        const held = withBootShell(environmentId, EMPTY_LIVE_SHELL_STATE);
        if (held !== EMPTY_LIVE_SHELL_STATE) return held;
      }
      return withBootShell(environmentId, get(liveEnvironmentShell.stateValueAtom(environmentId)));
    }).pipe(Atom.withLabel(`web-environment-shell-state-value:${environmentId}`)),
  ),
};
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (
    catalog !== readBootCatalogState() &&
    Option.isNone(AsyncResult.value(get(environmentCatalog.catalogAtom)))
  ) {
    return false;
  }
  // The persisted catalog emits before platform discovery registers the
  // primary environment. Until it does, an empty workspace is unknown. A
  // discovery that ends without the primary settles the landing without it.
  if (
    !isHostedStaticApp() &&
    !isLocalEnvironmentDisabled() &&
    !get(primaryEnvironmentMissingAtom) &&
    !Array.from(catalog.entries.values()).some(
      (entry) => entry.target._tag === "PrimaryConnectionTarget",
    )
  ) {
    return false;
  }
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

/**
 * Keeps every enabled environment's live shell subscribed, which is what
 * connects it. Unlike the boot-aware atoms above, it reads the live atoms even
 * while the first screen paints from the boot snapshot, so connecting runs
 * alongside that paint instead of after it.
 */
const liveEnvironmentShellsAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) return;
  for (const environmentId of enabledEnvironmentIds(catalog.value)) {
    get(liveEnvironmentShell.stateAtom(environmentId));
  }
}).pipe(Atom.withLabel("web-live-environment-shells"));

let environmentShellsStarted = false;

/**
 * Builds the connection runtime, reads every enabled environment's cached
 * shell, and starts its connection without waiting for the first render to
 * read them. Called once the app knows it will render the workspace. The
 * mount lasts for the session, like the sidebar that reads the same atoms.
 */
export function startEnvironmentShells(): void {
  if (environmentShellsStarted) return;
  environmentShellsStarted = true;
  appAtomRegistry.mount(liveEnvironmentShellsAtom);
  appAtomRegistry.mount(allEnvironmentShellsBootstrappedAtom);
  startBootCatalogRecorder();
}

/**
 * The persisted catalog can emit before platform discovery registers the primary environment.
 * Neither that gap nor an empty catalog proves a project is absent.
 */
function catalogIsComplete(
  catalog: EnvironmentCatalogState,
  requiresPrimaryEnvironment: boolean,
): boolean {
  if (!catalog.isReady || catalog.entries.size === 0) return false;
  return (
    !requiresPrimaryEnvironment ||
    Array.from(catalog.entries.values()).some(
      (entry) => entry.target._tag === "PrimaryConnectionTarget",
    )
  );
}

/** Cached or missing snapshots cannot establish that a saved project no longer exists. */
export function createAllEnvironmentProjectSnapshotsReadyAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly requiresPrimaryEnvironment: boolean;
}) {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    if (!catalogIsComplete(catalog, input.requiresPrimaryEnvironment)) return false;
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) return false;
    }
    return true;
  }).pipe(Atom.withLabel("web-all-environment-project-snapshots-ready"));
}

export const allEnvironmentProjectSnapshotsReadyAtom =
  createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: environmentCatalog.catalogValueAtom,
    shellStateValueAtom: environmentShell.stateValueAtom,
    requiresPrimaryEnvironment: !isHostedStaticApp(),
  });

/**
 * Every enabled machine has sent its live projects or has settled offline. Prompt links wait for
 * it before they decide a repository is missing: one offline machine must not hold a link
 * forever. A machine that has not started connecting yet is "available", not offline.
 */
export const allReachableShellsLiveAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalogIsComplete(catalog, !isHostedStaticApp())) return false;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) continue;
    const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
    if (Option.isNone(state)) return false;
    const connection = state.value;
    const settledOffline =
      connection.phase === "offline" ||
      connection.phase === "blocked" ||
      (connection.phase === "backoff" && connection.attempt > 2);
    if (!settledOffline) return false;
  }
  return true;
}).pipe(Atom.withLabel("web-all-reachable-shells-live"));
