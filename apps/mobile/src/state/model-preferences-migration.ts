import type {
  EnvironmentId,
  ModelPreferences,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { modelPreferencesMigrationPatch } from "@t3tools/shared/serverSettings";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom } from "./preferences";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";

export type ModelPreferencesMigrationTarget = {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly settings: ServerSettings;
};

/**
 * Picks the patches to send for connected environments, at most once per connection generation.
 * Servers that predate `migrateModelPreferences` drop it and keep reporting null favorites, so a
 * generation is marked attempted before its result is known.
 */
export function takeModelPreferencesMigrations(
  targets: ReadonlyArray<ModelPreferencesMigrationTarget>,
  legacyFavorites: ModelPreferences["favorites"],
  attemptedGenerations: Map<EnvironmentId, number>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly patch: ServerSettingsPatch }> {
  return targets.flatMap(({ environmentId, generation, settings }) => {
    if (attemptedGenerations.get(environmentId) === generation) return [];
    const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
    if (!patch) return [];
    attemptedGenerations.set(environmentId, generation);
    return [{ environmentId, patch }];
  });
}

const modelPreferencesMigrationInputsAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences)) return null;
  const targets = [...get(environmentServerConfigsAtom).entries()].flatMap(
    ([environmentId, config]) => {
      const generation = Option.match(
        AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
        {
          onNone: () => null,
          onSome: (connection) => (connection.phase === "connected" ? connection.generation : null),
        },
      );
      return generation === null ? [] : [{ environmentId, generation, settings: config.settings }];
    },
  );
  return { legacyFavorites: preferences.value.modelFavorites ?? [], targets };
}).pipe(Atom.withLabel("mobile-model-preferences-migration-inputs"));

const attemptedMigrationGenerations = new Map<EnvironmentId, number>();

function migrateModelPreferences(): void {
  const inputs = appAtomRegistry.get(modelPreferencesMigrationInputsAtom);
  if (!inputs) return;
  for (const { environmentId, patch } of takeModelPreferencesMigrations(
    inputs.targets,
    inputs.legacyFavorites,
    attemptedMigrationGenerations,
  )) {
    void runAtomCommand(
      appAtomRegistry,
      serverEnvironment.updateSettings,
      { environmentId, input: { patch } },
      { reportFailure: false },
    );
  }
}

/** Moves this device's legacy model favorites onto each server, once per connection. */
export function installModelPreferencesMigration(): () => void {
  const unsubscribe = appAtomRegistry.subscribe(
    modelPreferencesMigrationInputsAtom,
    migrateModelPreferences,
  );
  migrateModelPreferences();
  return unsubscribe;
}
