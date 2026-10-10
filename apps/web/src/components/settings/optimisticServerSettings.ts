import type { EnvironmentId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { useSyncExternalStore } from "react";

/**
 * Server setting writes shown before the server confirms them. A failed write
 * drops its patch, so the control returns to the server's value while the
 * caller reports the error.
 */
export interface OptimisticServerSettingsPatch {
  readonly environmentId: EnvironmentId;
  readonly patch: ServerSettingsPatch;
  /** The environment's settings object when the write was sent. */
  readonly base: ServerSettings | null;
  /** Saved: the patch only bridges the gap until the server pushes settings newer than `base`. */
  saved: boolean;
}

/** Bounds a saved patch whose settings push never arrives (a reconnect, say). */
const SAVED_PATCH_MAX_MS = 5_000;

let patches: ReadonlyArray<OptimisticServerSettingsPatch> = [];
const listeners = new Set<() => void>();

function publish(next: ReadonlyArray<OptimisticServerSettingsPatch>) {
  patches = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shows `patch` at once. Call the result with whether the write succeeded. */
export function beginOptimisticServerSettingsPatch(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
  base: ServerSettings | null,
): (saved: boolean) => void {
  const pending: OptimisticServerSettingsPatch = { environmentId, patch, base, saved: false };
  publish([...patches, pending]);
  return (saved) => {
    if (!saved) {
      publish(patches.filter((entry) => entry !== pending));
      return;
    }
    // The settings push normally lands before the reply and has already re-rendered the
    // page; marking the patch saved needs no render of its own.
    pending.saved = true;
    setTimeout(() => publish(patches.filter((entry) => entry !== pending)), SAVED_PATCH_MAX_MS);
  };
}

export function useOptimisticServerSettingsPatches(): ReadonlyArray<OptimisticServerSettingsPatch> {
  return useSyncExternalStore(subscribe, () => patches);
}

/** `settings` as the environment will have them once its writes land. */
export function applyOptimisticServerSettings(
  environmentId: EnvironmentId,
  settings: ServerSettings,
  pending: ReadonlyArray<OptimisticServerSettingsPatch>,
): ServerSettings {
  let next = settings;
  for (const entry of pending) {
    if (entry.environmentId !== environmentId) continue;
    // The server's own settings have arrived since the write was sent.
    if (entry.saved && settings !== entry.base) continue;
    next = applyServerSettingsPatch(next, entry.patch);
  }
  return next;
}
