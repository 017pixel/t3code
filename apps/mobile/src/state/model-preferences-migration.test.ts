import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));

import { takeModelPreferencesMigrations } from "./model-preferences-migration";

const environmentId = EnvironmentId.make("env-1");
const legacyFavorites = [{ provider: ProviderInstanceId.make("codex"), model: "gpt-5" }];
const unmigrated: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, favorites: null };

describe("takeModelPreferencesMigrations", () => {
  it("migrates legacy favorites once per connection generation", () => {
    const attempted = new Map<EnvironmentId, number>();
    const target = { environmentId, generation: 1, settings: unmigrated };

    expect(takeModelPreferencesMigrations([target], legacyFavorites, attempted)).toEqual([
      { environmentId, patch: { migrateModelPreferences: { favorites: legacyFavorites } } },
    ]);
    // A server that ignores the patch keeps reporting null favorites; do not resend.
    expect(takeModelPreferencesMigrations([target], legacyFavorites, attempted)).toEqual([]);
    expect(
      takeModelPreferencesMigrations([{ ...target, generation: 2 }], legacyFavorites, attempted),
    ).toHaveLength(1);
  });

  it("does not consume a generation when there is nothing to migrate", () => {
    const attempted = new Map<EnvironmentId, number>();
    const migrated = { ...DEFAULT_SERVER_SETTINGS, favorites: [] };

    expect(
      takeModelPreferencesMigrations(
        [{ environmentId, generation: 1, settings: migrated }],
        legacyFavorites,
        attempted,
      ),
    ).toEqual([]);
    expect(
      takeModelPreferencesMigrations(
        [{ environmentId, generation: 1, settings: unmigrated }],
        [],
        attempted,
      ),
    ).toEqual([]);
    expect(attempted.size).toBe(0);
  });
});
