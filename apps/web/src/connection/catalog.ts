import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentCatalogAtoms,
  type EnvironmentCatalogState,
} from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { type BootCatalogEntry, readBootSnapshot, recordBootCatalog } from "../bootSnapshot";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentMissingAtom } from "./platform";
import { connectionAtomRuntime } from "./runtime";

const liveCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

function bootTarget(entry: BootCatalogEntry): ConnectionTarget | null {
  const base = { environmentId: entry.environmentId, label: entry.label };
  switch (entry.kind) {
    case "primary": {
      let target: { readonly httpBaseUrl: string; readonly wsBaseUrl: string } | null = null;
      try {
        target = readPrimaryEnvironmentTarget()?.target ?? null;
      } catch {
        // A desktop backend that has not started yet keeps its last address.
      }
      const httpBaseUrl = target?.httpBaseUrl ?? entry.httpBaseUrl;
      const wsBaseUrl = target?.wsBaseUrl ?? entry.wsBaseUrl;
      return httpBaseUrl === undefined || wsBaseUrl === undefined
        ? null
        : new PrimaryConnectionTarget({ ...base, httpBaseUrl, wsBaseUrl });
    }
    case "bearer":
      return entry.connectionId === undefined
        ? null
        : new BearerConnectionTarget({ ...base, connectionId: entry.connectionId });
    case "ssh":
      return entry.connectionId === undefined
        ? null
        : new SshConnectionTarget({ ...base, connectionId: entry.connectionId });
    case "relay":
      return new RelayConnectionTarget(base);
  }
}

let bootCatalogState: EnvironmentCatalogState | null | undefined;

/** The catalog this page booted with, as display-only entries. */
export function readBootCatalogState(): EnvironmentCatalogState | null {
  if (bootCatalogState !== undefined) return bootCatalogState;
  bootCatalogState = null;
  const snapshot = readBootSnapshot();
  if (snapshot === null || snapshot.catalog.length === 0) return null;
  const requiresPrimary = !isHostedStaticApp() && !isLocalEnvironmentDisabled();
  const entries = new Map<EnvironmentId, ConnectionCatalogEntry>();
  try {
    for (const entry of snapshot.catalog) {
      if (entry.kind === "primary" && !requiresPrimary) continue;
      const target = bootTarget(entry);
      if (target === null) continue;
      entries.set(entry.environmentId, {
        target,
        profile: Option.none(),
        enabled: entry.enabled,
      });
    }
  } catch {
    return null;
  }
  if (entries.size === 0) return null;
  bootCatalogState = { isReady: true, entries };
  return bootCatalogState;
}

function hasPrimaryEntry(catalog: EnvironmentCatalogState): boolean {
  for (const entry of catalog.entries.values()) {
    if (entry.target._tag === "PrimaryConnectionTarget") return true;
  }
  return false;
}

/**
 * True from a boot with a snapshot until its first screen is painted. While
 * held, the boot-aware atoms serve only snapshot data, so connection replies
 * arriving meanwhile do not re-render or restart the first screen's renders;
 * the screen switches to live data once, after it has painted. Connecting
 * itself does not wait for it.
 */
export const bootHoldAtom = Atom.make(readBootSnapshot() !== null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-boot-hold"),
);
let bootHoldRetainers = 0;

export function isBootHeld(): boolean {
  return appAtomRegistry.get(bootHoldAtom);
}

function releaseBootHold(): void {
  if (!isBootHeld()) return;
  appAtomRegistry.set(bootHoldAtom, false);
}

/**
 * Keeps the boot hold until the returned function runs. The hold ends when
 * every part of the first screen that retained it has painted.
 */
export function retainBootHold(): () => void {
  if (!isBootHeld()) return () => {};
  bootHoldRetainers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bootHoldRetainers--;
    if (bootHoldRetainers === 0) releaseBootHold();
  };
}

/**
 * Runs `release` after the next frame paints. Hidden windows get no animation
 * frames, hence the timer.
 */
export function releaseBootHoldAfterPaint(release: () => void): () => void {
  const frame = requestAnimationFrame(() => setTimeout(release, 0));
  const timer = setTimeout(release, 250);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    release();
  };
}

if (typeof window !== "undefined" && readBootSnapshot() !== null) {
  // A boot that fails before its first screen still connects.
  setTimeout(releaseBootHold, 10_000);
}

let lastMerged: {
  readonly live: EnvironmentCatalogState;
  readonly merged: EnvironmentCatalogState;
} | null = null;

/**
 * Shows the boot catalog until the live one can stand on its own: the
 * registry has loaded the saved environments and, where there is one,
 * platform discovery has registered the primary environment. A discovery
 * that ends without the primary drops the boot one, so the workspace settles
 * as it does without a snapshot.
 */
const catalogValueAtom = Atom.make((get): EnvironmentCatalogState => {
  const boot = readBootCatalogState();
  if (boot !== null && get(bootHoldAtom)) return boot;
  const live = get(liveCatalog.catalogValueAtom);
  if (boot === null) return live;
  if (!live.isReady) return boot;
  if (hasPrimaryEntry(live) || get(primaryEnvironmentMissingAtom)) return live;
  let bootPrimary: [EnvironmentId, ConnectionCatalogEntry] | null = null;
  for (const entry of boot.entries) {
    if (entry[1].target._tag === "PrimaryConnectionTarget") bootPrimary = entry;
  }
  if (bootPrimary === null || live.entries.has(bootPrimary[0])) return live;
  if (lastMerged?.live === live) return lastMerged.merged;
  const merged: EnvironmentCatalogState = {
    isReady: true,
    entries: new Map([bootPrimary, ...live.entries]),
  };
  lastMerged = { live, merged };
  return merged;
}).pipe(Atom.withLabel("web-environment-catalog-value"));

const CONNECTING_STATE: SupervisorConnectionState = Object.freeze({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connecting",
  stage: "preparing",
});
const CONNECTING_RESULT = AsyncResult.success(CONNECTING_STATE);

/**
 * A boot-only environment has no supervisor yet. It reports connecting, which
 * is what startup is doing, instead of an idle "available" state.
 */
const stateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const bootEntry = readBootCatalogState()?.entries.has(environmentId) === true;
    if (bootEntry && get(bootHoldAtom)) return CONNECTING_RESULT;
    const live = get(liveCatalog.stateAtom(environmentId));
    if (
      !bootEntry ||
      get(primaryEnvironmentMissingAtom) ||
      get(liveCatalog.catalogValueAtom).entries.has(environmentId)
    ) {
      return live;
    }
    return CONNECTING_RESULT;
  }).pipe(Atom.withLabel(`web-environment-connection-state:${environmentId}`)),
);

export const environmentCatalog = {
  ...liveCatalog,
  catalogValueAtom,
  stateAtom,
};

function bootCatalogEntry(
  environmentId: EnvironmentId,
  entry: ConnectionCatalogEntry,
): BootCatalogEntry {
  const base = { environmentId, label: entry.target.label, enabled: entry.enabled };
  const target = entry.target;
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return {
        ...base,
        kind: "primary",
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
      };
    case "BearerConnectionTarget":
      return { ...base, kind: "bearer", connectionId: target.connectionId };
    case "SshConnectionTarget":
      return { ...base, kind: "ssh", connectionId: target.connectionId };
    case "RelayConnectionTarget":
      return { ...base, kind: "relay" };
  }
}

let bootCatalogRecorderStarted = false;

/** Keeps the boot snapshot's environment list in step with the live catalog. */
export function startBootCatalogRecorder(): void {
  if (bootCatalogRecorderStarted) return;
  bootCatalogRecorderStarted = true;
  const requiresPrimary = !isHostedStaticApp() && !isLocalEnvironmentDisabled();
  appAtomRegistry.subscribe(
    liveCatalog.catalogValueAtom,
    (catalog) => {
      // Before discovery registers the primary environment the list is incomplete.
      if (!catalog.isReady || (requiresPrimary && !hasPrimaryEntry(catalog))) return;
      recordBootCatalog(
        Array.from(catalog.entries, ([environmentId, entry]) =>
          bootCatalogEntry(environmentId, entry),
        ),
      );
    },
    { immediate: true },
  );
}
