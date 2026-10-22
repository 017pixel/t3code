import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  baseDirectory: "",
  projects: [] as string[],
  home: "/home/tester",
  supportsCloneTracking: false,
  registered: [] as Array<{
    environmentId: string;
    id: string;
    title: string;
    workspaceRoot: string;
  }>,
  cloneCalls: [] as string[],
  alerts: [] as string[],
  navigations: [] as unknown[],
  draftTexts: [] as Array<{ draftId: string; text: string }>,
}));

// Stands in for the server's `~` expansion, which filesystem.browse reports as parentPath.
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${state.home}${path.slice(1)}` : path;
}

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock("../../components/ui/NavigationRow", () => ({ NavigationRow: "NavigationRow" }));
vi.mock("../../components/ui/Button", () => ({ Button: "Button" }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: "ScrollView" }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: "Switch" }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: (title: string) => state.alerts.push(title) },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: (action: unknown) => state.navigations.push(action) }),
  CommonActions: { reset: (input: unknown) => input },
  StackActions: {},
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: "EnvironmentMachineSymbol",
}));
vi.mock("../../components/ui/ErrorBanner", () => ({ ErrorBanner: "ErrorBanner" }));
vi.mock("./SourceControlIcon", () => ({ SourceControlIcon: "SourceControlIcon" }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "project" }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: string, scope: string) => state.scopes.has(scope),
  readEnvironmentScope: (_environmentId: string, scope: string) => state.scopes.has(scope),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  createNewTaskDraft: () => "draft",
  setComposerDraftText: (draftId: string, text: string) => state.draftTexts.push({ draftId, text }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.registered,
  waitForProject: async ({ projectId }: { projectId: string }) =>
    state.registered.find((project) => project.id === projectId) ?? null,
  useServerConfigs: () =>
    new Map([
      [
        "environment",
        {
          environment: {
            platform: { os: "linux" },
            capabilities: { projectCloneTracking: state.supportsCloneTracking },
          },
          settings: { addProjectBaseDirectory: state.baseDirectory },
        },
      ],
    ]),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "environment", connectionState: "connected" }],
  }),
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      connection: { environmentId: "environment", environmentLabel: "Environment" },
    },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
function browseResult(target: unknown) {
  const partialPath = (target as { input?: { partialPath?: string } } | null)?.input?.partialPath;
  if (partialPath === undefined) return null;
  const expanded = expandHome(partialPath);
  return {
    parentPath: expanded.slice(0, expanded.lastIndexOf("/") + 1),
    entries: [],
  };
}
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async (target: unknown) => {
    const data = browseResult(target);
    return data ? AsyncResult.success(data) : AsyncResult.success(null);
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: unknown) => ({
    data: browseResult(target),
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  }),
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (target: unknown) => target },
}));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    cloneRepository: async ({ input }: { input: { destinationPath: string } }) => {
      state.cloneCalls.push(input.destinationPath);
      if (input.destinationPath.startsWith("~")) {
        return AsyncResult.success({ cwd: input.destinationPath });
      }
      NodeFS.mkdirSync(input.destinationPath);
      return AsyncResult.success({ cwd: input.destinationPath });
    },
    startProjectClone: async ({ input }: { input: { destinationPath: string } }) => {
      state.cloneCalls.push(input.destinationPath);
      return AsyncResult.success(undefined);
    },
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    create: async ({ input }: { input: { workspaceRoot: string } }) => {
      if (!state.scopes.has(AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(Cause.fail(new Error("Project creation denied")));
      }
      const root = expandHome(input.workspaceRoot).replace(/\/+$/, "");
      if (state.registered.some((project) => project.workspaceRoot === root)) {
        return AsyncResult.failure(Cause.fail(new Error("Failed to mutate project")));
      }
      state.projects.push(input.workspaceRoot);
      return AsyncResult.success(undefined);
    },
  },
}));

import { AddProjectDestinationScreen, AddProjectLocalFolderScreen } from "./AddProjectScreen";

function findAction(node: ReactNode, label: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const action = findAction(child, label);
      if (action) return action;
    }
    return null;
  }
  if (!isValidElement<{ label?: string; onPress?: () => unknown; children?: ReactNode }>(node)) {
    return null;
  }
  if (node.props.label === label) return node.props.onPress ?? null;
  return findAction(node.props.children, label);
}

function cloneAction() {
  const action = findAction(
    AddProjectDestinationScreen({
      environmentId: "environment",
      remoteUrl: "https://example.com/repo.git",
      repositoryName: "repo",
    }),
    "Clone project",
  );
  if (!action) throw new Error("Clone action missing");
  return action;
}

describe("clone project permissions", () => {
  beforeEach(async () => {
    state.baseDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-clone-permissions-"),
    );
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.projects = [];
  });

  afterEach(async () => {
    await NodeFSP.rm(state.baseDirectory, { recursive: true, force: true });
  });

  it("does not leave a clone on disk when project creation is denied", async () => {
    await cloneAction()();

    expect(NodeFS.existsSync(NodePath.join(state.baseDirectory, "repo"))).toBe(false);
    expect(state.projects).toEqual([]);
  });

  it.each([AuthSourceControlWriteScope, AuthOrchestrationOperateScope])(
    "rechecks %s before a retained clone action creates a directory",
    async (scope) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      const submit = cloneAction();
      state.scopes.delete(scope);
      await submit();

      expect(NodeFS.existsSync(NodePath.join(state.baseDirectory, "repo"))).toBe(false);
      expect(state.projects).toEqual([]);
    },
  );
});

describe("adding an already registered project", () => {
  const existing = {
    environmentId: "environment",
    id: "existing-project",
    title: "Bike documents",
    workspaceRoot: "/home/tester/repro/bike-documents",
  };
  const existingDraft = {
    index: 0,
    routes: [
      {
        name: "NewTaskDraft",
        params: { environmentId: "environment", projectId: existing.id, title: existing.title },
      },
    ],
  };

  beforeEach(() => {
    state.scopes = new Set([
      AuthSourceControlWriteScope,
      AuthOrchestrationOperateScope,
      AuthFilesystemReadScope,
    ]);
    state.projects = [];
    state.registered = [existing];
    state.cloneCalls = [];
    state.alerts = [];
    state.navigations = [];
    state.draftTexts = [];
    state.supportsCloneTracking = false;
  });

  async function submitLocalFolder(path: string) {
    state.baseDirectory = path;
    const action = findAction(
      AddProjectLocalFolderScreen({ environmentId: "environment" }),
      "Add project",
    );
    if (!action) throw new Error("Add project action missing");
    await action();
  }

  it.each(["~/repro/bike-documents/", "/home/tester/repro/bike-documents/"])(
    "opens the existing project's draft without an alert for local folder %s",
    async (path) => {
      await submitLocalFolder(path);

      expect(state.alerts).toEqual([]);
      expect(state.navigations).toEqual([existingDraft]);
    },
  );

  it.each([false, true])(
    "opens the existing project's draft with the prompt before cloning (clone tracking: %s)",
    async (supportsCloneTracking) => {
      state.supportsCloneTracking = supportsCloneTracking;
      state.baseDirectory = "~/repro";
      const action = findAction(
        AddProjectDestinationScreen({
          environmentId: "environment",
          remoteUrl: "https://example.com/bike-documents.git",
          repositoryName: "bike-documents",
          prompt: "Fix the bike",
        }),
        "Clone project",
      );
      if (!action) throw new Error("Clone action missing");
      await action();

      expect(state.cloneCalls).toEqual([]);
      expect(state.alerts).toEqual([]);
      expect(state.draftTexts).toEqual([{ draftId: "draft", text: "Fix the bike" }]);
      expect(state.navigations).toEqual([
        {
          ...existingDraft,
          routes: [
            {
              ...existingDraft.routes[0],
              params: { ...existingDraft.routes[0]!.params, draftId: "draft" },
            },
          ],
        },
      ]);
    },
  );
});
