// @vitest-environment jsdom
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const screenState = vi.hoisted(() => ({
  targets: [] as SettingsTarget[],
  projectMembers: [] as { project: { environmentId: EnvironmentId; id: ProjectId } }[],
  writable: new Set<EnvironmentId>(),
  write: vi.fn(),
}));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => children,
  Pressable: (props: { children: ReactNode; disabled?: boolean; onPress?: () => void }) =>
    createElement("button", { disabled: props.disabled, onClick: props.onPress }, props.children),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  AppTextInput: () => null,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../components/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: screenState.targets,
    selectedProjectKey: "project",
    projectGroups: [{ key: "project", label: "Project", members: screenState.projectMembers }],
  }),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: EnvironmentId) => screenState.writable.has(environmentId),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: {
      permissionAtom: (environmentId: EnvironmentId) =>
        Atom.make(screenState.writable.has(environmentId)),
    },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => screenState.write }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => AtomRegistry.make().get(atom),
}));

import type { SettingsTarget } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { SettingsEnvironmentAgentBehaviorRouteScreen } from "./SettingsServerControlsRouteScreen";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;

describe("mobile usage-limit settings across environments", () => {
  it.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "shows %s as mixed and can enable it everywhere without changing other settings",
    (key) => {
      const targets = resolveMobileSettingsTargets(
        [
          environment(firstId, { ...DEFAULT_SERVER_SETTINGS, [key]: true }),
          environment(secondId, { ...DEFAULT_SERVER_SETTINGS, [key]: false }),
        ],
        null,
      );

      expect(uniformMobileSetting(targets, key)).toBeNull();
      const writes = planMobileScopedSettingsPatch(targets, false, { [key]: true });
      expect(writes).toEqual([
        { environmentId: firstId, patch: { [key]: true } },
        { environmentId: secondId, patch: { [key]: true } },
      ]);
      const updatedTargets = targets.map((target) => ({
        ...target,
        settings: {
          ...target.settings,
          [key]:
            writes.find((write) => write.environmentId === target.environment.environmentId)?.patch[
              key
            ] ?? target.settings[key],
        },
      }));
      expect(uniformMobileSetting(updatedTargets, key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(0, 1), key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(1), key)).toBe(false);
      expect(uniformMobileSetting([], key)).toBeNull();
    },
  );
});

function environment(environmentId: EnvironmentId, settings: ServerSettings): SettingsTarget {
  return {
    environmentId,
    serverConfig: {
      settings,
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  } as SettingsTarget;
}

describe("mobile project settings scope", () => {
  it.each([false, true])(
    "checks permissions only for project write destinations (read-only checkout: %s)",
    async (readOnlyCheckout) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      screenState.targets = [
        environment(firstId, DEFAULT_SERVER_SETTINGS),
        environment(secondId, DEFAULT_SERVER_SETTINGS),
      ];
      screenState.projectMembers = [
        { project: { environmentId: firstId, id: firstProject } },
        ...(readOnlyCheckout ? [{ project: { environmentId: secondId, id: secondProject } }] : []),
      ];
      screenState.writable = new Set([firstId]);
      screenState.write.mockReset().mockResolvedValue({ _tag: "Success" });
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(createElement(SettingsEnvironmentAgentBehaviorRouteScreen)),
        );
        const choice = Array.from(container.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("After the turn"),
        );
        expect(choice).toBeDefined();
        await act(async () => choice!.click());
        if (readOnlyCheckout) expect(screenState.write).not.toHaveBeenCalled();
        else
          expect(screenState.write).toHaveBeenCalledExactlyOnceWith({
            environmentId: firstId,
            input: {
              patch: {
                projectSettingsOverrides: { [firstProject]: { responseStreamingMode: "turn" } },
              },
            },
          });
      } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("edits each checkout's own override without changing either environment default", () => {
    const firstSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "paragraph",
      projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } },
    };
    const secondSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "turn",
      projectSettingsOverrides: {},
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, firstSettings), environment(secondId, secondSettings)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );

    const writes = planMobileScopedSettingsPatch(targets, true, {
      responseStreamingMode: "turn",
    });
    expect(writes).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
          },
        },
      },
      {
        environmentId: secondId,
        patch: { projectSettingsOverrides: { [secondProject]: { responseStreamingMode: "turn" } } },
      },
    ]);
    expect(firstSettings.responseStreamingMode).toBe("paragraph");
    expect(secondSettings.responseStreamingMode).toBe("turn");
  });

  it("removes a project override when a picker sends null for a key that cannot store it", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultThreadEnvMode: "worktree", defaultAutoPull: true },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultThreadEnvMode: null })).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(planMobileScopedSettingsPatch(targets, true, { defaultModelSelection: null })).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultThreadEnvMode: "worktree",
              defaultAutoPull: true,
              defaultModelSelection: null,
            },
          },
        },
      },
    ]);
  });

  it("resets only the selected page's override and rejects environment-wide writes", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );

    expect(planMobileScopedSettingsClear(targets, ["responseStreamingMode"])).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planMobileScopedSettingsPatch(targets, true, { enableProviderUpdateChecks: false }),
    ).toEqual([]);
  });
});
