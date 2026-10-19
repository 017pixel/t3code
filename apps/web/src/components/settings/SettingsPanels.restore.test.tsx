import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { resolveSettingsScope } from "./settingsScope";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
  persist: vi.fn(),
  toast: vi.fn(),
  canWrite: true,
}));

const host = {
  environmentId: EnvironmentId.make("settings-host"),
  label: "Host",
  connection: { phase: "connected" as const },
  serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
};

vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: resolveSettingsScope({ machine: host.environmentId }, [], [host]),
    environments: [host],
  }),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => state.canWrite,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useTheme")>()),
  useTheme: () => ({
    theme: "system",
    followSystem: true,
    themeHalves: null,
    setTheme: vi.fn(),
    setFollowSystem: vi.fn(),
    setThemeHalf: vi.fn(),
    clearThemeHalves: vi.fn(),
  }),
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));

vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
}));

vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

import { useSettingsRestore } from "./SettingsPanels";

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.update.mockResolvedValue({ saved: true, message: null });
  state.confirm.mockResolvedValue(true);
  state.canWrite = true;
});

describe("scoped settings save completion", () => {
  it("waits for the destination to save before reporting success", async () => {
    const { useUpdateScopedSettings } =
      await vi.importActual<typeof import("./useScopedSettings")>("./useScopedSettings");
    let complete!: (result: { _tag: "Success"; value: typeof DEFAULT_SERVER_SETTINGS }) => void;
    state.persist.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    hooks.beginRender();
    const update = useUpdateScopedSettings();
    const finished = vi.fn();
    const save = update({ enableCua: true }).then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    complete({ _tag: "Success", value: { ...DEFAULT_SERVER_SETTINGS, enableCua: true } });
    await save;
    expect(finished).toHaveBeenCalledWith({ saved: true, message: null });
    expect(state.persist.mock.calls[0]?.[0].environmentId).toBe(host.environmentId);
  });

  it("returns failures for retry without rejecting and checks permission again at execution", async () => {
    const { useUpdateScopedSettings } =
      await vi.importActual<typeof import("./useScopedSettings")>("./useScopedSettings");
    hooks.beginRender();
    const update = useUpdateScopedSettings();
    state.persist.mockRejectedValueOnce(new Error("Disk full"));
    await expect(update({ enableCua: true })).resolves.toMatchObject({
      saved: false,
      message: expect.stringContaining("Disk full"),
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Setting not saved" }),
    );
    state.persist.mockResolvedValueOnce({
      _tag: "Success",
      value: { ...DEFAULT_SERVER_SETTINGS, enableCua: true },
    });
    await expect(update({ enableCua: true })).resolves.toEqual({ saved: true, message: null });
    state.canWrite = false;
    state.persist.mockClear();
    await expect(update({ enableCua: true })).resolves.toMatchObject({
      saved: false,
      message: expect.stringContaining("permission"),
    });
    expect(state.persist).not.toHaveBeenCalled();
  });
});

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Auto-resume limited threads"],
    ["snoozeLimitedThreads", "Snooze limited threads"],
    ["enableCua", "Computer use"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: true };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it("does not reset settings after cancellation", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true };
    state.confirm.mockResolvedValue(false);
    hooks.beginRender();

    await useSettingsRestore().restoreDefaults();

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
