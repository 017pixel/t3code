import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { NavigationState } from "@react-navigation/native";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, createElement, isValidElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reconcileStackScreens } from "../../native/workspace-stack-projection";
import { threadHeaderAppearance } from "../threads/thread-header-appearance";

const state = vi.hoisted(() => ({
  realHooks: false,
  scopes: new Set<string>(),
  baseDirectory: "",
  projects: [] as string[],
  existingProjects: [] as {
    environmentId: string;
    id: string;
    title: string;
    workspaceRoot: string;
  }[],
  createResult: null as Promise<unknown> | null,
  cloneResult: null as Promise<unknown> | null,
  createNewResult: null as Promise<unknown> | null,
  startCloneResult: null as Promise<unknown> | null,
  loadComposerDrafts: vi.fn(async () => {}),
  connectionStates: {} as Record<string, EnvironmentConnectionPhase>,
  newProjectsRoot: null as string | null,
  supportsCloneTracking: false,
  waitForProject: vi.fn(),
  dispatch: vi.fn(),
  alert: vi.fn(),
  navigationState: undefined as NavigationState | undefined,
  environments: [{ environmentId: "environment", environmentLabel: "Environment" }],
}));

function loadRouters() {
  const requireNavigation = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return requireNavigation("@react-navigation/routers") as {
    StackRouter: typeof import("@react-navigation/native").StackRouter;
    StackActions: typeof import("@react-navigation/native").StackActions;
    CommonActions: typeof import("@react-navigation/native").CommonActions;
  };
}

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) =>
      state.realHooks
        ? react.useState(initial)
        : [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (current: unknown) => (state.realHooks ? react.useRef(current) : { current }),
    useEffect: (...args: Parameters<typeof react.useEffect>) => {
      if (state.realHooks) react.useEffect(...args);
    },
  };
});
vi.mock("../../native/StackHeader", () => ({
  nativeHeaderScrollEdgeEffects: () => undefined,
}));
vi.mock("../../components/ui/NavigationRow", () => ({ NavigationRow: "NavigationRow" }));
vi.mock("../../components/ui/Button", () => ({ Button: "Button" }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: "ScrollView" }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: "SettingsScreen" }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: "Switch" }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: state.alert },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    dispatch: state.dispatch,
    getState: () =>
      state.navigationState ?? {
        index: 4,
        routes: [
          { key: "home", name: "Home" },
          { key: "draft", name: "Thread", params: { draft: {} } },
          { key: "picker", name: "NewTaskProject" },
          { key: "add", name: "AddProject" },
          { key: "local", name: "AddProjectLocal" },
        ],
      },
  }),
  CommonActions: { reset: (input: unknown) => input },
  StackActions: {
    push: (name: string, params: unknown) => ({ type: "PUSH", payload: { name, params } }),
  },
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
vi.mock("../../state/entities", () => ({
  useProjects: () => state.existingProjects,
  waitForProject: state.waitForProject,
  useServerConfigs: () =>
    new Map([
      [
        "environment",
        {
          environment: {
            platform: { os: "linux" },
            capabilities: { projectCloneTracking: state.supportsCloneTracking },
          },
          newProjectsRoot: state.newProjectsRoot,
          settings: { addProjectBaseDirectory: state.baseDirectory },
        },
      ],
    ]),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: state.environments.map((environment) => ({
      environmentId: environment.environmentId,
      connectionState: state.connectionStates[environment.environmentId] ?? "connected",
    })),
  }),
  useSavedRemoteConnections: () => ({
    savedConnectionsById: Object.fromEntries(
      state.environments.map((environment) => [environment.environmentId, environment]),
    ),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => () => {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/filesystem", () => ({ filesystemEnvironment: {} }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: (input: unknown) => input,
    startProjectClone: () => state.startCloneResult,
    cloneRepository: async ({ input }: { input: { destinationPath: string } }) => {
      if (state.cloneResult) return state.cloneResult;
      NodeFS.mkdirSync(input.destinationPath);
      return AsyncResult.success({ cwd: input.destinationPath });
    },
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    createNew: () => state.createNewResult,
    create: ({ input }: { input: { workspaceRoot: string } }) => {
      if (!state.scopes.has(AuthOrchestrationOperateScope)) {
        return Promise.resolve(
          AsyncResult.failure(Cause.fail(new Error("Project creation denied"))),
        );
      }
      state.projects.push(input.workspaceRoot);
      return state.createResult ?? Promise.resolve(AsyncResult.success(undefined));
    },
  },
}));

vi.mock("../../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: state.loadComposerDrafts,
  createNewTaskDraft: () => "prompt-draft",
  setComposerDraftText: () => {},
}));

import {
  AddProjectNewScreen,
  AddProjectDestinationScreen,
  AddProjectLocalFolderScreen,
  AddProjectSourceScreen,
} from "./AddProjectScreen";
import { AddProjectSourceRoute } from "./AddProjectSourceRoute";

function findAction(
  node: ReactNode,
  label: string,
  includeDisabled = false,
): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const action = findAction(child, label, includeDisabled);
      if (action) return action;
    }
    return null;
  }
  if (
    !isValidElement<{
      label?: string;
      title?: string;
      onPress?: () => unknown;
      disabled?: boolean;
      children?: ReactNode;
    }>(node)
  ) {
    return null;
  }
  if ((node.props.label ?? node.props.title) === label) {
    return node.props.disabled && !includeDisabled ? null : (node.props.onPress ?? null);
  }
  return findAction(node.props.children, label, includeDisabled);
}

function cloneAction() {
  const action = findAction(
    AddProjectDestinationScreen({
      environmentId: "environment",
      remoteUrl: "https://example.com/repo.git",
      repositoryName: "repo",
    }),
    "Clone project",
    true,
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
    state.createResult = null;
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

describe("add project source environment", () => {
  it.each(["connecting", "reconnecting"] as const)(
    "waits for the requested %s environment without offering actions on another host",
    async (phase) => {
      state.realHooks = true;
      state.scopes = new Set([AuthOrchestrationOperateScope, AuthSourceControlWriteScope]);
      state.dispatch.mockReset();
      state.newProjectsRoot = "/projects";
      state.environments = [
        { environmentId: "environment", environmentLabel: "Environment" },
        { environmentId: "another-environment", environmentLabel: "Another environment" },
      ];
      state.connectionStates = { environment: phase };
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const root = createRoot(document.createElement("div"));
      let screen: ReactNode;
      function SourceObserver() {
        screen = AddProjectSourceScreen({ environmentId: "environment" });
        return null;
      }
      try {
        await act(() => root.render(createElement(SourceObserver)));
        expect(findAction(screen, "Local folder")).toBeNull();
        expect(findAction(screen, "New project")).toBeNull();
        expect(state.dispatch).not.toHaveBeenCalled();

        state.connectionStates = {};
        await act(() => root.render(createElement(SourceObserver)));
        const local = findAction(screen, "Local folder");
        if (!local) throw new Error("Local folder action missing after connection");
        local();
        expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
          type: "PUSH",
          payload: { name: "AddProjectLocal", params: { environmentId: "environment" } },
        });
      } finally {
        await act(() => root.unmount());
        state.realHooks = false;
        state.connectionStates = {};
        state.newProjectsRoot = null;
        state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
      }
    },
  );

  it("keeps a manual host selection when the requested host finishes connecting", async () => {
    state.realHooks = true;
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.dispatch.mockReset();
    state.environments = [
      { environmentId: "environment", environmentLabel: "Environment" },
      { environmentId: "another-environment", environmentLabel: "Another environment" },
    ];
    state.connectionStates = { environment: "connecting" };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    let screen: ReactNode;
    function SourceObserver() {
      screen = AddProjectSourceScreen({ environmentId: "environment" });
      return null;
    }
    try {
      await act(() => root.render(createElement(SourceObserver)));
      const select = findAction(screen, "Another environment");
      if (!select) throw new Error("Connected environment selection missing");
      await act(() => select());
      state.connectionStates = {};
      await act(() => root.render(createElement(SourceObserver)));
      const local = findAction(screen, "Local folder");
      if (!local) throw new Error("Local folder action missing");
      local();
      expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
        type: "PUSH",
        payload: { name: "AddProjectLocal", params: { environmentId: "another-environment" } },
      });
    } finally {
      await act(() => root.unmount());
      state.realHooks = false;
      state.connectionStates = {};
      state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
    }
  });

  it.each(["offline", "available", "error", "unsupported"] as const)(
    "falls back to a connected host when the requested host is %s",
    (phase) => {
      state.scopes = new Set([AuthOrchestrationOperateScope]);
      state.dispatch.mockReset();
      state.environments = [
        { environmentId: "environment", environmentLabel: "Environment" },
        { environmentId: "another-environment", environmentLabel: "Another environment" },
      ];
      state.connectionStates = { environment: phase };
      try {
        const local = findAction(
          AddProjectSourceScreen({ environmentId: "environment" }),
          "Local folder",
        );
        if (!local) throw new Error("Fallback local folder action missing");
        local();
        expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
          type: "PUSH",
          payload: { name: "AddProjectLocal", params: { environmentId: "another-environment" } },
        });
      } finally {
        state.connectionStates = {};
        state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
      }
    },
  );

  it("follows warm environment requests while preserving manual selection between requests", async () => {
    state.realHooks = true;
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.dispatch.mockReset();
    state.environments = [
      { environmentId: "environment", environmentLabel: "Environment" },
      { environmentId: "another-environment", environmentLabel: "Another environment" },
    ];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    let actions: { local: () => unknown; selectEnvironment: () => unknown } | undefined;
    function SourceRouteObserver(props: { environmentId?: string | string[] }) {
      const route = AddProjectSourceRoute({ route: { params: props } });
      const screen = AddProjectSourceScreen(route.props);
      const local = findAction(screen, "Local folder");
      const selectEnvironment = findAction(screen, "Environment");
      if (!local || !selectEnvironment) throw new Error("Source actions missing");
      actions = { local, selectEnvironment };
      return null;
    }
    const openLocalFolder = (environmentId: string) => {
      state.dispatch.mockClear();
      actions!.local();
      expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
        type: "PUSH",
        payload: { name: "AddProjectLocal", params: { environmentId } },
      });
    };
    try {
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "environment" })),
      );
      openLocalFolder("environment");
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "another-environment" })),
      );
      openLocalFolder("another-environment");
      await act(() => actions!.selectEnvironment());
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: ["another-environment"] })),
      );
      openLocalFolder("environment");
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "environment" })),
      );
      await act(() =>
        root.render(createElement(SourceRouteObserver, { environmentId: "another-environment" })),
      );
      openLocalFolder("another-environment");
    } finally {
      await act(() => root.unmount());
      state.realHooks = false;
      state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
    }
  });

  it.each([
    { environmentId: "environment", expected: "environment" },
    { environmentId: ["environment", "another-environment"], expected: "environment" },
    { environmentId: undefined, expected: "another-environment" },
    { environmentId: "unknown", expected: "another-environment" },
  ])(
    "opens a local folder in $expected for query $environmentId",
    ({ environmentId, expected }) => {
      state.scopes = new Set([AuthOrchestrationOperateScope]);
      state.dispatch.mockReset();
      // The requested environment sorts after the default, regardless of saved order.
      state.environments = [
        { environmentId: "environment", environmentLabel: "Environment" },
        { environmentId: "another-environment", environmentLabel: "Another environment" },
      ];
      try {
        const screen = AddProjectSourceRoute({
          route: { params: { environmentId } },
        });
        const action = findAction(AddProjectSourceScreen(screen.props), "Local folder");
        if (!action) throw new Error("Local folder action missing");
        action();

        expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
          type: "PUSH",
          payload: { name: "AddProjectLocal", params: { environmentId: expected } },
        });
      } finally {
        state.environments = [{ environmentId: "environment", environmentLabel: "Environment" }];
      }
    },
  );
});

describe("local project navigation", () => {
  function setup() {
    state.navigationState = undefined;
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    state.baseDirectory = "/tmp/t3-mobile-audit-fixture";
    state.projects = [];
    state.dispatch.mockReset();
    state.alert.mockReset();
    state.waitForProject.mockReset();
    const created = Promise.withResolvers<ReturnType<typeof AsyncResult.success<void>>>();
    const projected = Promise.withResolvers<unknown>();
    state.createResult = created.promise;
    state.waitForProject.mockReturnValue(projected.promise);
    const submit = findAction(
      AddProjectLocalFolderScreen({ environmentId: "environment" }),
      "Add project",
    );
    if (!submit) throw new Error("Add project action missing");
    return { created, projected, submit };
  }

  it("keeps Add project open until the created project reaches the device", async () => {
    const { created, projected, submit } = setup();
    const submission = submit();
    created.resolve(AsyncResult.success(undefined));
    await created.promise;

    expect(state.projects).toEqual(["/tmp/t3-mobile-audit-fixture"]);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.waitForProject).toHaveBeenCalledWith(
      { environmentId: "environment", projectId: "project" },
      15_000,
    );

    projected.resolve({ environmentId: "environment", id: "project" });
    await submission;

    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      index: 1,
      routes: [
        { key: "home", name: "Home" },
        {
          key: "draft",
          name: "Thread",
          params: {
            draft: {
              environmentId: "environment",
              projectId: "project",
              title: "t3-mobile-audit-fixture",
            },
          },
        },
      ],
    });
  });

  it("keeps navigation in place and explains a project projection timeout", async () => {
    const { created, projected, submit } = setup();
    const submission = submit();
    created.resolve(AsyncResult.success(undefined));
    projected.resolve(null);
    await submission;

    expect(state.projects).toEqual(["/tmp/t3-mobile-audit-fixture"]);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.alert).toHaveBeenCalledExactlyOnceWith(
      "Project added",
      "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
    );
  });

  function mountProjectFlow(
    withDraft: boolean,
    withChooser = true,
    withPullRequest = false,
    screenName = "AddProjectLocal",
  ) {
    const { StackRouter, StackActions, CommonActions } = loadRouters();
    const router = StackRouter({});
    const options = {
      routeNames: [
        "Home",
        "Thread",
        "PullRequest",
        "PullRequestFile",
        "NewTaskProject",
        "AddProject",
        "AddProjectLocal",
        "AddProjectNew",
        "AddProjectDestination",
      ],
      routeParamList: {},
      routeGetIdList: {},
    };
    let current = router.getInitialState(options);
    const home = current.routes[0]!;
    const apply = (action: Parameters<typeof router.getStateForAction>[1]) => {
      const next = router.getStateForAction(current, action, options);
      if (!next || next.stale !== false) throw new Error("Navigation action rejected");
      current = next;
      state.navigationState = current;
    };
    if (withPullRequest) {
      apply(StackActions.push("PullRequest", { number: 123 }));
      apply(StackActions.push("PullRequestFile", { path: "file.ts" }));
    }
    const underlyingRoutes = current.routes;
    if (withDraft) {
      apply(StackActions.push("Thread", { draft: { projectId: "previous-project" } }));
    }
    const draftKey = withDraft ? current.routes[current.index]!.key : null;
    for (const name of [...(withChooser ? ["NewTaskProject"] : []), "AddProject", screenName]) {
      apply(StackActions.push(name));
    }
    state.navigationState = current;
    // The screen's reset mock returns the payload; run it through the actual router.
    state.dispatch.mockImplementation((payload) => apply(CommonActions.reset(payload)));
    return {
      home,
      draftKey,
      underlyingRoutes,
      flowRoutes: current.routes.slice(underlyingRoutes.length),
      getState: () => current,
      back: () => apply(StackActions.pop()),
      push: (name: string) => apply(StackActions.push(name)),
    };
  }

  it.each(["pop", "reopen", "cover"] as const)(
    "does not reopen a local project draft after its route loses focus (%s)",
    async (leave) => {
      const { created, projected, submit } = setup();
      const navigation = mountProjectFlow(false);
      const submission = submit();
      created.resolve(AsyncResult.success(undefined));
      await created.promise;
      expect(state.waitForProject).toHaveBeenCalled();
      if (leave !== "cover") navigation.back();
      if (leave === "reopen") navigation.push("AddProjectLocal");
      if (leave === "cover") navigation.push("PullRequest");
      const remaining = navigation.getState();
      projected.resolve({ environmentId: "environment", id: "project" });
      await submission;

      expect(state.projects).toEqual(["/tmp/t3-mobile-audit-fixture"]);
      expect(navigation.getState()).toEqual(remaining);
      expect(state.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "completes a legacy clone without replacing a different route (leave: %s)",
    async (leave) => {
      const { created, projected } = setup();
      state.scopes.add(AuthSourceControlWriteScope);
      const cloned = Promise.withResolvers<unknown>();
      state.cloneResult = cloned.promise;
      const navigation = mountProjectFlow(false, true, true, "AddProjectDestination");
      try {
        const submission = cloneAction()();
        if (leave) {
          navigation.back();
          navigation.push("AddProjectDestination");
        }
        const remaining = navigation.getState();
        cloned.resolve(AsyncResult.success({ cwd: "/tmp/t3-mobile-audit-fixture/repo" }));
        created.resolve(AsyncResult.success(undefined));
        projected.resolve({ environmentId: "environment", id: "project" });
        await submission;

        expect(state.projects).toEqual(["/tmp/t3-mobile-audit-fixture/repo"]);
        if (leave) {
          expect(navigation.getState()).toEqual(remaining);
          expect(state.dispatch).not.toHaveBeenCalled();
        } else {
          expect(navigation.getState().routes.at(-1)).toMatchObject({
            name: "Thread",
            params: {
              draft: { environmentId: "environment", projectId: "project", title: "repo" },
            },
          });
        }
      } finally {
        state.cloneResult = null;
      }
    },
  );

  it.each([
    { pending: "projection", leave: true },
    { pending: "prompt", leave: true },
    { pending: "prompt", leave: false },
  ])(
    "completes a tracked clone without replacing a different route (wait: $pending, leave: $leave)",
    async ({ pending, leave }) => {
      const { projected } = setup();
      state.scopes.add(AuthSourceControlWriteScope);
      state.supportsCloneTracking = true;
      state.startCloneResult = Promise.resolve(AsyncResult.success(undefined));
      const composer = Promise.withResolvers<void>();
      const loadingPrompt = Promise.withResolvers<void>();
      state.loadComposerDrafts.mockImplementation(() => {
        loadingPrompt.resolve();
        return composer.promise;
      });
      const navigation = mountProjectFlow(false, true, true, "AddProjectDestination");
      try {
        const submit = findAction(
          AddProjectDestinationScreen({
            environmentId: "environment",
            remoteUrl: "https://example.com/repo.git",
            repositoryName: "repo",
            ...(pending === "prompt" ? { prompt: "Review this repository" } : {}),
          }),
          "Clone project",
        );
        if (!submit) throw new Error("Clone action missing");
        if (pending === "prompt") {
          projected.resolve({ environmentId: "environment", id: "project" });
        }
        const submission = submit();
        if (pending === "prompt") await loadingPrompt.promise;
        else await state.startCloneResult;
        expect(state.waitForProject).toHaveBeenCalled();
        if (leave) {
          navigation.back();
          navigation.push("AddProjectDestination");
        }
        const remaining = navigation.getState();
        projected.resolve({ environmentId: "environment", id: "project" });
        composer.resolve();
        await submission;

        if (leave) {
          expect(navigation.getState()).toEqual(remaining);
          expect(state.dispatch).not.toHaveBeenCalled();
        } else {
          expect(navigation.getState().routes.at(-1)).toMatchObject({
            name: "Thread",
            params: {
              draft: {
                environmentId: "environment",
                projectId: "project",
                cloning: "1",
                draftId: "prompt-draft",
              },
            },
          });
        }
      } finally {
        state.supportsCloneTracking = false;
        state.startCloneResult = null;
        state.loadComposerDrafts.mockResolvedValue(undefined);
      }
    },
  );

  it.each([true, false])(
    "completes a new project without replacing a different route (leave: %s)",
    async (leave) => {
      const { projected } = setup();
      state.realHooks = true;
      state.newProjectsRoot = "/projects";
      const created = Promise.withResolvers<unknown>();
      const waitingForProject = Promise.withResolvers<void>();
      state.createNewResult = created.promise;
      state.waitForProject.mockImplementation(() => {
        waitingForProject.resolve();
        return projected.promise;
      });
      const navigation = mountProjectFlow(false, true, true, "AddProjectNew");
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const root = createRoot(document.createElement("div"));
      let screen: ReactNode;
      function NewProjectObserver() {
        screen = AddProjectNewScreen({ environmentId: "environment" });
        return null;
      }
      function enterName(node: ReactNode): boolean {
        if (Array.isArray(node)) return node.some(enterName);
        if (
          !isValidElement<{
            placeholder?: string;
            onChangeText?: (text: string) => void;
            children?: ReactNode;
          }>(node)
        )
          return false;
        if (node.props.placeholder === "Project name") {
          node.props.onChangeText!("new-project");
          return true;
        }
        return enterName(node.props.children);
      }
      try {
        await act(() => root.render(createElement(NewProjectObserver)));
        await act(() => {
          expect(enterName(screen)).toBe(true);
        });
        const submit = findAction(screen, "Create project");
        if (!submit) throw new Error("Create project action missing");
        await act(async () => {
          submit();
          created.resolve(
            AsyncResult.success({
              projectId: "project",
              workspaceRoot: "/projects/new-project",
            }),
          );
          await waitingForProject.promise;
        });
        if (leave) {
          navigation.back();
          navigation.push("AddProjectNew");
        }
        const remaining = navigation.getState();
        await act(async () => {
          projected.resolve({ environmentId: "environment", id: "project" });
          await projected.promise;
        });

        if (leave) {
          expect(navigation.getState()).toEqual(remaining);
          expect(state.dispatch).not.toHaveBeenCalled();
        } else {
          expect(navigation.getState().routes.at(-1)).toMatchObject({
            name: "Thread",
            params: {
              draft: { environmentId: "environment", projectId: "project", title: "new-project" },
            },
          });
        }
      } finally {
        await act(() => root.unmount());
        state.realHooks = false;
        state.newProjectsRoot = null;
        state.createNewResult = null;
      }
    },
  );

  it("opens an existing local project synchronously without waiting for projection", () => {
    setup();
    const navigation = mountProjectFlow(true);
    state.existingProjects = [
      {
        environmentId: "environment",
        id: "existing-project",
        title: "Existing project",
        workspaceRoot: state.baseDirectory,
      },
    ];
    try {
      const submit = findAction(
        AddProjectLocalFolderScreen({ environmentId: "environment" }),
        "Add project",
      );
      if (!submit) throw new Error("Add project action missing");
      submit();
      expect(state.projects).toEqual([]);
      expect(state.waitForProject).not.toHaveBeenCalled();
      expect(navigation.getState().routes.at(-1)).toMatchObject({
        key: navigation.draftKey,
        name: "Thread",
        params: { draft: { environmentId: "environment", projectId: "existing-project" } },
      });
    } finally {
      state.existingProjects = [];
    }
  });

  it("pops the project flow back to the same native Thread controller", async () => {
    const { created, projected, submit } = setup();
    const navigation = mountProjectFlow(true);
    const submission = submit();
    created.resolve(AsyncResult.success(undefined));
    projected.resolve({ environmentId: "environment", id: "project" });
    await submission;

    const current = navigation.getState();
    expect(current.routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
    expect(current.routes[current.index]).toMatchObject({
      key: navigation.draftKey,
      params: { draft: { environmentId: "environment", projectId: "project" } },
    });
    navigation.back();
    expect(navigation.getState().routes).toEqual([navigation.home]);
  });

  it.each([true, false])(
    "reuses the first project flow screen above a warm PR diff (chooser: %s)",
    async (withChooser) => {
      const { created, projected, submit } = setup();
      const navigation = mountProjectFlow(false, withChooser, true);
      const previousRoutes = state.navigationState!.routes;
      const submission = submit();
      created.resolve(AsyncResult.success(undefined));
      projected.resolve({ environmentId: "environment", id: "project" });
      await submission;

      const current = navigation.getState();
      expect(current.routes).toEqual([
        ...navigation.underlyingRoutes,
        {
          key: navigation.flowRoutes[0]!.key,
          name: "Thread",
          params: {
            draft: {
              environmentId: "environment",
              projectId: "project",
              title: "t3-mobile-audit-fixture",
            },
          },
        },
      ]);
      // The iOS stack retains outgoing children until their native pop completes.
      // The draft must update the first flow controller instead of pushing a new one.
      expect(reconcileStackScreens(previousRoutes, current.routes)).toEqual([
        ...current.routes,
        ...navigation.flowRoutes.slice(1),
      ]);
      if (withChooser) {
        // React Navigation merges dynamic options by key, including when a chooser becomes Thread.
        const chooserSearch = { onChangeText: vi.fn(), placeholder: "Find a project" };
        const retainedOptions = { headerSearchBarOptions: chooserSearch };
        const threadOptions = { ...retainedOptions, ...threadHeaderAppearance(true) };
        expect(threadOptions.headerSearchBarOptions).toBeUndefined();
      }
      navigation.back();
      expect(navigation.getState().routes).toEqual(navigation.underlyingRoutes);
    },
  );

  it.each([true, false])(
    "removes the complete project flow when no draft exists (chooser: %s)",
    async (withChooser) => {
      const { created, projected, submit } = setup();
      const navigation = mountProjectFlow(false, withChooser);

      const submission = submit();
      created.resolve(AsyncResult.success(undefined));
      projected.resolve({ environmentId: "environment", id: "project" });
      await submission;

      expect(navigation.getState().routes.at(-1)?.params).toMatchObject({
        draft: { environmentId: "environment", projectId: "project" },
      });
      navigation.back();
      expect(navigation.getState().routes).toEqual([navigation.home]);
    },
  );
});
