import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
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
  createResult: null as Promise<unknown> | null,
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
  useProjects: () => [],
  waitForProject: state.waitForProject,
  useServerConfigs: () =>
    new Map([
      [
        "environment",
        {
          environment: { platform: { os: "linux" }, capabilities: {} },
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
      connectionState: "connected",
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
    cloneRepository: async ({ input }: { input: { destinationPath: string } }) => {
      NodeFS.mkdirSync(input.destinationPath);
      return AsyncResult.success({ cwd: input.destinationPath });
    },
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
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

import {
  AddProjectDestinationScreen,
  AddProjectLocalFolderScreen,
  AddProjectSourceScreen,
} from "./AddProjectScreen";
import { AddProjectSourceRoute } from "./AddProjectSourceRoute";

function findAction(node: ReactNode, label: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const action = findAction(child, label);
      if (action) return action;
    }
    return null;
  }
  if (
    !isValidElement<{
      label?: string;
      title?: string;
      onPress?: () => unknown;
      children?: ReactNode;
    }>(node)
  ) {
    return null;
  }
  if ((node.props.label ?? node.props.title) === label) return node.props.onPress ?? null;
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

  function mountProjectFlow(withDraft: boolean, withChooser = true, withPullRequest = false) {
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
    for (const name of [
      ...(withChooser ? ["NewTaskProject"] : []),
      "AddProject",
      "AddProjectLocal",
    ]) {
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
    };
  }

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
